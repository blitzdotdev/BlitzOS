import type { WorkspaceView } from '@blitzos/schema';
import type { CloudWorkspaceModel } from '../src/workspace-store.js';

/**
 * A complete `WorkspaceView`, for the suites that care about three fields and
 * have to state the rest.
 *
 * The member-machines fields (`orgId` … `credentials`) are required on the
 * wire, so without this every fixture would restate the same seven defaults
 * and drift from the next field the view grows.
 */
export function workspaceViewFixture(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: 'workspace-one',
    name: 'workspace-one',
    machineTypeId: 'cx23@fsn1',
    phase: 'ready',
    retryAction: null,
    canObserve: true,
    launchable: true,
    revision: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ssh: null,
    volumeId: null,
    error: null,
    role: 'owner',
    orgShareRole: null,
    owner: { name: 'Owner', avatarUrl: null },
    environment: null,
    agentRuleId: null,
    connections: [],
    orgId: 'org-1',
    ownerMembershipId: 'membership-1',
    defaultMachineTypeId: 'cx23@fsn1',
    autoProvision: true,
    myRole: 'admin',
    members: [],
    credentials: [],
    ...overrides,
  };
}

/** The webapp's own workspace model, as the store builds it from the wire.
 * Suites that render a shell component want three fields of it and have to
 * supply the rest. */
export function workspaceModelFixture(
  overrides: Partial<CloudWorkspaceModel> = {},
): CloudWorkspaceModel {
  return {
    id: 'workspace-one',
    ownerMembershipId: 'membership-1',
    canControl: true,
    shared: false,
    owner: { name: 'Ada Owner', avatarUrl: null },
    accessRole: 'owner',
    serverName: 'design-team',
    title: 'design-team',
    machineType: 'cx23@fsn1',
    volumeId: null,
    lifecycleStatus: 'running',
    errorDetail: null,
    retryAction: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    connections: [],
    members: [],
    credentials: [],
    defaultMachineTypeId: 'cx23@fsn1',
    autoProvision: true,
    agentRuleId: null,
    myRole: 'admin',
    agentDefault: 'claude',
    ...overrides,
  };
}
