import type { RetryAction, WorkspaceView } from '@blitzos/schema';
import type { Agent, TenantMe } from './protocol';
import type { UiPreferences } from './storage';

/** The only statuses the wire can produce for a visible workspace: phases
 * `destroying` and `destroyed` are filtered before the store, `ready` reads
 * as running, and the rest pass through. */
export type WorkspaceLifecycleStatus = 'creating' | 'running' | 'error';

export type CloudWorkspaceModel = {
  id: string;
  canControl: boolean;
  owner: WorkspaceView['owner'];
  accessRole: WorkspaceView['role'];
  orgShareRole: 'editor' | 'viewer' | null;
  serverName: string;
  title: string;
  machineType: string;
  lifecycleStatus: WorkspaceLifecycleStatus;
  errorDetail: string | null;
  retryAction: RetryAction;
  updatedAt: number;
  /** Stipulated connection names off the workspace ceiling. */
  connections: string[];
  agentDefault: Agent;
};

export type WorkspaceStoreState = {
  workspaces: CloudWorkspaceModel[];
  viewer: TenantMe | null;
};

export type WorkspaceAction =
  | { type: 'workspaces_loaded'; records: WorkspaceView[]; viewer: TenantMe; preferences: UiPreferences }
  | { type: 'workspace_created'; record: WorkspaceView; agentDefault: Agent }
  | { type: 'workspace_records_refreshed'; records: WorkspaceView[] }
  | { type: 'workspace_deleted'; workspaceId: string }
  | { type: 'workspace_delete_rolled_back'; workspace: CloudWorkspaceModel; index: number };

export const initialWorkspaceStore: WorkspaceStoreState = { workspaces: [], viewer: null };

export function isVisibleWorkspace(record: WorkspaceView): boolean {
  return record.phase !== 'destroying' && record.phase !== 'destroyed';
}

function lifecycleStatusOf(record: WorkspaceView): WorkspaceLifecycleStatus {
  if (record.phase === 'creating') return 'creating';
  if (record.phase === 'error') return 'error';
  return 'running';
}

function createWorkspaceModel(
  record: WorkspaceView,
  preferences: UiPreferences,
): CloudWorkspaceModel {
  const preference = preferences.workspaces[record.id];
  const canControl = record.role !== null;
  return {
    id: record.id,
    canControl,
    owner: record.owner,
    accessRole: record.role,
    orgShareRole: record.orgShareRole,
    serverName: record.name,
    title: canControl ? preference?.title || record.name : record.name,
    machineType: record.machineTypeId,
    lifecycleStatus: lifecycleStatusOf(record),
    errorDetail: record.error,
    retryAction: record.retryAction,
    updatedAt: record.revision,
    connections: record.connections,
    agentDefault: preference?.agentDefault ?? 'claude',
  };
}

/** Everything a poll refresh may overwrite on a model it already holds; the
 * locally-owned title and agentDefault stay put. */
function refreshedFields(
  existing: CloudWorkspaceModel,
  record: WorkspaceView,
): CloudWorkspaceModel {
  const canControl = record.role !== null;
  return {
    ...existing,
    canControl,
    owner: record.owner,
    accessRole: record.role,
    orgShareRole: record.orgShareRole,
    serverName: record.name,
    title: canControl ? existing.title : record.name,
    machineType: record.machineTypeId,
    lifecycleStatus: lifecycleStatusOf(record),
    errorDetail: record.error,
    retryAction: record.retryAction,
    updatedAt: Math.max(existing.updatedAt, record.revision),
    connections: record.connections,
  };
}

export function workspaceReducer(state: WorkspaceStoreState, action: WorkspaceAction): WorkspaceStoreState {
  switch (action.type) {
    case 'workspaces_loaded': {
      const oldById = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
      const visibleRecords = action.records.filter(isVisibleWorkspace);
      const models = visibleRecords.map((record) => {
        const existing = oldById.get(record.id);
        if (!existing || existing.canControl !== (record.role !== null)) {
          return createWorkspaceModel(record, action.preferences);
        }
        return refreshedFields(existing, record);
      });
      const order = new Map(action.preferences.order.map((id, index) => [id, index]));
      models.sort((left, right) => (
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      ));
      return { workspaces: models, viewer: action.viewer };
    }
    case 'workspace_created': {
      const preferences: UiPreferences = {
        version: 1,
        activeWorkspaceId: action.record.id,
        railWidth: 240,
        order: [],
        workspaces: { [action.record.id]: { agentDefault: action.agentDefault } },
      };
      const workspace = createWorkspaceModel(action.record, preferences);
      return { ...state, workspaces: [workspace, ...state.workspaces] };
    }
    case 'workspace_records_refreshed': {
      const recordsById = new Map(action.records.map((record) => [record.id, record]));
      return {
        ...state,
        workspaces: state.workspaces.flatMap((workspace) => {
          const record = recordsById.get(workspace.id);
          if (!record || !isVisibleWorkspace(record)) return [];
          return [refreshedFields(workspace, record)];
        }),
      };
    }
    case 'workspace_deleted':
      return { ...state, workspaces: state.workspaces.filter(({ id }) => id !== action.workspaceId) };
    case 'workspace_delete_rolled_back': {
      if (state.workspaces.some(({ id }) => id === action.workspace.id)) return state;
      const workspaces = [...state.workspaces];
      workspaces.splice(
        Math.min(Math.max(action.index, 0), workspaces.length),
        0,
        action.workspace,
      );
      return { ...state, workspaces };
    }
  }
}

export function selectControllableWorkspaceId(
  workspaces: CloudWorkspaceModel[],
  preferredId: string,
): string {
  const preferred = workspaces.find(({ id }) => id === preferredId);
  if (preferred?.canControl) return preferred.id;
  return workspaces.find(({ canControl }) => canControl)?.id ?? '';
}
