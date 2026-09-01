import type {
  AgentRuleView,
  CatalogEntryView,
  ConnectionView,
  CredentialRequestView,
  FolderGrantView,
  FolderView,
  ListMachineTypesResponse,
  MachineType,
  MachineView,
  OrgUsageCaptureResponse,
  ProviderHealthView,
  TemplateRepoView,
  UserGrantView,
  WorkspaceCredentialView,
  WorkspaceMemberView,
  WorkspaceView,
} from '@blitzos/schema';
import { ApiRequestError, type InviteView, type MemberView } from '../api';
import type { TenantMe } from '../api-adapter';
import type {
  ComputeCredentialMetadata,
  ComputeCredentialProvider,
} from '../compute-credentials-api';
import type { CloudWorkspaceModel } from '../workspace-store';

/* Fixture data for the settings design gallery (settings-preview.html).
 * The arrays here are deliberately mutable module state: the mock client in
 * preview-client.ts mutates them on writes, so panels that reload after a
 * write (revoke, dismiss, save) show the change. Nothing reaches the network. */

const PREVIEW_LATENCY_MS = 50;

/** Reads resolve after a beat so loading states flash by. */
export function delay(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, PREVIEW_LATENCY_MS);
  });
}

export async function respond<T>(value: T): Promise<T> {
  await delay();
  return value;
}

const NOW = Date.now();
const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/* ---------------------------------------------------------------- viewers */

const ORG = { id: 'org-acme', slug: 'acme', name: 'Acme Robotics', vmLimit: 10 };
/* A second org so the Profile panel's Organizations section shows a Switch
 * row beside the current one. */
const SIDE_ORG = { id: 'org-side', slug: 'side-lab', name: 'Side Lab', vmLimit: 10 };

export const adminViewer: TenantMe = {
  identity: {
    id: 'usr-june',
    email: 'june@acme.dev',
    name: 'June Park',
    avatarUrl: null,
    platformOperator: false,
  },
  membership: { id: 'm-june', role: 'admin' },
  org: ORG,
  organizations: [
    { membership: { id: 'm-june', role: 'admin' }, org: ORG },
    { membership: { id: 'm-june-side', role: 'member' }, org: SIDE_ORG },
  ],
};

export const memberViewer: TenantMe = {
  identity: {
    id: 'usr-ada',
    email: 'ada@acme.dev',
    name: 'Ada Lovelace',
    avatarUrl: null,
    platformOperator: false,
  },
  membership: { id: 'm-ada', role: 'member' },
  org: ORG,
  organizations: [{ membership: { id: 'm-ada', role: 'member' }, org: ORG }],
};

/* ------------------------------------------------------------ org members */

export const orgMembers: MemberView[] = [
  { id: 'm-june', email: 'june@acme.dev', name: 'June Park', avatarUrl: null, role: 'admin', status: 'active' },
  { id: 'm-ada', email: 'ada@acme.dev', name: 'Ada Lovelace', avatarUrl: null, role: 'member', status: 'active' },
  { id: 'm-rio', email: 'rio@acme.dev', name: 'Rio Tanaka', avatarUrl: null, role: 'member', status: 'active' },
  { id: 'm-sol', email: 'sol@acme.dev', name: 'Sol Weiss', avatarUrl: null, role: 'member', status: 'disabled' },
];

export const invites: InviteView[] = [
  {
    id: 'inv-1',
    email: null,
    role: 'member',
    state: 'ready',
    createdAt: NOW - 2 * DAY,
    expiresAt: NOW + 5 * DAY,
    redeemedAt: null,
  },
  {
    id: 'inv-2',
    email: 'kai@acme.dev',
    role: 'admin',
    state: 'redeemed',
    createdAt: NOW - 6 * DAY,
    expiresAt: NOW + DAY,
    redeemedAt: NOW - 5 * DAY,
  },
];

/* ---------------------------------------------------------- machine types */

