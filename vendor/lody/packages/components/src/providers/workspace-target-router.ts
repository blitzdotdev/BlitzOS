import type { LoroRepo } from 'loro-repo';
import {
  AGENT_CONFIG_DOC_PREFIX,
  getSessionIdFromRoomId,
  LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT,
  MACHINE_DOC_PREFIX,
  PREVIEW_COMMENT_DOC_PREFIX,
  SESSION_DOC_PREFIX,
  parseMachineFlockDocId,
  type MachineId,
  type SessionId,
} from '@lody/shared';
import type { PlatformSyncMode } from '@lody/platform';
export type WorkspaceTargetPlane = 'local' | 'cloud';

/** Matches loro-repo's `RepoRoomDescriptor` shape for `resolveRoomTransports`. */
export type WorkspaceTransportRoom = {
  readonly kind: 'meta' | 'doc' | 'flock-doc';
  readonly id: string;
};

/** Matches loro-repo's `RepoRoomRoute` shape. */
export type WorkspaceTransportRoute = {
  readonly transportIds: ReadonlyArray<string>;
};

type WorkspaceTargetRouterDeps = {
  readonly repo: Pick<LoroRepo, 'getDocMeta'>;
  /**
   * `cloud`: every room mounts pure cloud (Web-isomorphic). `dual`: local
   * rooms dual-home local-primary. `local`: every room mounts only the local
   * plane — zero cloud members regardless of ownership (open-source platform).
   */
  readonly syncMode: PlatformSyncMode;
  readonly onRouteChange?: () => void;
};

const TARGET_IDENTITY_WAIT_TIMEOUT_MS = 5_000;

function sessionIdFromDocRoomId(roomId: string): SessionId | null {
  const sessionId = getSessionIdFromRoomId(roomId);
  if (sessionId) return sessionId;
  if (roomId.startsWith(PREVIEW_COMMENT_DOC_PREFIX)) {
    return roomId.slice(PREVIEW_COMMENT_DOC_PREFIX.length) as SessionId;
  }
  return null;
}

function sessionIdFromFlockDocId(flockDocId: string): SessionId | null {
  const parts = flockDocId.split(':');
  if (parts.length === 3 && parts[1] === LORO_CODE_COLLAB_FILE_INDEX_STREAM_SEGMENT && parts[2]) {
    return parts[2] as SessionId;
  }
  return null;
}

function machineIdFromDocRoomId(roomId: string): MachineId | null {
  if (!roomId.startsWith(MACHINE_DOC_PREFIX)) {
    return null;
  }
  const machineId = roomId.slice(MACHINE_DOC_PREFIX.length);
  return machineId ? (machineId as MachineId) : null;
}

function machineIdFromMeta(meta: unknown): MachineId | null {
  if (typeof meta !== 'object' || meta === null) {
    return null;
  }
  const machineId = (meta as { readonly machineId?: unknown }).machineId;
  return typeof machineId === 'string' && machineId.length > 0 ? (machineId as MachineId) : null;
}

function assertImmutableTarget(
  targetKind: 'session' | 'doc',
  targetId: string,
  existingMachineId: MachineId | undefined,
  nextMachineId: MachineId
): void {
  if (existingMachineId && existingMachineId !== nextMachineId) {
    throw new Error(
      `workspace_target_conflict: ${targetKind} ${targetId} is owned by ` +
        `${existingMachineId}, not ${nextMachineId}`
    );
  }
}

/**
 * Owns the immutable machine association used by durable-room transport routing
 * and Machine RPC plane selection. Rooms with unknown ownership mount pure
 * cloud (Web-isomorphic) until ownership resolves; RPC plane resolution still
 * waits for local machine identity instead of guessing.
 */
export class WorkspaceTargetRouter {
  private readonly repo: WorkspaceTargetRouterDeps['repo'];
  private readonly localFirst: boolean;
  private readonly localOnly: boolean;
  private readonly onRouteChange?: () => void;
  private readonly machineBySessionId = new Map<SessionId, MachineId>();
  private readonly machineByDocRoomId = new Map<string, MachineId>();
  private localMachineId: MachineId | null = null;
  private localMachineIdentityKnown: boolean;
  private readonly identityWaiters = new Set<() => void>();

  constructor(deps: WorkspaceTargetRouterDeps) {
    this.repo = deps.repo;
    this.localFirst = deps.syncMode !== 'cloud';
    this.localOnly = deps.syncMode === 'local';
    this.onRouteChange = deps.onRouteChange;
    this.localMachineIdentityKnown = !this.localFirst;
  }

  setLocalMachineId(machineId: MachineId | null): void {
    const changed = !this.localMachineIdentityKnown || this.localMachineId !== machineId;
    this.localMachineId = machineId;
    this.localMachineIdentityKnown = true;
    for (const resolve of this.identityWaiters) {
      resolve();
    }
    this.identityWaiters.clear();
    if (changed) {
      this.onRouteChange?.();
    }
  }

