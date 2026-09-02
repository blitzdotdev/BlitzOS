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
import { getIpcServices, windowIpcClient, type LodyIpcClient } from '@/lib/electron-ipc-client';
import { useIpcClient } from './ipc-client-provider';

/**
 * Renderer-side assembly of the open-source local `PlatformProvider`
 * (specs/platform-providers.md). Electron has one default IPC client and keeps
 * its page-lifetime provider. An embedding host may supply one bound client per
 * renderer subtree; each client then owns an independent snapshot and stores.
 */

/** Fallback slug for workspace routes while the implicit workspace has none. */
export const LOCAL_WORKSPACE_FALLBACK_SLUG = 'local';

const IMPLICIT_WORKSPACE_POLL_INTERVAL_MS = 500;

type LocalPlatformClientState = {
  provider: PlatformProvider | null;
  sessionStore: MutableStore<PlatformSessionState> | null;
  workspacesStore: MutableStore<WorkspacesState> | null;
  pollingStarted: boolean;
  pollInterval: ReturnType<typeof setInterval> | null;
};

const LOCAL_PLATFORM_STATE_BY_CLIENT = new WeakMap<LodyIpcClient, LocalPlatformClientState>();

function getLocalPlatformClientState(ipcClient: LodyIpcClient): LocalPlatformClientState {
  const existing = LOCAL_PLATFORM_STATE_BY_CLIENT.get(ipcClient);
  if (existing) return existing;
  const created: LocalPlatformClientState = {
    provider: null,
    sessionStore: null,
    workspacesStore: null,
    pollingStarted: false,
    pollInterval: null,
  };
  LOCAL_PLATFORM_STATE_BY_CLIENT.set(ipcClient, created);
  return created;
}

const CLOUD_WORKSPACES_STORE: ReadonlyStore<WorkspacesState> = createStaticStore({
  status: 'loading',
} as WorkspacesState);

function stopLocalPlatformSnapshotPolling(state: LocalPlatformClientState): void {
  if (state.pollInterval === null) return;
  clearInterval(state.pollInterval);
  state.pollInterval = null;
}

function startLocalPlatformSnapshotPolling(
  state: LocalPlatformClientState,
  ipcClient: LodyIpcClient,
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
      const snapshot = await getIpcServices(ipcClient)?.localPlatform.getSnapshot();
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
      stopLocalPlatformSnapshotPolling(state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workspacesStore.set({ status: 'error', message });
      settled = true;
      stopLocalPlatformSnapshotPolling(state);
      console.error('local-platform: bootstrap snapshot failed', error);
    } finally {
      inFlight = false;
    }
  };
  state.pollInterval = setInterval(() => {
    void poll();
  }, IMPLICIT_WORKSPACE_POLL_INTERVAL_MS);
  void poll();
}

function getLocalWorkspacesStore(state: LocalPlatformClientState): MutableStore<WorkspacesState> {
  if (!state.workspacesStore) {
    state.workspacesStore = createStore<WorkspacesState>({ status: 'loading' });
  }
  return state.workspacesStore;
}

function getLocalSessionStore(state: LocalPlatformClientState): MutableStore<PlatformSessionState> {
  if (!state.sessionStore) {
    state.sessionStore = createStore<PlatformSessionState>({ status: 'loading' });
  }
  return state.sessionStore;
}

function ensureLocalPlatformSnapshotPolling(ipcClient: LodyIpcClient): void {
  const state = getLocalPlatformClientState(ipcClient);
  if (state.pollingStarted) return;
  state.pollingStarted = true;
  const sessionStore = getLocalSessionStore(state);
  const workspacesStore = getLocalWorkspacesStore(state);
  startLocalPlatformSnapshotPolling(state, ipcClient, sessionStore, workspacesStore);
}

/**
 * Compatibility cleanup for tests and sequential hosts. Multi-surface hosts do
 * not reset shared state: they supply different bound clients instead.
 */
export function resetLocalPlatformSnapshotState(ipcClient: LodyIpcClient = windowIpcClient): void {
  const state = LOCAL_PLATFORM_STATE_BY_CLIENT.get(ipcClient);
  if (!state) return;
  stopLocalPlatformSnapshotPolling(state);
  LOCAL_PLATFORM_STATE_BY_CLIENT.delete(ipcClient);
}

/**
 * The local `PlatformProvider` belonging to one IPC client. The default keeps
 * Electron's one-provider-per-renderer behaviour.
 */
export function getLocalPlatformProvider(
  ipcClient: LodyIpcClient = windowIpcClient
): PlatformProvider {
  const state = getLocalPlatformClientState(ipcClient);
  if (!state.provider) {
    const sessionStore = getLocalSessionStore(state);
    const workspacesStore = getLocalWorkspacesStore(state);
    state.provider = createLocalPlatformProvider({
      session: sessionStore,
      workspaces: workspacesStore,
    });
    ensureLocalPlatformSnapshotPolling(ipcClient);
  }
  return state.provider;
}

/**
 * The implicit local workspace, or null while the CLI has not provisioned it
 * (and always null on the cloud platform, without starting any polling).
 */
export function useImplicitLocalWorkspace(): WorkspaceSummary | null {
  const state = useLocalPlatformWorkspacesState();
  return state.status === 'ready' ? (state.workspaces[0] ?? null) : null;
}

/** Bootstrap state for route-level loading/error handling. */
export function useLocalPlatformWorkspacesState(
  explicitIpcClient?: LodyIpcClient
): WorkspacesState {
  const contextIpcClient = useIpcClient();
  const ipcClient = explicitIpcClient ?? contextIpcClient;
  if (isLocalAppPlatform()) {
    ensureLocalPlatformSnapshotPolling(ipcClient);
  }
  const state = getLocalPlatformClientState(ipcClient);
  const store = isLocalAppPlatform() ? getLocalWorkspacesStore(state) : CLOUD_WORKSPACES_STORE;
  return useStoreValue(store);
}

/** Route slug of the implicit local workspace. */
export function getLocalWorkspaceSlug(workspace: WorkspaceSummary): string {
  return workspace.slug ?? LOCAL_WORKSPACE_FALLBACK_SLUG;
}
