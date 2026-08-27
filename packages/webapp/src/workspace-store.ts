import type { TenantMe } from './api-adapter';
import type { RetryAction } from '@blitzos/schema';
import type {
  Agent,
  RestWorkspaceStatus,
  WorkspaceRecord,
} from './protocol';
import type { UiPreferences } from './storage';

export type CloudWorkspaceModel = {
  id: string;
  ownerMembershipId: string;
  canControl: boolean;
  shared: boolean;
  owner: WorkspaceRecord['owner'] | null;
  accessRole: WorkspaceRecord['accessRole'];
  orgShareRole: 'editor' | 'viewer' | null;
  serverName: string;
  title: string;
  machineType: string | null;
  volumeId: string | null;
  environmentConfigured: boolean;
  startupConfigured: boolean;
  lifecycleStatus: RestWorkspaceStatus;
  errorDetail: string | null;
  retryAction: RetryAction;
  createdAt: number;
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
  | { type: 'workspaces_loaded'; records: WorkspaceRecord[]; viewer: TenantMe; preferences: UiPreferences }
  | { type: 'workspace_created'; record: WorkspaceRecord; agentDefault: Agent }
  | { type: 'workspace_records_refreshed'; records: WorkspaceRecord[] }
  | { type: 'workspace_record_updated'; record: WorkspaceRecord }
  | { type: 'workspace_resume_failed'; workspaceId: string; errorDetail: string }
  | { type: 'workspace_deleted'; workspaceId: string }
  | { type: 'workspace_delete_rolled_back'; workspace: CloudWorkspaceModel; index: number }
  | { type: 'workspace_renamed'; workspaceId: string; title: string }
  | { type: 'agent_default_changed'; workspaceId: string; agent: Agent }
  | { type: 'workspace_reordered'; sourceId: string; targetId: string };

export const initialWorkspaceStore: WorkspaceStoreState = { workspaces: [], viewer: null };

function isVisibleWorkspace(record: WorkspaceRecord): boolean {
  return record.status !== 'destroying' && record.status !== 'destroyed';
}

function createWorkspaceModel(
  record: WorkspaceRecord,
  preferences: UiPreferences,
): CloudWorkspaceModel {
  const preference = preferences.workspaces[record.id];
  return {
    id: record.id,
    ownerMembershipId: record.ownerMembershipId,
    canControl: record.canControl,
    shared: record.shared === true,
    owner: record.owner ?? null,
    accessRole: record.accessRole ?? null,
    orgShareRole: record.orgShareRole ?? null,
    serverName: record.name,
    title: record.canControl ? preference?.title || record.name : record.name,
    machineType: record.machineType ?? null,
    volumeId: record.volumeId ?? null,
    environmentConfigured: record.environmentConfigured === true,
    startupConfigured: record.startupConfigured === true,
    lifecycleStatus: record.status,
    errorDetail: record.errorDetail ?? null,
    retryAction: record.retryAction,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    connections: record.connections ?? [],
    agentDefault: preference?.agentDefault ?? 'claude',
  };
}

function mapWorkspace(
  state: WorkspaceStoreState,
  workspaceId: string,
  update: (workspace: CloudWorkspaceModel) => CloudWorkspaceModel,
): WorkspaceStoreState {
  return {
    ...state,
    workspaces: state.workspaces.map((workspace) => (
      workspace.id === workspaceId && workspace.canControl ? update(workspace) : workspace
    )),
  };
}

export function workspaceReducer(state: WorkspaceStoreState, action: WorkspaceAction): WorkspaceStoreState {
  switch (action.type) {
    case 'workspaces_loaded': {
      const oldById = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
      const visibleRecords = action.records.filter(isVisibleWorkspace);
      const models = visibleRecords.map((record) => {
        const existing = oldById.get(record.id);
        if (!existing || existing.canControl !== record.canControl) {
          return createWorkspaceModel(record, action.preferences);
        }
        return {
          ...existing,
          ownerMembershipId: record.ownerMembershipId,
          canControl: record.canControl,
          shared: record.shared === true,
          owner: record.owner ?? existing.owner,
          accessRole: record.accessRole ?? null,
    orgShareRole: record.orgShareRole ?? null,
          serverName: record.name,
          title: record.canControl ? existing.title : record.name,
          machineType: record.machineType ?? null,
          volumeId: record.volumeId ?? null,
          environmentConfigured: record.environmentConfigured === true,
          startupConfigured: record.startupConfigured === true,
          lifecycleStatus: record.status,
          errorDetail: record.errorDetail ?? null,
          retryAction: record.retryAction,
          createdAt: record.createdAt,
          updatedAt: Math.max(existing.updatedAt, record.updatedAt),
          connections: record.connections ?? existing.connections,
        };
      });
      const order = new Map(action.preferences.order.map((id, index) => [id, index]));
      models.sort((left, right) => (
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        || right.createdAt - left.createdAt
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
          return [{
            ...workspace,
            ownerMembershipId: record.ownerMembershipId,
            canControl: record.canControl,
            shared: record.shared === true,
            owner: record.owner ?? workspace.owner,
            accessRole: record.accessRole ?? null,
    orgShareRole: record.orgShareRole ?? null,
            serverName: record.name,
            title: record.canControl ? workspace.title : record.name,
            machineType: record.machineType ?? null,
            volumeId: record.volumeId ?? null,
            environmentConfigured: record.environmentConfigured === true,
            startupConfigured: record.startupConfigured === true,
            lifecycleStatus: record.status,
            errorDetail: record.errorDetail ?? null,
            retryAction: record.retryAction,
            createdAt: record.createdAt,
            updatedAt: Math.max(workspace.updatedAt, record.updatedAt),
            connections: record.connections ?? workspace.connections,
          }];
        }),
      };
    }
    case 'workspace_record_updated':
      return mapWorkspace(state, action.record.id, (workspace) => ({
        ...workspace,
        machineType: action.record.machineType ?? workspace.machineType,
        volumeId: action.record.volumeId ?? null,
        environmentConfigured: action.record.environmentConfigured === true,
        startupConfigured: action.record.startupConfigured === true,
        lifecycleStatus: action.record.status,
        errorDetail: action.record.errorDetail ?? null,
        retryAction: action.record.retryAction,
        updatedAt: action.record.updatedAt,
      }));
    case 'workspace_resume_failed':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({
        ...workspace,
        errorDetail: action.errorDetail,
      }));
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
    case 'workspace_renamed':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({ ...workspace, title: action.title }));
    case 'agent_default_changed':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({ ...workspace, agentDefault: action.agent }));
    case 'workspace_reordered': {
      const sourceIndex = state.workspaces.findIndex(({ id }) => id === action.sourceId);
      const targetIndex = state.workspaces.findIndex(({ id }) => id === action.targetId);
      if (sourceIndex < 0 || targetIndex < 0) return state;
      const workspaces = [...state.workspaces];
      const [moved] = workspaces.splice(sourceIndex, 1);
      if (!moved) return state;
      workspaces.splice(targetIndex, 0, moved);
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