const machineTypes: MachineType[] = [
  {
    id: 'cx22@hel1',
    providerId: 'hetzner',
    supportsVolumes: true,
    name: 'CX22',
    cpuCores: 2,
    memGb: 4,
    diskGb: 40,
    arch: 'x86',
    location: 'hel1',
    monthlyPrice: { amount: 3.79, currency: 'EUR' },
  },
  {
    id: 'cx32@hel1',
    providerId: 'hetzner',
    supportsVolumes: true,
    name: 'CX32',
    cpuCores: 4,
    memGb: 8,
    diskGb: 80,
    arch: 'x86',
    location: 'hel1',
    monthlyPrice: { amount: 6.8, currency: 'EUR' },
  },
  {
    id: 'cpx41@hil',
    providerId: 'hetzner',
    supportsVolumes: true,
    name: 'CPX41',
    cpuCores: 8,
    memGb: 16,
    diskGb: 240,
    arch: 'x86',
    location: 'hil',
    monthlyPrice: { amount: 25.61, currency: 'USD' },
  },
  {
    id: 'cax31@fsn1',
    providerId: 'hetzner',
    supportsVolumes: true,
    name: 'CAX31',
    cpuCores: 8,
    memGb: 16,
    diskGb: 160,
    arch: 'arm64',
    location: 'fsn1',
    monthlyPrice: { amount: 12.49, currency: 'EUR' },
  },
];

export function listMachineTypesFixture(): Promise<ListMachineTypesResponse> {
  return respond({
    machineTypes: [...machineTypes],
    failures: [],
    providerStatuses: [{ providerId: 'hetzner', access: 'org' as const }],
  });
}

/* -------------------------------------------------------------- workspace */

const juneMachine: MachineView = {
  id: 'mach-june',
  state: 'running',
  machineTypeId: 'cx32@hel1',
  volumeId: 'vol-june',
  membershipId: 'm-june',
  error: null,
  createdAt: NOW - 12 * DAY,
  updatedAt: NOW - 2 * HOUR,
};

const adaMachine: MachineView = {
  id: 'mach-ada',
  state: 'provisioning',
  machineTypeId: 'cx22@hel1',
  volumeId: null,
  membershipId: 'm-ada',
  error: null,
  createdAt: NOW - 3 * MINUTE,
  updatedAt: NOW - MINUTE,
};

const workspaceMembers: WorkspaceMemberView[] = [
  { membershipId: 'm-june', name: 'June Park', avatarUrl: null, role: 'admin', machine: juneMachine },
  { membershipId: 'm-ada', name: 'Ada Lovelace', avatarUrl: null, role: 'member', machine: adaMachine },
  { membershipId: 'm-rio', name: 'Rio Tanaka', avatarUrl: null, role: 'viewer', machine: null },
];

const workspaceCredentials: WorkspaceCredentialView[] = [
  { name: 'STRIPE_API_KEY', label: 'test-mode key, safe for CI', createdAt: NOW - 9 * DAY },
  { name: 'OPENAI_API_KEY', label: null, createdAt: NOW - 3 * DAY },
];

export const previewWorkspace: CloudWorkspaceModel = {
  id: 'ws-preview',
  ownerMembershipId: 'm-june',
  canControl: true,
  shared: false,
  owner: { name: 'June Park', avatarUrl: null },
  accessRole: 'owner',
  serverName: 'brave-otter',
  title: 'brave-otter',
  machineType: 'cx32@hel1',
  volumeId: 'vol-june',
  lifecycleStatus: 'running',
  errorDetail: null,
  retryAction: null,
  createdAt: NOW - 12 * DAY,
  updatedAt: NOW - 2 * HOUR,
  connections: ['github'],
  members: workspaceMembers,
  credentials: workspaceCredentials,
  defaultMachineTypeId: 'cx22@hel1',
  autoProvision: true,
  agentRuleId: null,
  myRole: 'admin',
  agentDefault: 'claude',
};

