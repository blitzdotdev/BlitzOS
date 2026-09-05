import type { TenantMe } from './api-adapter';
import type {
  CreateWorkspaceRequest,
  MachineView,
  RetryAction,
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
  /** Client-only create placeholder. It is never derived from or sent to the wire. */
  pendingCreate: boolean;
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
  | { type: 'workspace_create_started'; workspace: CloudWorkspaceModel }
  | { type: 'workspace_create_committed'; temporaryId: string; record: WorkspaceRecord; agentDefault: Agent }
  | { type: 'workspace_create_rolled_back'; temporaryId: string }
  | { type: 'workspace_records_refreshed'; records: WorkspaceRecord[]; heldWorkspaceIds?: string[] }
  | { type: 'workspace_record_updated'; record: WorkspaceRecord }
  | { type: 'workspace_resume_failed'; workspaceId: string; errorDetail: string }
  | { type: 'workspace_deleted'; workspaceId: string }
  | { type: 'workspace_delete_rolled_back'; workspace: CloudWorkspaceModel; index: number }
  | { type: 'workspace_member_upserted'; workspaceId: string; member: WorkspaceMemberView }
  | { type: 'workspace_member_removed'; workspaceId: string; membershipId: string }
  | {
      type: 'workspace_member_machine_updated';
      workspaceId: string;
      membershipId: string;
      machine: MachineView | null;
      lifecycleStatus?: RestWorkspaceStatus;
    }
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
  | { type: 'workspace_reordered'; sourceId: string; targetId: string }
  | { type: 'workspace_order_reconciled'; order: string[] };

export const initialWorkspaceStore: WorkspaceStoreState = { workspaces: [], viewer: null };

/** Builds the complete shell model needed before the control plane assigns an
 * id. The create contract guarantees the creator's admin membership; every
 * server-owned value that is not known yet stays empty or in `creating`. */
export function pendingWorkspaceModel(
  temporaryId: string,
  input: CreateWorkspaceRequest,
  viewer: TenantMe,
  now = Date.now(),
): CloudWorkspaceModel {
  const machineType = input.defaultMachineTypeId ?? input.machineTypeId ?? '';
  const serverName = input.name ?? '';
  const title = serverName || 'New workspace';
  return {
    id: temporaryId,
    pendingCreate: true,
    ownerMembershipId: viewer.membership.id,
    canControl: true,
    shared: false,
    owner: { name: viewer.identity.name || viewer.identity.email, avatarUrl: viewer.identity.avatarUrl },
    accessRole: 'owner',
    serverName,
    title,
    machineType: machineType || null,
    volumeId: input.volumeId ?? null,
    lifecycleStatus: 'creating',
    errorDetail: null,
    retryAction: null,
    createdAt: now,
    updatedAt: now,
    connections: input.connections ?? [],
    members: [{
      membershipId: viewer.membership.id,
      name: viewer.identity.name || viewer.identity.email,
      avatarUrl: viewer.identity.avatarUrl,
      role: 'admin',
      machine: null,
    }],
    defaultMachineTypeId: machineType,
    autoProvision: input.autoProvision !== false,
    agentRuleId: input.agentRuleId ?? null,
    myRole: 'admin',
    agentDefault: 'claude',
  };
}

/** The parts of a model the server does not own, and which therefore survive
 * a refresh: the local title, the chosen agent, and the last values of the
 * three fields a record may omit. */
type LocalWorkspaceState = Pick<
  CloudWorkspaceModel,
  'title' | 'agentDefault' | 'owner' | 'connections' | 'updatedAt'
>;

/**
 * The lifecycle the shell acts on, which is the VIEWER'S OWN MACHINE's.
 *
 * `record.status` is the wire's legacy `phase`, and the control plane projects
 * a STOPPED machine onto it as `ready` (`core/workspace-records.ts`,
 * `phaseForState`) so the workspace stays on the rail and its machine still
 * starts. Read as `running`, that made the shell dial a box with no VM behind
 * it: the terminal, the capability probe and every poller answered 409 "your
 * machine in this workspace is not running", and a member whose machine had
 * been stopped opened the workspace to a wall of them (Brandon, 2026-09-03).
 *
 * The view already says what the phase cannot: `members[].machine.state` for
 * the viewer's own membership. `stopped` there IS the lifecycle, whatever the
 * phase projects — so the shell stops dialling and offers Start instead. Any
 * other state keeps the phase's word: `provisioning` already arrives as
 * `creating`, and a member with no machine row is the capability probe's case
 * (`lody/box-capability.ts`, `noMachine`), not this one.
 */
export function lifecycleStatusFor(
  record: WorkspaceRecord,
  viewerMembershipId: string | null,
): RestWorkspaceStatus {
  if (record.status !== 'running' || viewerMembershipId === null) return record.status;
  const mine = record.members.find((member) => member.membershipId === viewerMembershipId);
  return mine?.machine?.state === 'stopped' ? 'stopped' : record.status;
}

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
  viewerMembershipId: string | null,
): CloudWorkspaceModel {
  return {
    id: record.id,
    pendingCreate: false,
    ownerMembershipId: record.ownerMembershipId,
    canControl: record.canControl,
    shared: record.shared === true,
    owner: record.owner ?? existing.owner,
    accessRole: record.accessRole ?? null,
    serverName: record.name,
    title: record.canControl ? existing.title || record.name : record.name,
    machineType: record.machineType ?? null,
    volumeId: record.volumeId ?? null,
    lifecycleStatus: lifecycleStatusFor(record, viewerMembershipId),
    errorDetail: record.errorDetail ?? null,
    retryAction: record.retryAction,
    createdAt: record.createdAt,
    updatedAt: Math.max(existing.updatedAt, record.updatedAt),
    connections: record.connections ?? existing.connections,
    members: record.members,
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
  viewerMembershipId: string | null,
): CloudWorkspaceModel {
  const preference = preferences.workspaces[record.id];
  return applyRecord({
    title: preference?.title ?? '',
    agentDefault: preference?.agentDefault ?? 'claude',
    owner: null,
    connections: [],
    updatedAt: 0,
  }, record, viewerMembershipId);
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
      // Every record the poll returns is a live workspace. `status` is a
      // projection of the member's MACHINE, so filtering `destroying` here
      // hid the workspace for the length of a stop, a recreate or a
      // machine-type change; deletion arrives as `workspace_deleted`.
      const viewerMembershipId = action.viewer.membership.id;
      const models = action.records.map((record) => {
        const existing = oldById.get(record.id);
        if (!existing || existing.canControl !== record.canControl) {
          return createWorkspaceModel(record, action.preferences, viewerMembershipId);
        }
        return applyRecord(existing, record, viewerMembershipId);
      });
      const order = new Map(action.preferences.order.map((id, index) => [id, index]));
      models.sort((left, right) => (
        (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        || right.createdAt - left.createdAt
      ));
      return { workspaces: models, viewer: action.viewer };
    }
    case 'workspace_create_started':
      return { ...state, workspaces: [action.workspace, ...state.workspaces] };
    case 'workspace_create_committed': {
      const index = state.workspaces.findIndex(({ id, pendingCreate }) => (
        pendingCreate && id === action.temporaryId
      ));
      if (index < 0) return state;
      const preferences: UiPreferences = {
        version: 1,
        activeWorkspaceId: action.record.id,
        railWidth: 240,
        order: [],
        workspaces: { [action.record.id]: { agentDefault: action.agentDefault } },
      };
      const workspace = createWorkspaceModel(
        action.record,
        preferences,
        state.viewer?.membership.id ?? null,
      );
      const workspaces = [...state.workspaces];
      workspaces[index] = workspace;
      return { ...state, workspaces };
    }
    case 'workspace_create_rolled_back':
      return {
        ...state,
        workspaces: state.workspaces.filter(({ id, pendingCreate }) => (
          !pendingCreate || id !== action.temporaryId
        )),
      };
    case 'workspace_records_refreshed': {
      const recordsById = new Map(action.records.map((record) => [record.id, record]));
      const heldWorkspaceIds = new Set(action.heldWorkspaceIds ?? []);
      return {
        ...state,
        workspaces: state.workspaces.flatMap((workspace) => {
          // The control plane cannot list a create it has not answered yet.
          if (workspace.pendingCreate) return [workspace];
          // A lifecycle mutation can activate the fast poll before its write
          // settles. Keep that exact row until the mutation has an answer.
          if (heldWorkspaceIds.has(workspace.id)) return [workspace];
          const record = recordsById.get(workspace.id);
          // Same rule as `workspaces_loaded`: a poll that catches the member's
          // machine mid-replacement must not evict the workspace from the rail.
          if (!record) return [];
          return [applyRecord(workspace, record, state.viewer?.membership.id ?? null)];
        }),
      };
    }
    case 'workspace_record_updated':
      return mapWorkspace(state, action.record.id, (workspace) => ({
        ...workspace,
        serverName: action.record.name,
        machineType: action.record.machineType ?? workspace.machineType,
        volumeId: action.record.volumeId ?? null,
        lifecycleStatus: lifecycleStatusFor(action.record, state.viewer?.membership.id ?? null),
        errorDetail: action.record.errorDetail ?? null,
        retryAction: action.record.retryAction,
        updatedAt: action.record.updatedAt,
        // A machine act shows up here: the details dialog reads the rows this
        // poll refreshes rather than tracking lifecycle of its own.
        members: action.record.members,
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
    case 'workspace_member_machine_updated':
      return mapWorkspace(state, action.workspaceId, (workspace) => ({
        ...workspace,
        lifecycleStatus: action.lifecycleStatus ?? workspace.lifecycleStatus,
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
    case 'workspace_order_reconciled': {
      const order = new Map(action.order.map((id, index) => [id, index]));
      return {
        ...state,
        workspaces: [...state.workspaces].sort((left, right) => (
          (order.get(left.id) ?? Number.MAX_SAFE_INTEGER)
          - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
        )),
      };
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