  observeDocMeta(roomId: string, meta: unknown): void {
    const machineId = machineIdFromMeta(meta);
    if (!machineId) {
      return;
    }
    const sessionId = sessionIdFromDocRoomId(roomId);
    try {
      this.assertDocTargetOwnership(roomId, machineId);
      let changed = false;
      if (sessionId && !this.machineBySessionId.has(sessionId)) {
        this.machineBySessionId.set(sessionId, machineId);
        changed = true;
      }
      if (!this.machineByDocRoomId.has(roomId)) {
        this.machineByDocRoomId.set(roomId, machineId);
        changed = true;
      }
      if (changed) {
        this.onRouteChange?.();
      }
    } catch (error) {
      // Repo watch callbacks are observational. Keep the first immutable owner
      // and surface corrupt/conflicting metadata without flipping live routes.
      console.error('WorkspaceTargetRouter: ignored conflicting target ownership', {
        roomId,
        machineId,
        error,
      });
    }
  }

  rememberSessionTarget(sessionId: SessionId, machineId: MachineId): void {
    const roomId = `${SESSION_DOC_PREFIX}${sessionId}`;
    const existingSessionMachineId = this.machineBySessionId.get(sessionId);
    const existingDocMachineId = this.machineByDocRoomId.get(roomId);
    assertImmutableTarget('session', sessionId, existingSessionMachineId, machineId);
    assertImmutableTarget('doc', roomId, existingDocMachineId, machineId);
    if (existingSessionMachineId === machineId && existingDocMachineId === machineId) {
      return;
    }
    this.machineBySessionId.set(sessionId, machineId);
    this.machineByDocRoomId.set(roomId, machineId);
    this.onRouteChange?.();
  }

  getPlaneForMachine(machineId: MachineId): WorkspaceTargetPlane | null {
    // Local-only platform: no cloud plane exists, so every machine — and
    // therefore every room and RPC — resolves local without waiting for
    // identity.
    if (this.localOnly) {
      return 'local';
    }
    if (!this.localFirst) {
      return 'cloud';
    }
    if (!this.localMachineIdentityKnown) {
      return null;
    }
    return this.localMachineId !== null && machineId === this.localMachineId ? 'local' : 'cloud';
  }

  async resolvePlaneForMachine(
    machineId: MachineId,
    options: { timeoutMs?: number } = {}
  ): Promise<WorkspaceTargetPlane> {
    if (this.localOnly) {
      return 'local';
    }
    if (!this.localFirst) {
      return 'cloud';
    }
    await this.waitForLocalMachineIdentity(options.timeoutMs);
    const plane = this.getPlaneForMachine(machineId);
    if (!plane) {
      throw new Error(`workspace_target_pending: machine ${machineId}`);
    }
    return plane;
  }

  getPlaneForSession(sessionId: SessionId): WorkspaceTargetPlane | null {
    const machineId = this.machineBySessionId.get(sessionId);
    return machineId ? this.getPlaneForMachine(machineId) : null;
  }

  getPlaneForDocRoom(roomId: string): WorkspaceTargetPlane | null {
    if (this.localOnly) {
      return 'local';
    }
    const machineId = machineIdFromDocRoomId(roomId);
    if (machineId) {
      return this.getPlaneForMachine(machineId);
    }
    const sessionId = sessionIdFromDocRoomId(roomId);
    if (sessionId) {
      return this.getPlaneForSession(sessionId);
    }
    const ownerMachineId = this.machineByDocRoomId.get(roomId);
    if (ownerMachineId) {
      return this.getPlaneForMachine(ownerMachineId);
    }
    // Workspace-scoped docs without a machine owner retain Web/cloud semantics.
    return roomId.startsWith(AGENT_CONFIG_DOC_PREFIX) ? null : 'cloud';
  }

  getPlaneForFlockDoc(flockDocId: string): WorkspaceTargetPlane | null {
    if (this.localOnly) {
      return 'local';
    }
    const machineFlock = parseMachineFlockDocId(flockDocId);
    if (machineFlock) {
      return this.getPlaneForMachine(machineFlock.machineId);
    }
    const sessionId = sessionIdFromFlockDocId(flockDocId);
    if (sessionId) {
      return this.getPlaneForSession(sessionId);
    }
    return 'cloud';
  }