export function workspaceView(): WorkspaceView {
  return {
    id: 'ws-preview',
    name: 'brave-otter',
    machineTypeId: 'cx32@hel1',
    phase: 'ready',
    retryAction: null,
    canObserve: true,
    launchable: true,
    revision: 12,
    createdAt: NOW - 12 * DAY,
    updatedAt: Date.now(),
    ssh: null,
    volumeId: 'vol-june',
    error: null,
    role: 'owner',
    owner: { name: 'June Park', avatarUrl: null },
    agentRuleId: null,
    connections: ['github'],
    orgId: 'org-acme',
    ownerMembershipId: 'm-june',
    defaultMachineTypeId: 'cx22@hel1',
    autoProvision: true,
    myRole: 'admin',
    members: [...workspaceMembers],
    credentials: [...workspaceCredentials],
  };
}

export const workspaceRepos: TemplateRepoView[] = [
  { repo: 'acme/robot-fw', private: true },
  { repo: 'acme/site', private: false },
];

export function machineFor(machineId: string): MachineView {
  return machineId === adaMachine.id ? adaMachine : juneMachine;
}

export function memberFor(membershipId: string): WorkspaceMemberView {
  const found = workspaceMembers.find((member) => member.membershipId === membershipId);
  if (found === undefined) throw new ApiRequestError('No such workspace member.', 404, null);
  return found;
}

/* ------------------------------------------------------------ connections */

export const userGrants: UserGrantView[] = [
  {
    provider: 'github',
    manifestId: 'github',
    kind: 'oauth',
    label: 'github.com/junpark',
    scopes: ['repo', 'read:org'],
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 2 * DAY,
    accessExpiresAt: NOW + 50 * MINUTE,
  },
  {
    provider: 'linear',
    manifestId: 'linear',
    kind: 'pat',
    label: 'workspace key',
    scopes: [],
    createdAt: NOW - 9 * DAY,
    updatedAt: NOW - 9 * DAY,
    accessExpiresAt: null,
  },
];

export const providerHealth: ProviderHealthView[] = [
  { provider: 'github', state: 'healthy', detail: null, checkedAt: NOW - 4 * MINUTE, latencyMs: 212 },
  { provider: 'linear', state: 'unhealthy', detail: '401 from vendor', checkedAt: NOW - 70 * MINUTE, latencyMs: 340 },
];

export const orgConnections: ConnectionView[] = [
  {
    name: 'anthropic',
    provider: 'anthropic',
    kind: 'static',
    custody: 'cp',
    status: 'active',
    createdBy: 'usr-june',
    proxyBaseUrl: null,
    orgCredential: true,
  },
  {
    name: 'youtrack',
    provider: 'youtrack',
    kind: 'static',
    custody: 'proxy',
    status: 'active',
    createdBy: 'usr-june',
    proxyBaseUrl: 'https://acme.youtrack.cloud',
    orgCredential: true,
  },
];

export const connectionCatalog: CatalogEntryView[] = [
  {
    id: 'github',
    title: 'GitHub',
    summary: 'Repositories, issues and pull requests.',
    custody: 'cp',
    oauthAvailable: true,
    oauthConfigured: true,
    personalTokenLabel: 'Personal access token',
    personalTokenHelp: 'A classic PAT with repo scope.',
    personalTokenBaseUrlLabel: null,
    adminForm: null,
  },
  {
    id: 'linear',
    title: 'Linear',
    summary: 'Issues and projects.',
    custody: 'proxy',
    oauthAvailable: false,
    oauthConfigured: false,
    personalTokenLabel: 'Personal API key',
    personalTokenHelp: 'From Linear settings → API.',
    personalTokenBaseUrlLabel: null,
    adminForm: null,
  },
  {
    id: 'notion',
    title: 'Notion',
    summary: 'Pages and databases.',
    custody: 'cp',
    oauthAvailable: true,
    oauthConfigured: false,
    personalTokenLabel: 'Internal integration secret',
    personalTokenHelp: 'From notion.so/my-integrations.',
    personalTokenBaseUrlLabel: null,
    adminForm: null,
  },
];

