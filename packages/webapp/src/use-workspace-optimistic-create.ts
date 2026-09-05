import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { V2WorkspaceRecord } from './api-adapter';
import type { CreateWorkspaceDialogInput } from './CreateWorkspaceDialog';
import { caughtErrorMessage } from './error-message';
import type { EndpointResolver } from './resolver';
import { workspacePath, type AppRoute } from './sessions-page-state';
import {
  pendingWorkspaceModel,
  selectControllableWorkspaceId,
  type WorkspaceAction,
  type WorkspaceStoreState,
} from './workspace-store';
import {
  rememberWorkspaceEndpoints,
  type WorkspaceEndpoints,
} from './workspace-endpoints';

type StateSetter<Value> = Dispatch<SetStateAction<Value>>;

type OptimisticCreateOptions = {
  resolver: EndpointResolver;
  workspaceEndpoints: MutableRefObject<Map<string, WorkspaceEndpoints>>;
  storeRef: MutableRefObject<WorkspaceStoreState>;
  activeWorkspaceIdRef: MutableRefObject<string>;
  commitWorkspaceMutation: (action: WorkspaceAction) => void;
  setActiveWorkspaceId: StateSetter<string>;
  setRoute: StateSetter<AppRoute>;
  setError: StateSetter<string | null>;
  closeCreateDialog: () => void;
  navigateToWorkspacePage: (workspaceId: string) => void;
};

/** Keeps a client-only workspace on the rail while create is in flight, then
 * commits the server record or removes the placeholder and repairs the route. */
export function useWorkspaceOptimisticCreate({
  resolver,
  workspaceEndpoints,
  storeRef,
  activeWorkspaceIdRef,
  commitWorkspaceMutation,
  setActiveWorkspaceId,
  setRoute,
  setError,
  closeCreateDialog,
  navigateToWorkspacePage,
}: OptimisticCreateOptions) {
  return useCallback((
    input: CreateWorkspaceDialogInput,
    create: () => Promise<V2WorkspaceRecord>,
  ) => {
    const viewer = storeRef.current.viewer;
    if (viewer === null) return;
    const temporaryId = `pending-workspace-${crypto.randomUUID()}`;
    const previousActiveWorkspaceId = activeWorkspaceIdRef.current;
    const placeholder = pendingWorkspaceModel(temporaryId, input, viewer);

    setError(null);
    closeCreateDialog();
    commitWorkspaceMutation({ type: 'workspace_create_started', workspace: placeholder });
    activeWorkspaceIdRef.current = temporaryId;
    setActiveWorkspaceId(temporaryId);
    navigateToWorkspacePage(temporaryId);

    void create().then((record) => {
      rememberWorkspaceEndpoints(workspaceEndpoints.current, [record], resolver);
      commitWorkspaceMutation({
        type: 'workspace_create_committed',
        temporaryId,
        record,
        agentDefault: 'claude',
      });
      if (activeWorkspaceIdRef.current !== temporaryId) return;
      activeWorkspaceIdRef.current = record.id;
      setActiveWorkspaceId(record.id);
      const path = workspacePath(record.id);
      // The temporary route is implementation state, not a history entry a
      // member can navigate back to after the server assigns the real id.
      window.history.replaceState({}, '', path);
      setRoute({ workspaceId: record.id, page: 'webApp', chat: null });
    }).catch((createFailure) => {
      commitWorkspaceMutation({ type: 'workspace_create_rolled_back', temporaryId });
      setError(`Could not create “${placeholder.title}”: ${caughtErrorMessage(
        createFailure,
        'The control plane request failed.',
      )}`);
      if (activeWorkspaceIdRef.current !== temporaryId) return;
      const remaining = storeRef.current.workspaces.filter(({ id }) => id !== temporaryId);
      const fallbackId = selectControllableWorkspaceId(remaining, previousActiveWorkspaceId);
      activeWorkspaceIdRef.current = fallbackId;
      setActiveWorkspaceId(fallbackId);
      const path = fallbackId ? workspacePath(fallbackId) : '/';
      window.history.replaceState({}, '', path);
      setRoute(fallbackId
        ? { workspaceId: fallbackId, page: 'webApp', chat: null }
        : { workspaceId: null, page: 'drive' });
    });
  }, [
    activeWorkspaceIdRef,
    closeCreateDialog,
    commitWorkspaceMutation,
    navigateToWorkspacePage,
    resolver,
    setActiveWorkspaceId,
    setError,
    setRoute,
    storeRef,
    workspaceEndpoints,
  ]);
}
