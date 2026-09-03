import type { TenantMe } from './api-adapter';
import type {
  MachineView,
  RetryAction,
  WorkspaceCredentialView,
  WorkspaceMemberRole,
  WorkspaceMemberView,
} from '@blitzos/schema';
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
  serverName: string;
  title: string;
  machineType: string | null;
  volumeId: string | null;
  lifecycleStatus: RestWorkspaceStatus;
  errorDetail: string | null;
  retryAction: RetryAction;
  createdAt: number;
  updatedAt: number;
  /** Stipulated connection names off the workspace ceiling. */
  connections: string[];
  /** The member-machines view the details dialog administers (§1). */
  members: WorkspaceMemberView[];
  credentials: WorkspaceCredentialView[];
  defaultMachineTypeId: string;
  autoProvision: boolean;
  agentRuleId: string | null;
  myRole: WorkspaceMemberRole | null;
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
  | { type: 'workspace_member_upserted'; workspaceId: string; member: WorkspaceMemberView }
  | { type: 'workspace_member_removed'; workspaceId: string; membershipId: string }
  | { type: 'workspace_credential_upserted'; workspaceId: string; credential: WorkspaceCredentialView }
  | { type: 'workspace_credential_removed'; workspaceId: string; name: string }
  | { type: 'workspace_member_machine_updated'; workspaceId: string; membershipId: string; machine: MachineView | null }
  | {
      type: 'workspace_settings_updated';
      workspaceId: string;
      settings: Pick<
        CloudWorkspaceModel,
        'serverName' | 'defaultMachineTypeId' | 'autoProvision' | 'agentRuleId' | 'updatedAt'
      >;
    }
  | { type: 'workspace_renamed'; workspaceId: string; title: string }
  | { type: 'agent_default_changed'; workspaceId: string; agent: Agent }
  | { type: 'workspace_reordered'; sourceId: string; targetId: string };

export const initialWorkspaceStore: WorkspaceStoreState = { workspaces: [], viewer: null };

function isVisibleWorkspace(record: WorkspaceRecord): boolean {
  return record.status !== 'destroying' && record.status !== 'destroyed';
}

/** The parts of a model the server does not own, and which therefore survive
 * a refresh: the local title, the chosen agent, and the last values of the
 * three fields a record may omit. */
type LocalWorkspaceState = Pick<
  CloudWorkspaceModel,
  'title' | 'agentDefault' | 'owner' | 'connections' | 'updatedAt'
>;

/**
 * Projects one record over the state that preceded it.
 *
 * Create, load and refresh all go through here, so a field added to
 * `WorkspaceRecord` reaches every path at once. Listing the fields on only
 * one of the three is how `agentRuleId` used to go stale after a poll.
 */
function applyRecord(
  existing: LocalWorkspaceState,
  record: WorkspaceRecord,
): CloudWorkspaceModel {
  return {
    id: record.id,
    ownerMembershipId: record.ownerMembershipId,
    canControl: record.canControl,
    shared: record.shared === true,
    owner: record.owner ?? existing.owner,
    accessRole: record.accessRole ?? null,
    serverName: record.name,
    title: record.canControl ? existing.title || record.name : record.name,
    machineType: record.machineType ?? null,
    volumeId: record.volumeId ?? null,
    lifecycleStatus: record.status,
    errorDetail: record.errorDetail ?? null,
    retryAction: record.retryAction,
    createdAt: record.createdAt,
    updatedAt: Math.max(existing.updatedAt, record.updatedAt),
    connections: record.connections ?? existing.connections,
    members: record.members,
    credentials: record.credentials,
    defaultMachineTypeId: record.defaultMachineTypeId,
    autoProvision: record.autoProvision,
    agentRuleId: record.agentRuleId,
    myRole: record.myRole,
    agentDefault: existing.agentDefault,
  };
}

function createWorkspaceModel(
  record: WorkspaceRecord,
  preferences: UiPreferences,
): CloudWorkspaceModel {
  const preference = preferences.workspaces[record.id];
  return applyRecord({
    title: preference?.title ?? '',
    agentDefault: preference?.agentDefault ?? 'claude',
    owner: null,
    connections: [],
    updatedAt: 0,
  }, record);
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
        return applyRecord(existing, record);
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
          return [applyRecord(workspace, record)];
        }),
      };
    }
    case 'workspace_record_updated':
      return mapWorkspace(state, action.record.id, (workspace) => ({
        ...workspace,
        machineType: action.record.machineType ?? workspace.machineType,
        volumeId: action.record.volumeId ?? null,
        lifecycleStatus: action.record.status,
        errorDetail: action.record.errorDetail ?? null,
        retryAction: action.record.retryAction,
        updatedAt: action.record.updatedAt,
        // A machine act shows up here: the details dialog reads the rows this
        // poll refreshes rather than tracking lifecycle of its own.
        members: action.record.members,
        credentials: action.record.credentials,
        autoProvision: action.record.autoProvision,
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
    case 'workspace_member_upserted':
      return mapWorkspace(state, action.workspaceId, (workspace) => {
        const index = workspace.members.findIndex(
          ({ membershipId }) => membershipId === action.member.membershipId,
        );
        if (index < 0) {
          return { ...workspace, members: [...workspace.members, action.member] };
        }
        const members = [...workspace.members];
        members[index] = action.member;
        return { ...workspace, members };
      });
    case 'workspace_member_removed':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({
        ...workspace,
        members: workspace.members.filter(
          ({ membershipId }) => membershipId !== action.membershipId,
        ),
      }));
    case 'workspace_credential_upserted':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({
        ...workspace,
        credentials: [
          ...workspace.credentials.filter(({ name }) => name !== action.credential.name),
          action.credential,
        ],
      }));
    case 'workspace_credential_removed':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({
        ...workspace,
        credentials: workspace.credentials.filter(({ name }) => name !== action.name),
      }));
    case 'workspace_member_machine_updated':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({
        ...workspace,
        members: workspace.members.map((member) => member.membershipId === action.membershipId
          ? { ...member, machine: action.machine }
          : member),
      }));
    case 'workspace_settings_updated':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({
        ...workspace,
        ...action.settings,
      }));
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
