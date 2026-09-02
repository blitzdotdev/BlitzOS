/**
 * The Lody workspace runtime, assembled for a BlitzOS box
 * (plans/LODY-RUNTIME-DESIGN.md §1.1, §2, §3).
 *
 * `createWorkspaceRuntime` takes no platform object. It takes `syncMode`, and
 * everything else about "which plane" follows from that:
 *
 * - `syncMode: 'local'` sets `cloudPlaneEnabled = false`
 *   (`create-workspace-runtime.ts:445`): no Streams member, no token provider,
 *   no cloud presence, no cloud RPC. Zero cloud I/O is a construction property,
 *   not a configuration one.
 * - It also makes `WorkspaceTargetRouter.getPlaneForMachine` answer `'local'`
 *   for every machine immediately (`workspace-target-router.ts:174`), with no
 *   machine-meta probe and no identity wait. That answers design-doc risk 3:
 *   `useVisibleMachineMetas` returning nothing cannot strand the box, because
 *   nothing consults it on this path.
 * - And it makes the local data plane MANDATORY: boot attaches it and THROWS
 *   `local_loro_data_plane_bridge_unavailable` if the injected bridge is
 *   missing. The bridge is captured before runtime creation; installing the
 *   compatibility global is optional for headless callers.
 *
 * `apiBaseUrl` is required by the type but unreachable in this mode — every
 * caller of it sits behind `cloudPlaneEnabled`. It is set to the loopback
 * address that refuses connections rather than to a real origin, so a future
 * upstream call site that escapes the gate fails loudly instead of reaching a
 * BlitzOS API by accident.
 */
import type { JsonObject, JsonValue } from "@blitzos/schema";
import { createStore } from "jotai";
import { createWorkspaceRuntime } from "@lody/components/providers/create-workspace-runtime";
import { createBoundIpcClient } from "@lody/components/lib/electron-ipc-client";
import { runtimeAtom } from "@lody/components/atoms/runtime";
import { setWorkspaceContextAtom } from "@lody/components/atoms/workspace-context";
import {
  createLodyLocalBridge,
  installLodyLocalBridge,
  type LodyLocalBridge,
  type LodyLocalBridgeEndpoints,
} from "./local-bridge.js";
import type { LodyHttpPlaneEndpoints } from "./rpc-client.js";
import type { LodyPlatformSnapshot } from "./platform-snapshot.js";
import {
  applyDefaultSessionProject,
  createSessionProjectDefaults,
} from "./workdir-default.js";
import type { LodySessionDocState } from "./wire-types.js";

/** Unreachable by construction; see the module comment. */
const NO_CLOUD_API_BASE_URL = "http://127.0.0.1:1";

export interface LodyRuntimeEndpoints {
  syncUrl: string;
  rpcUrl: string;
  controlUrl: string;
  projectUrl: string;
  platformUrl: string;
  /** `BoxEndpoints.filesBase` — the dufs WebDAV base `+` attachments stage
   * through (`session-attachments.ts`). */
  filesBase: string;
  /** The box path `filesBase` serves. Defaults to the resolver's `/workspace`;
   * a test that stands dufs up elsewhere moves both together. */
  filesRoot?: string;
  fetchImpl?: typeof fetch;
  webSocketConstructor?: typeof WebSocket;
}

export interface LodyRuntimeHandle {
  /** The vendored `WorkspaceRuntime`, seen through the narrow contract below.
   * `vendor-modules.d.ts` keeps the vendor tree out of our typecheck on purpose,
   * so the shape is stated on this side rather than imported. */
  runtime: LodyWorkspaceRuntime;
  bridge: LodyLocalBridge;
  /** Tears down the runtime, the bridge and any compatibility globals, in that
   * order. */
  dispose: () => Promise<void>;
}

/** The slice of the vendored runtime this package actually calls. Hand-written
 * because the vendor seam is untyped; every member here is checked against
 * `vendor/lody/packages/components/src/atoms/runtime.ts`. */
export interface LodyDispatchArgs {
  sessionId: string;
  userTurnId: string;
  userId: string;
  timestamp: string;
  inputConfig: JsonObject;
}

/** The renderer's authored-write seam
 * (`vendor/lody/packages/components/src/providers/workspace-writer.ts:12`). */
