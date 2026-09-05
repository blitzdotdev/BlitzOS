import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { ApiAdapter, ApiError, isTenantMe } from './api-adapter.js';
import { caughtErrorMessage } from './error-message.js';
import { parseAppRoute } from './sessions-page-state.js';
import {
  createStorageNamespace,
  defaultGlobalWebAppState,
  reconcileUiPreferences,
  type StorageNamespace,
  type GlobalWebAppStateV1,
  type WorkspaceWebAppStateV1,
} from './storage.js';
import type { IdentityRecord } from './protocol.js';
import type { EndpointResolver } from './resolver.js';
import type { WorkspaceAction } from './workspace-store.js';
import {
  rememberWorkspaceEndpoints,
  type WorkspaceEndpoints,
} from './workspace-endpoints.js';

type StateSetter<Value> = Dispatch<SetStateAction<Value>>;

type WorkspaceBootstrapOptions = {
  api: ApiAdapter;
  bootstrapVersion: number;
  signedOut: boolean;
  resolver: EndpointResolver;
  workspaceEndpoints: MutableRefObject<Map<string, WorkspaceEndpoints>>;
  activeWorkspaceIdRef: MutableRefObject<string>;
  setActiveWorkspaceId: StateSetter<string>;
  setStorageNamespace: StateSetter<StorageNamespace | null>;
  setIdentityOnly: StateSetter<IdentityRecord | null>;
  dispatch: Dispatch<WorkspaceAction>;
  setLoaded: StateSetter<boolean>;
  setError: StateSetter<string | null>;
  onGlobalStateLoaded: (doc: GlobalWebAppStateV1, namespace: StorageNamespace) => void;
};

export function useWorkspaceBootstrap({
  api,
  bootstrapVersion,
  signedOut,
  resolver,
  workspaceEndpoints,
  activeWorkspaceIdRef,
  setActiveWorkspaceId,
  setStorageNamespace,
  setIdentityOnly,
  dispatch,
  setLoaded,
  setError,
  onGlobalStateLoaded,
}: WorkspaceBootstrapOptions): void {
  useEffect(() => {
    if (signedOut) return;
    let mounted = true;
    setLoaded(false);
    setError(null);
    void api.getMe()
      .then(async (me) => {
        if (!isTenantMe(me)) {
          if (!mounted) return;
          setIdentityOnly(me.identity);
          setStorageNamespace(null);
          setLoaded(true);
          return;
        }
        setIdentityOnly(null);
        const namespace = createStorageNamespace(me.org.id, me.membership.id);
        const [globalState, records] = await Promise.all([
          api.getGlobalWebAppState(),
          api.listWorkspaces(),
        ]);
        const workspaceStates = new Map<string, WorkspaceWebAppStateV1>();
        await Promise.all(records.map(async ({ id }) => {
          // A preferences doc is never worth failing the boot over: missing,
          // stale, or malformed state falls back to defaults for that
          // workspace while the rest of the app loads normally.
          try {
            const state = await api.getWorkspaceWebAppState(id);
            if (state.doc !== null) workspaceStates.set(id, state.doc);
          } catch {
            // Defaults apply.
          }
        }));
        const preferences = reconcileUiPreferences(
          globalState.doc ?? defaultGlobalWebAppState(),
          workspaceStates,
          records.map(({ id }) => id),
        );
        if (!mounted) return;
        onGlobalStateLoaded(globalState.doc ?? defaultGlobalWebAppState(), namespace);
        rememberWorkspaceEndpoints(workspaceEndpoints.current, records, resolver, true);
        const routeWorkspaceId = parseAppRoute(window.location.pathname).workspaceId;
        const requestedWorkspaceId = routeWorkspaceId ?? preferences.activeWorkspaceId;
        activeWorkspaceIdRef.current = requestedWorkspaceId;
        setActiveWorkspaceId(requestedWorkspaceId);
        setStorageNamespace(namespace);
        dispatch({ type: 'workspaces_loaded', records, viewer: me, preferences });
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!mounted || (cause instanceof ApiError && cause.status === 401)) return;
        setLoaded(true);
        setError(caughtErrorMessage(cause, 'The control plane request failed.'));
      });
    return () => {
      mounted = false;
    };
  }, [
    activeWorkspaceIdRef,
    api,
    bootstrapVersion,
    dispatch,
    resolver,
    setActiveWorkspaceId,
    setError,
    setLoaded,
    setIdentityOnly,
    setStorageNamespace,
    onGlobalStateLoaded,
    signedOut,
    workspaceEndpoints,
  ]);
}

type WorkspacePollingOptions = {
  loaded: boolean;
  signedOut: boolean;
  transitioningWorkspaceCount: number;
  refreshWorkspaceRecords: () => Promise<void>;
};

export function useWorkspacePolling({
  loaded,
  signedOut,
  transitioningWorkspaceCount,
  refreshWorkspaceRecords,
}: WorkspacePollingOptions): void {
  useEffect(() => {
    if (!loaded) return;
    const refresh = () => {
      void refreshWorkspaceRecords();
    };
    const interval = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [loaded, refreshWorkspaceRecords, signedOut]);

  useEffect(() => {
    if (!loaded || signedOut || transitioningWorkspaceCount === 0) return;
    let mounted = true;
    const refresh = async () => {
      if (mounted) await refreshWorkspaceRecords();
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 5_000);
    window.addEventListener('focus', refresh);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [loaded, refreshWorkspaceRecords, signedOut, transitioningWorkspaceCount]);
}