  resolveTransportRoute(room: WorkspaceTransportRoom): WorkspaceTransportRoute {
    // Local-only platform: every room — including workspace-scoped rooms like
    // the task index that dual mode leaves on cloud — mounts only the local
    // member (specs/platform-providers.md).
    if (this.localOnly) {
      return { transportIds: ['local'] };
    }
    if (!this.localFirst) {
      return { transportIds: ['cloud'] };
    }
    if (room.kind === 'meta') {
      return { transportIds: ['local', 'cloud'] };
    }
    const plane =
      room.kind === 'doc' ? this.getPlaneForDocRoom(room.id) : this.getPlaneForFlockDoc(room.id);
    if (plane === 'local') {
      // Dual-author: local rooms dual-home like meta. The local plane is the
      // offline-capable readiness owner; the cloud transport converges
      // renderer-authored ops best-effort (specs/local-first-two-plane.md 房间路由).
      return { transportIds: ['local', 'cloud'] };
    }
    // Known-remote rooms and rooms whose owner is still unknown mount pure
    // cloud (Web-isomorphic). Mounting the "wrong" plane only costs redundant
    // delivery — ownership resolution refreshes routes and adds the local
    // transport (specs/local-first-two-plane.md 房间路由).
    return { transportIds: ['cloud'] };
  }

  /**
   * The transport whose per-room subscription drives UI readiness/health for
   * this room — the selection that replaced the mux's lossy primary-status
   * projection. Dual-homed local rooms read the offline-capable local plane;
   * everything else reads cloud. Repair loops deliberately do NOT use this:
   * they enumerate each plane's own subscriptions.
   */
  getReadinessTransportForRoom(room: WorkspaceTransportRoom): WorkspaceTargetPlane {
    return this.resolveTransportRoute(room).transportIds.includes('local') ? 'local' : 'cloud';
  }

  async prepareSessionTarget(
    sessionId: SessionId,
    assertedMachineId?: MachineId | null
  ): Promise<WorkspaceTargetPlane> {
    if (this.localOnly) {
      return 'local';
    }
    if (!this.localFirst) {
      return 'cloud';
    }
    if (assertedMachineId) {
      this.rememberSessionTarget(sessionId, assertedMachineId);
    } else if (!this.machineBySessionId.has(sessionId)) {
      const entry = await this.repo.getDocMeta(`${SESSION_DOC_PREFIX}${sessionId}`);
      this.observeDocMeta(`${SESSION_DOC_PREFIX}${sessionId}`, entry?.meta);
    }
    const machineId = this.machineBySessionId.get(sessionId);
    if (!machineId) {
      throw new Error(`workspace_target_unknown: session ${sessionId} has no owning machine`);
    }
    return await this.resolvePlaneForMachine(machineId);
  }

  async prepareDocTarget(
    roomId: string,
    patch?: Record<string, unknown>
  ): Promise<WorkspaceTargetPlane> {
    if (this.localOnly) {
      // Ownership observation still runs in dual/cloud; local-only rooms are
      // local regardless of owner, so skip the meta lookup entirely.
      return 'local';
    }
    if (!this.localFirst) {
      return 'cloud';
    }
    if (patch) {
      const assertedMachineId = machineIdFromMeta(patch);
      if (assertedMachineId) {
        this.assertDocTargetOwnership(roomId, assertedMachineId);
      }
      this.observeDocMeta(roomId, patch);
    }
    let plane = this.getPlaneForDocRoom(roomId);
    if (plane) {
      return plane;
    }
    const entry = await this.repo.getDocMeta(roomId);
    this.observeDocMeta(roomId, entry?.meta);
    plane = this.getPlaneForDocRoom(roomId);
    if (plane) {
      return plane;
    }
    await this.waitForLocalMachineIdentity();
    if (roomId.startsWith(AGENT_CONFIG_DOC_PREFIX)) {
      // Pre-machine-association agent config rows are workspace-scoped legacy
      // metadata. Preserve Electron's former intent authorship so their one-shot
      // migration remains offline-capable; a workspace with no local machine is
      // already pure-cloud for target-owned data.
      return this.localMachineId ? 'local' : 'cloud';
    }
    plane = this.getPlaneForDocRoom(roomId);
    if (!plane) {
      throw new Error(`workspace_target_unknown: doc ${roomId} has no owning machine`);
    }
    return plane;
  }

  private async waitForLocalMachineIdentity(
    timeoutMs = TARGET_IDENTITY_WAIT_TIMEOUT_MS
  ): Promise<void> {
    if (this.localMachineIdentityKnown) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveWait: (() => void) | null = null;
    await new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      this.identityWaiters.add(resolve);
      timer = setTimeout(() => {
        this.identityWaiters.delete(resolve);
        reject(new Error('workspace_target_identity_timeout'));
      }, timeoutMs);
    }).finally(() => {
      if (resolveWait) {
        this.identityWaiters.delete(resolveWait);
      }
      if (timer) {
        clearTimeout(timer);
      }
    });
  }

  private assertDocTargetOwnership(roomId: string, machineId: MachineId): void {
    const sessionId = sessionIdFromDocRoomId(roomId);
    if (sessionId) {
      assertImmutableTarget(
        'session',
        sessionId,
        this.machineBySessionId.get(sessionId),
        machineId
      );
    }
    assertImmutableTarget('doc', roomId, this.machineByDocRoomId.get(roomId), machineId);
  }
}
