import {
  createLocalPlatformProvider,
  createStore,
  createStaticStore,
  type MutableStore,
  type PlatformProvider,
  type PlatformSessionState,
  type ReadonlyStore,
  type WorkspaceSummary,
  type WorkspacesState,
} from '@lody/platform';
import { useStoreValue } from '@lody/platform/react';
import { isLocalAppPlatform } from '@/lib/app-platform';
import { getIpcServices } from '@/lib/electron-ipc-client';

/**
 * Renderer-side assembly of the open-source local `PlatformProvider`
 * (specs/platform-providers.md). The CLI provisions the single implicit
 * workspace (D-O14) and the Electron main process surfaces it over
 * `getIpcServices()?.localPlatform.getSnapshot()`; this module polls that bridge until
 * the CLI publishes one atomic identity/workspace snapshot. Both provider
 * stores transition together so renderer writes and CLI access checks use the
 * same durable synthetic installation identity.
 */

/** Fallback slug for workspace routes while the implicit workspace has none. */
export const LOCAL_WORKSPACE_FALLBACK_SLUG = 'local';

const IMPLICIT_WORKSPACE_POLL_INTERVAL_MS = 500;

let cachedProvider: PlatformProvider | null = null;
let cachedSessionStore: MutableStore<PlatformSessionState> | null = null;
let cachedWorkspacesStore: MutableStore<WorkspacesState> | null = null;
let snapshotPollingStarted = false;
// BLITZ SEAM PATCH 17: the running poll interval, promoted to module scope so
// `resetLocalPlatformSnapshotState()` can stop it. Upstream keeps it local to
// `startLocalPlatformSnapshotPolling` because Electron has exactly one local
// daemon per renderer; a browser host that talks to many boxes needs to re-poll
// against the next box's bridge. See BLITZ-PATCHES.md §17.
let snapshotPollInterval: ReturnType<typeof setInterval> | null = null;

const CLOUD_WORKSPACES_STORE: ReadonlyStore<WorkspacesState> = createStaticStore({
  status: 'loading',
} as WorkspacesState);

