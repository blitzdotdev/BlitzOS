import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ControlPlaneClient } from './api.js';
import { caughtErrorMessage, isUnauthorized } from './error-message.js';
import { parseAppRoute } from './sessions-page-state.js';
import {
  createStorageNamespace,
  defaultGlobalWebAppState,
  reconcileUiPreferences,
  type StorageNamespace,
  type WorkspaceWebAppStateV1,
} from './storage.js';
import { isTenantMe, meFromWire, type IdentityRecord } from './protocol.js';
import type { BoxEndpoints, EndpointResolver } from './resolver.js';
import { isVisibleWorkspace, type WorkspaceAction } from './workspace-store.js';
import { rememberWorkspaceEndpoints } from './workspace-endpoints.js';

type StateSetter<Value> = Dispatch<SetStateAction<Value>>;

type WorkspaceBootstrapOptions = {
  client: ControlPlaneClient;
  bootstrapVersion: number;
  signedOut: boolean;
  onUnauthorized: () => void;
  resolver: EndpointResolver;
  workspaceEndpoints: MutableRefObject<Map<string, BoxEndpoints>>;
  activeWorkspaceIdRef: MutableRefObject<string>;
  setActiveWorkspaceId: StateSetter<string>;
  setStorageNamespace: StateSetter<StorageNamespace | null>;
  setIdentityOnly: StateSetter<IdentityRecord | null>;
  dispatch: Dispatch<WorkspaceAction>;
  setLoaded: StateSetter<boolean>;
  setError: StateSetter<string | null>;
};

export function useWorkspaceBootstrap({
  client,
  bootstrapVersion,
  signedOut,
  onUnauthorized,
  resolver,
  workspaceEndpoints,
  activeWorkspaceIdRef,
  setActiveWorkspaceId,
  setStorageNamespace,
  setIdentityOnly,
  dispatch,
  setLoaded,
  setError,
}: WorkspaceBootstrapOptions): void {
  useEffect(() => {
    if (signedOut) return;
    let mounted = true;
    setLoaded(false);
    setError(null);
    void client.me()
      .then(async (wireMe) => {
        const me = meFromWire(wireMe);
        if (!isTenantMe(me)) {
          if (!mounted) return;
          setIdentityOnly(me.identity);
          setStorageNamespace(null);
          setLoaded(true);
          return;
        }
        setIdentityOnly(null);
        const namespace = createStorageNamespace(me.org.id, me.membership.id);
        const [globalState, poll] = await Promise.all([
          client.getGlobalWebAppState(),
          client.poll(),
        ]);
        const records = poll.workspaces.filter(isVisibleWorkspace);
        const workspaceStates = new Map<string, WorkspaceWebAppStateV1>();
        await Promise.all(records.map(async ({ id }) => {
          // A preferences doc is never worth failing the boot over: missing,
          // stale, or malformed state falls back to defaults for that
          // workspace while the rest of the app loads normally.
          try {
            const state = await client.getWorkspaceWebAppState(id);
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
        if (!mounted) return;
        if (isUnauthorized(cause)) {
          onUnauthorized();
          return;
        }
        setLoaded(true);
        setError(caughtErrorMessage(cause, 'The control plane request failed.'));
      });
    return () => {
      mounted = false;
    };
  }, [
    activeWorkspaceIdRef,
    bootstrapVersion,
    client,
    dispatch,
    onUnauthorized,
    resolver,
    setActiveWorkspaceId,
    setError,
    setLoaded,
    setIdentityOnly,
    setStorageNamespace,
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
  // One poller, two cadences: 15s at rest, 5s (plus an immediate refresh)
  // while any workspace is transitioning, so lifecycle changes land fast
  // without a second timer or a doubled focus listener.
  useEffect(() => {
    if (!loaded) return;
    const transitioning = !signedOut && transitioningWorkspaceCount > 0;
    const refresh = () => {
      void refreshWorkspaceRecords();
    };
    if (transitioning) refresh();
    const interval = window.setInterval(refresh, transitioning ? 5_000 : 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
    };
  }, [loaded, refreshWorkspaceRecords, signedOut, transitioningWorkspaceCount]);
}