export interface LodyWorkspaceWriter {
  startSession(
    sessionId: string,
    meta: JsonObject,
    entry: JsonObject,
    dispatch: LodyDispatchArgs,
  ): Promise<void>;
  /** The same accept unit for a session that already exists: one more user turn
   * and the dispatch pointer that goes with it (`workspace-writer.ts:55`). It is
   * what the composer's second message is, and what a headless caller needs to
   * put two turns on one session. */
  appendSessionTurn(
    sessionId: string,
    entry: JsonObject,
    dispatch: LodyDispatchArgs,
  ): Promise<void>;
  /**
   * The session or machine room's doc meta.
   *
   * The patch is `JsonValue | undefined` and not `JsonObject` because
   * `undefined` is loro-repo's own DELETE: `metadataManager.upsert` removes the
   * key from the CRDT when a patch value is `undefined`, and stores `null` when
   * it is null. Clearing a field and setting it to null are different states to
   * every reader of `SessionMeta`, so the seam has to be able to say which one.
   */
  upsertDocMeta(roomId: string, patch: Record<string, JsonValue | undefined>): Promise<void>;
  flockRowPut(flockDocId: string, key: readonly string[], value: JsonValue): Promise<void>;
  /** Inserts a Flock row only when its key is absent, in ONE transaction.
   * `workspace-writer.ts:38`. The transaction is the whole point: a check
   * followed by a put is two operations and a concurrent CLI write lands
   * between them. */
  flockRowPutIfAbsent(
    flockDocId: string,
    key: readonly string[],
    value: JsonValue,
  ): Promise<{ inserted: boolean; value: JsonValue }>;
}

/**
 * Their `Flock` document body, opaque on our side.
 *
 * It is never inspected here — it goes straight back to
 * `readMachineFlockRowsFromFlock`, whose parser is theirs. A nominal type rather
 * than `unknown` so it cannot be confused with any other value that crosses the
 * seam, and so no exported signature in this package carries `unknown`.
 */
export interface LodyFlockBody {
  readonly __lodyFlock: unique symbol;
}

/** One open Flock document. `syncOnce` resolves when the room has exchanged
 * state with its peers once — which, on the local plane, means the daemon's
 * rows have arrived. */
export interface LodyFlockDocHandle {
  readonly flock: LodyFlockBody;
  syncOnce(): Promise<void>;
}

/**
 * What `repo.getDocMeta` answers (`loro-repo`'s `RepoDocSnapshot`): the room's
 * meta fields and whether the document is deleted. For a session room the meta
 * IS Lody's `SessionMeta` — `acpSessionId`, `status`, `latestUserMsgId` and the
 * rest — which is why it is worth naming on this side.
 */
export interface LodyDocMetaSnapshot {
  readonly meta: JsonObject;
  readonly deleted: boolean;
}

/** The slice of the runtime's `LoroRepo` this package calls. */
export interface LodyLoroRepo {
  openFlockDoc(flockDocId: string): Promise<LodyFlockDocHandle>;
  /** One room's doc meta, or `undefined` for a room the repo has never seen. */
  getDocMeta(roomId: string): Promise<LodyDocMetaSnapshot | undefined>;
}

/** The mirrored session document store `withSessionStore` hands to its callback. */
export interface LodySessionStore {
  getState(): LodySessionDocState;
}