function startLocalPlatformSnapshotPolling(
  sessionStore: MutableStore<PlatformSessionState>,
  workspacesStore: MutableStore<WorkspacesState>
): void {
  let inFlight = false;
  let settled = false;
  const poll = async (): Promise<void> => {
    if (inFlight || settled) {
      return;
    }
    inFlight = true;
    try {
      const snapshot = await getIpcServices()?.localPlatform.getSnapshot();
      if (!snapshot) {
        return;
      }
      const workspace = snapshot.workspace;
      const summary: WorkspaceSummary = {
        id: workspace.workspaceId,
        name: workspace.name,
        slug: workspace.slug,
        role: workspace.role,
      };
      sessionStore.set({
        status: 'authenticated',
        user: { id: snapshot.userId, name: 'Local' },
      });
      workspacesStore.set({
        status: 'ready',
        workspaces: [summary],
        activeWorkspaceId: summary.id,
      });
      settled = true;
      if (snapshotPollInterval !== null) {
        clearInterval(snapshotPollInterval);
        snapshotPollInterval = null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workspacesStore.set({ status: 'error', message });
      settled = true;
      if (snapshotPollInterval !== null) {
        clearInterval(snapshotPollInterval);
        snapshotPollInterval = null;
      }
      console.error('local-platform: bootstrap snapshot failed', error);
    } finally {
      inFlight = false;
    }
  };
  snapshotPollInterval = setInterval(() => {
    void poll();
  }, IMPLICIT_WORKSPACE_POLL_INTERVAL_MS);
  void poll();
}

function getLocalWorkspacesStore(): MutableStore<WorkspacesState> {
  if (!cachedWorkspacesStore) {
    cachedWorkspacesStore = createStore<WorkspacesState>({ status: 'loading' });
  }
  return cachedWorkspacesStore;
}

function getLocalSessionStore(): MutableStore<PlatformSessionState> {
  if (!cachedSessionStore) {
    cachedSessionStore = createStore<PlatformSessionState>({ status: 'loading' });
  }
  return cachedSessionStore;
}

function ensureLocalPlatformSnapshotPolling(): void {
  if (snapshotPollingStarted) return;
  snapshotPollingStarted = true;
  const sessionStore = getLocalSessionStore();
  const workspacesStore = getLocalWorkspacesStore();
  startLocalPlatformSnapshotPolling(sessionStore, workspacesStore);
}

/**
 * BLITZ SEAM PATCH 17: forget the cached local identity and stop the poll, so
 * the next `getLocalPlatformProvider()` / `useLocalPlatformWorkspacesState()`
 * re-polls `localPlatform.getSnapshot` against whatever bridge is installed now.
 *
 * WHY THIS EXISTS. Upstream assumes one local daemon per renderer (Electron),
 * so `snapshotPollingStarted` and the cached stores are page-lifetime state that
 * settles once and never reads again. BlitzOS mounts one surface per box in a
 * single browser tab, so a workspace switch must re-read the snapshot from the
 * new box's `window.ipc`; without a reset the runtime pins to the FIRST box's
 * workspace id, opens that box's replica, subscribes to its rooms while dialling
 * a different daemon, and the session list is empty until a full page reload.
 *
 * Called from the incoming surface's render, before its `RuntimeProvider` reads
 * `useImplicitLocalWorkspace` (see `packages/webapp/src/lody/SessionSurface.tsx`).
 * Any snapshot read still in flight resolves into the detached old stores, which
 * nothing subscribes to after this returns. See BLITZ-PATCHES.md §17.
 *
 * Candidate upstream PR: key the local-platform snapshot by the installed IPC
 * bridge (or expose this reset) so a host driving more than one daemon can move
 * between them.
 */
export function resetLocalPlatformSnapshotState(): void {
  if (snapshotPollInterval !== null) {
    clearInterval(snapshotPollInterval);
    snapshotPollInterval = null;
  }
  cachedProvider = null;
  cachedSessionStore = null;
  cachedWorkspacesStore = null;
  snapshotPollingStarted = false;
}

/**
 * The one local `PlatformProvider` instance of this renderer. Only call on the
 * local platform (root route mounts `PlatformContext` behind
 * `isLocalAppPlatform()`); the first call starts the implicit-workspace poll.
 */
export function getLocalPlatformProvider(): PlatformProvider {
  if (!cachedProvider) {
    const sessionStore = getLocalSessionStore();
    const workspacesStore = getLocalWorkspacesStore();
    cachedProvider = createLocalPlatformProvider({
      session: sessionStore,
      workspaces: workspacesStore,
    });
    ensureLocalPlatformSnapshotPolling();
  }
  return cachedProvider;
}

/**
 * The implicit local workspace, or null while the CLI has not provisioned it
 * (and always null on the cloud platform, without starting any polling).
 * Usable outside `PlatformContext` — the runtime provider mounts above the
 * route tree that provides the context.
 */
export function useImplicitLocalWorkspace(): WorkspaceSummary | null {
  const state = useLocalPlatformWorkspacesState();
  return state.status === 'ready' ? (state.workspaces[0] ?? null) : null;
}

/** Bootstrap state for route-level loading/error handling. */
export function useLocalPlatformWorkspacesState(): WorkspacesState {
  if (isLocalAppPlatform()) {
    ensureLocalPlatformSnapshotPolling();
  }
  const store = isLocalAppPlatform() ? getLocalWorkspacesStore() : CLOUD_WORKSPACES_STORE;
  return useStoreValue(store);
}

/** Route slug of the implicit local workspace. */
export function getLocalWorkspaceSlug(workspace: WorkspaceSummary): string {
  return workspace.slug ?? LOCAL_WORKSPACE_FALLBACK_SLUG;
}