const linearRequest: CredentialRequestView = {
  id: 'req-linear',
  workspace_id: 'ws-preview',
  connection_name: 'linear',
  requested_scopes: ['issues:read'],
  created_at: NOW - 20 * MINUTE,
  requester: { boxId: 'box-1', userId: 'usr-ada' },
};

/** The connect inbox, one array per state the Requests panel reads. */
export interface CredentialRequestBuckets {
  pending: CredentialRequestView[];
  approved: CredentialRequestView[];
  denied: CredentialRequestView[];
}

export const credentialRequests: CredentialRequestBuckets = {
  pending: [linearRequest],
  approved: [
    {
      id: 'req-github',
      workspace_id: 'ws-preview',
      connection_name: 'github',
      requested_scopes: [],
      created_at: NOW - 3 * DAY,
      requester: { boxId: 'box-1', userId: 'usr-june' },
    },
  ],
  denied: [
    {
      id: 'req-salesforce',
      workspace_id: 'ws-preview',
      connection_name: 'salesforce',
      requested_scopes: ['crm:write'],
      created_at: NOW - 6 * DAY,
      requester: null,
    },
  ],
};

/** A fresh copy for the drawer section, so dismissing a card there does not
 * empty the settings Requests panel and vice versa. */
export function wantedRequestsSeed(): CredentialRequestView[] {
  return [{ ...linearRequest }];
}

/* ------------------------------------------- compute credentials & usage */

export const computeCredentials = new Map<ComputeCredentialProvider, ComputeCredentialMetadata>([
  ['hetzner', { provider: 'hetzner', validated_at: NOW - 6 * DAY, created_by: 'June Park' }],
]);

/** The usage-capture toggle's server state, boxed so the mock client can
 * replace it across module boundaries. */
export interface UsageCaptureState {
  current: OrgUsageCaptureResponse;
}

export const usageState: UsageCaptureState = {
  current: { enabled: false, folderId: null },
};

/* ------------------------------------------------------------ agent rules */

export const agentRules: AgentRuleView[] = [
  {
    id: null,
    name: 'Default (built-in)',
    content: '# Agent rules\n\nBe direct. Ask before destructive actions.\nKeep secrets out of transcripts.\n',
    updatedAt: null,
    builtIn: true,
  },
  {
    id: 'rule-house',
    name: 'House rules',
    content: '# House rules\n\nRun the three gates before claiming success.\nNever raise the lint baseline.\n',
    updatedAt: NOW - 5 * DAY,
    builtIn: false,
  },
];

/* ----------------------------------------------------------------- drive */

/** The share dialog's org-wide access, boxed so the mock client can write it
 * across module boundaries. */
export interface FolderShareState {
  orgRole: 'editor' | 'viewer' | null;
}

export const folderState: FolderShareState = { orgRole: 'viewer' };

export const folderGrants: FolderGrantView[] = [
  {
    id: 'grant-ada',
    membershipId: 'm-ada',
    role: 'editor',
    createdAt: NOW - 8 * DAY,
    member: { name: 'Ada Lovelace', email: 'ada@acme.dev', avatarUrl: null },
  },
  {
    id: 'grant-rio',
    membershipId: 'm-rio',
    role: 'viewer',
    createdAt: NOW - 2 * DAY,
    member: { name: 'Rio Tanaka', email: 'rio@acme.dev', avatarUrl: null },
  },
];

/** Rebuilt per read so the dialog's onChanged reload sees the mutations the
 * mock grant writes made. */
export function previewFolder(): FolderView {
  return {
    id: 'fld-designs',
    name: 'Design reviews',
    role: 'owner',
    orgRole: folderState.orgRole,
    owner: { name: 'June Park', avatarUrl: null },
    attachedWorkspaceIds: ['ws-preview'],
    createdAt: NOW - 40 * DAY,
    updatedAt: NOW - HOUR,
    grants: [...folderGrants],
  };
}