export interface LodyWorkspaceRuntime {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly writer: LodyWorkspaceWriter;
  readonly repo: LodyLoroRepo;
  setLocalMachineId(machineId: string | null): void;
  resolveMachineTargetPlane(machineId: string, options?: { timeoutMs?: number }): Promise<"local" | "cloud">;
  requestSessionDispatchTurn(
    machineId: string,
    args: LodyDispatchArgs,
    options?: { timeoutMs?: number },
  ): Promise<JsonValue>;
  ensureDocStream(roomId: string): Promise<void>;
  /** `create-workspace-runtime.ts:4565`. Asks the machine to launch an agent
   * config's ACP adapter and report its modes, models and effort levels, which
   * the daemon then writes into the machine Flock as `acpCapability` rows.
   * `null` means no plane answered. */
  requestMachineAcpCapabilitiesRefresh(
    request: JsonObject,
    options?: { signal?: AbortSignal },
  ): Promise<{ success?: boolean; error?: string } | null>;
  withSessionStore<T>(sessionId: string, fn: (store: LodySessionStore) => T | Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

/**
 * Installs the bridge, then builds the runtime on top of it.
 *
 * `setLocalMachineId` is called with the daemon's own machineId even though
 * local-only mode does not need it to route: it is what makes the router's
 * `rememberSessionTarget` bookkeeping name the right machine, and it costs one
 * call. The id comes from `/lody/platform` (design-doc risk 4) — the browser
 * cannot mint it, and the agent-config bootstrap keys rows by it.
 */
export async function createLodyRuntime(options: {
  endpoints: LodyRuntimeEndpoints;
  snapshot: LodyPlatformSnapshot;
  /** Set `false` in a test that wants the bridge without touching `window`. */
  installGlobals?: boolean;
}): Promise<LodyRuntimeHandle> {
  const { endpoints, snapshot } = options;
  const bridgeEndpoints: LodyLocalBridgeEndpoints = {
    syncUrl: endpoints.syncUrl,
    rpcUrl: endpoints.rpcUrl,
    controlUrl: endpoints.controlUrl,
    projectUrl: endpoints.projectUrl,
    platformUrl: endpoints.platformUrl,
    filesBase: endpoints.filesBase,
  };
  if (endpoints.filesRoot !== undefined) bridgeEndpoints.filesRoot = endpoints.filesRoot;
  if (endpoints.fetchImpl !== undefined) bridgeEndpoints.fetchImpl = endpoints.fetchImpl;
  if (endpoints.webSocketConstructor !== undefined) {
    bridgeEndpoints.webSocketConstructor = endpoints.webSocketConstructor;
  }
  const bridge = createLodyLocalBridge(bridgeEndpoints);
  const ipcClient = createBoundIpcClient(bridge.ipc);
  const uninstall = options.installGlobals === false ? () => bridge.dispose() : installLodyLocalBridge(bridge);

  let runtime: LodyWorkspaceRuntime;
  try {
    // SAFETY: `createWorkspaceRuntime` is untyped across the vendor seam
    // (`vendor-modules.d.ts`). Every member of `LodyWorkspaceRuntime` is checked
    // by hand against `vendor/lody/packages/components/src/atoms/runtime.ts`, and
    // the phase-2 exit test calls each of them against a real daemon.
    runtime = (await createWorkspaceRuntime({
      workspaceSlug: snapshot.workspace.slug ?? "local",
      workspaceId: snapshot.workspace.workspaceId,
      apiBaseUrl: NO_CLOUD_API_BASE_URL,
      syncMode: "local",
      eagerSyncSurface: "web",
      ipcClient,
    })) as LodyWorkspaceRuntime;
  } catch (cause) {
    uninstall();
    throw cause;
  }
  runtime.setLocalMachineId(snapshot.machineId);

  // A session started with no repo picked would otherwise run in the daemon's
  // chat-storage directory rather than in the box's workspace, which is what
  // makes a relative file chip open on nothing. `workdir-default.ts` states the
  // whole chain.
  //
  // Applied HERE for a caller that builds its own runtime — the exit tests, and
  // any headless driver. The product surface does not come through this
  // function: `RuntimeProvider` creates the runtime and writes `runtimeAtom`
  // itself, so `LodyAgentConfigGate` applies the same decorator to the atom's
  // value. Both go through `applyDefaultSessionProject`, which is idempotent,
  // so a runtime that passed one never pays for the other.
  //
  // The registration is LAZY, not warmed here. Warming it would put the one
  // request that can be refused — a daemon that has not provisioned its
  // implicit workspace yet answers `workspace_not_found` — in flight at the
  // earliest possible moment, and a send that arrived while that refusal was
  // still open would share it and land in the chats directory: the exact bug.
  // Deferred to the first session write, the daemon has already answered the
  // agent-config gate, so the call is made when it can succeed.
  const planeEndpoints: LodyHttpPlaneEndpoints = {
    rpcUrl: endpoints.rpcUrl,
    controlUrl: endpoints.controlUrl,
    projectUrl: endpoints.projectUrl,
    platformUrl: endpoints.platformUrl,
  };
  if (endpoints.fetchImpl !== undefined) planeEndpoints.fetchImpl = endpoints.fetchImpl;
  const sessionProjectDefaults = createSessionProjectDefaults(
    planeEndpoints,
    snapshot.machineId,
    endpoints.filesRoot,
  );
  // `dispose` below still runs on the original, which is the object holding the
  // repo and the transports.
  const runtimeWithDefaults = applyDefaultSessionProject(runtime, sessionProjectDefaults);

  return {
    runtime: runtimeWithDefaults,
    bridge,
    dispose: async () => {
      await runtime.dispose();
      uninstall();
    },
  };
}

/** The jotai store the vendored atoms are read and written in.
 *
 * Jotai's own store type, not a hand-written narrowing: the atoms crossing this
 * seam are `any` (see `vendor-modules.d.ts`), and a narrower local interface
 * would only fail to accept the real `createStore()` result. */
export type LodyAtomStore = ReturnType<typeof createStore>;

/**
 * Publishes the runtime into the atoms every vendored hook reads.
 *
 * `activeWorkspaceRuntimeAtom` (`atoms/runtime.ts:515`) is derived, and it
 * answers `null` unless the runtime AND the workspace context agree
 * (`resolveActiveWorkspaceRuntimeState`, `:470`): a slug mismatch resolves to
 * `stale`, not `ready`, and every command atom then throws `Runtime not ready`.
 * So both are set here, in that order.
 *
 * The context goes through `setWorkspaceContextAtom` as ONE call
 * (`atoms/workspace-context.ts:21`). Never set `currentWorkspaceIdAtom` and
 * `currentWorkspaceSlugAtom` separately — those compatibility setters clear each
 * other, so the second would erase the first.
 */
export function mountLodyRuntimeAtoms(store: LodyAtomStore, runtime: LodyWorkspaceRuntime): void {
  store.set(runtimeAtom, runtime);
  store.set(setWorkspaceContextAtom, {
    slug: runtime.workspaceSlug,
    workspaceId: runtime.workspaceId,
  });
}

/** Drops the runtime from the atoms. Call before `dispose`, so nothing reads a
 * runtime whose repo is closing. */
export function unmountLodyRuntimeAtoms(store: LodyAtomStore): void {
  store.set(runtimeAtom, null);
}
