import type {
  AgentRuleView,
  FolderGrantView,
  OrgCredentialImportResult,
  OrgCredentialView,
  UserGrantView,
} from '@blitzos/schema';
import { ApiRequestError, type ControlPlaneClient, type InviteView } from '../api';
import type { ComputeCredentialMetadata } from '../compute-credentials-api';
import { workspaceReadPath } from '../org-credential-grants';
import {
  agentRules,
  computeCredentials,
  connectionCatalog,
  credentialRequests,
  DAY,
  delay,
  folderGrants,
  folderState,
  grantProposals,
  HOUR,
  invites,
  machineFor,
  memberFor,
  orgConnections,
  orgCredentials,
  orgMembers,
  providerHealth,
  respond,
  usageState,
  userGrants,
  workspaceRepos,
  workspaceView,
} from './fixtures';

/* The mock control-plane client behind the settings design gallery. Each
 * method was found by reading the mounted component; reads answer from the
 * fixture arrays and writes mutate them, so a panel that reloads after a
 * write shows the change. */

let inviteCounter = 2;

/** Exactly the methods the mounted components call. Typed as a Pick of the
 * real client so every signature is checked against the wire contract. */
type PreviewClientMethods = Pick<
  ControlPlaneClient,
  | 'listMembers'
  | 'updateMember'
  | 'createInvite'
  | 'listInvites'
  | 'revokeInvite'
  | 'leaveOrg'
  | 'orgUsage'
  | 'billing'
  | 'getUsageCapture'
  | 'putUsageCapture'
  | 'listConnectionGrants'
  | 'deleteConnectionGrant'
  | 'listProviderHealth'
  | 'connectStartUrl'
  | 'listConnections'
  | 'listCredentialRequests'
  | 'denyCredentialRequest'
  | 'getComputeCredential'
  | 'putComputeCredential'
  | 'deleteComputeCredential'
  | 'listAgentRules'
  | 'putAgentRule'
  | 'deleteAgentRule'
  | 'listWorkspaceRepos'
  | 'addWorkspaceRepo'
  | 'removeWorkspaceRepo'
  | 'addWorkspaceMember'
  | 'updateWorkspaceMember'
  | 'removeWorkspaceMember'
  | 'provisionMemberMachine'
  | 'provisionMachine'
  | 'stopMachine'
  | 'startMachine'
  | 'recreateMachine'
  | 'destroyMachine'
  | 'setMachineType'
  | 'updateWorkspace'
  | 'poll'
  | 'listOrgCredentials'
  | 'putOrgCredential'
  | 'revokeOrgCredential'
  | 'replaceOrgCredentialGrants'
  | 'importOrgCredentials'
  | 'resolveGrantProposal'
  | 'listGithubInstallations'
  | 'listGithubRepositories'
  | 'listConnectionCatalog'
  | 'putConnectionGrant'
  | 'mintWorkspaceConnection'
  | 'disconnectWorkspaceConnection'
  | 'createFolderGrant'
  | 'setFolderOrgRole'
  | 'revokeFolderGrant'
>;

const methods: PreviewClientMethods = {
  listMembers: () => respond({ members: orgMembers.map((member) => ({ ...member })) }),

  updateMember: async (id, input) => {
    await delay();
    const found = orgMembers.find((member) => member.id === id);
    if (found === undefined) throw new ApiRequestError('No such member.', 404, null);
    if (input.role !== undefined) found.role = input.role;
    if (input.status !== undefined) found.status = input.status;
    return { member: { ...found } };
  },

  createInvite: async (input) => {
    await delay();
    inviteCounter += 1;
    const invite: InviteView = {
      id: `inv-${String(inviteCounter)}`,
      email: input.email ?? null,
      role: input.role,
      state: 'ready',
      createdAt: Date.now(),
      expiresAt: Date.now() + 7 * DAY,
      redeemedAt: null,
    };
    invites.unshift(invite);
    return { invite, code: `preview-${String(inviteCounter)}`, ttlDays: 7 };
  },

  listInvites: () => respond({ invites: invites.map((invite) => ({ ...invite })), ttlDays: 7 }),

  revokeInvite: async (id) => {
    await delay();
    const found = invites.find((invite) => invite.id === id);
    if (found !== undefined) found.state = 'revoked';
  },

  leaveOrg: () => delay(),

  orgUsage: () => respond({
    seatsUsed: orgMembers.filter(({ status }) => status === 'active').length,
    seatLimit: 5,
    vmsUsed: 2,
    vmLimit: 10,
    platformCompute: true,
  }),

  billing: () => respond({ url: '#preview-billing' }),

  getUsageCapture: () => respond({ ...usageState.current }),

  putUsageCapture: async (enabled) => {
    await delay();
    usageState.current = {
      enabled,
      folderId: enabled ? usageState.current.folderId ?? 'fld-usage' : usageState.current.folderId,
    };
    return { ...usageState.current };
  },

  listConnectionGrants: () => respond({ grants: userGrants.map((grant) => ({ ...grant })) }),

  deleteConnectionGrant: async (provider) => {
    await delay();
    const index = userGrants.findIndex((grant) => grant.provider === provider);
    if (index !== -1) userGrants.splice(index, 1);
  },

  listProviderHealth: () => respond({ providers: [...providerHealth] }),

  connectStartUrl: (provider) => `#preview-connect-${provider}`,

  listConnections: () => respond({ connections: orgConnections.map((row) => ({ ...row })) }),

  listCredentialRequests: async (_signal, state) => {
    await delay();
    return { requests: credentialRequests[state ?? 'pending'].map((row) => ({ ...row })) };
  },

  denyCredentialRequest: async (id) => {
    await delay();
    const index = credentialRequests.pending.findIndex((row) => row.id === id);
    if (index === -1) return;
    const [moved] = credentialRequests.pending.splice(index, 1);
    if (moved !== undefined) credentialRequests.denied.unshift(moved);
  },

  getComputeCredential: async (_orgId, provider) => {
    await delay();
    const stored = computeCredentials.get(provider);
    if (stored === undefined) throw new ApiRequestError('No stored credential.', 404, null);
    return { ...stored };
  },

  putComputeCredential: async (_orgId, provider) => {
    await delay();
    const saved: ComputeCredentialMetadata = {
      provider,
      validated_at: Date.now(),
      created_by: 'June Park',
    };
    computeCredentials.set(provider, saved);
    return { ...saved };
  },

  deleteComputeCredential: async (_orgId, provider) => {
    await delay();
    computeCredentials.delete(provider);
  },

  listAgentRules: () => respond({ rules: agentRules.map((rule) => ({ ...rule })) }),

  putAgentRule: async (id, input) => {
    await delay();
    const rule: AgentRuleView = {
      id,
      name: input.name,
      content: input.content,
      updatedAt: Date.now(),
      builtIn: false,
    };
    const index = agentRules.findIndex((row) => row.id === id);
    if (index === -1) agentRules.push(rule);
    else agentRules[index] = rule;
    return { rule };
  },

  deleteAgentRule: async (id) => {
    await delay();
    const index = agentRules.findIndex((row) => row.id === id);
    if (index !== -1) agentRules.splice(index, 1);
  },

  listWorkspaceRepos: () => respond({ repos: workspaceRepos.map((repo) => ({ ...repo })) }),

  addWorkspaceRepo: async (_workspaceId, input) => {
    await delay();
    if (!workspaceRepos.some((row) => row.repo === input.repo)) {
      workspaceRepos.push({ repo: input.repo, private: false });
    }
    return { repos: workspaceRepos.map((repo) => ({ ...repo })) };
  },

  removeWorkspaceRepo: async (_workspaceId, repo) => {
    await delay();
    const index = workspaceRepos.findIndex((row) => row.repo === repo);
    if (index !== -1) workspaceRepos.splice(index, 1);
  },

  addWorkspaceMember: async (_workspaceId, input) => {
    await delay();
    const person = orgMembers.find((member) => member.id === input.membershipId);
    return {
      member: {
        membershipId: input.membershipId,
        name: person?.name ?? input.membershipId,
        avatarUrl: person?.avatarUrl ?? null,
        role: input.role,
        machine: null,
      },
    };
  },

  updateWorkspaceMember: async (_workspaceId, membershipId, input) => {
    await delay();
    return { member: { ...memberFor(membershipId), role: input.role } };
  },

  removeWorkspaceMember: () => delay(),

  provisionMemberMachine: async (_workspaceId, membershipId) => {
    await delay();
    return { member: { ...memberFor(membershipId) } };
  },

  provisionMachine: (machineId) => respond({ machine: { ...machineFor(machineId) } }),
  stopMachine: (machineId) => respond({ machine: { ...machineFor(machineId) } }),
  startMachine: (machineId) => respond({ machine: { ...machineFor(machineId) } }),
  recreateMachine: (machineId) => respond({ machine: { ...machineFor(machineId) } }),
  destroyMachine: (machineId) => respond({ machine: { ...machineFor(machineId) } }),

  setMachineType: async (machineId, input) => {
    await delay();
    return { machine: { ...machineFor(machineId), machineTypeId: input.machineTypeId } };
  },

  updateWorkspace: () => respond({ workspace: workspaceView() }),

  /** The org credential store (plans/ORG-CREDENTIALS.md). Reads answer with
   * names, comments and grants; a write never echoes the value. */
  poll: () => respond({ workspaces: [workspaceView()] }),

  listOrgCredentials: async (_signal, workspaceId) => {
    await delay();
    const rows = workspaceId === undefined
      ? orgCredentials
      : orgCredentials.filter((row) => workspaceReadPath(row, workspaceId, 'm-june') !== 'unknown');
    return { credentials: rows.map((row) => ({ ...row, grants: [...row.grants] })) };
  },

  putOrgCredential: async (input) => {
    await delay();
    const existing = orgCredentials.find((row) => row.name === input.name);
    if (existing !== undefined) {
      existing.updatedAt = Date.now();
      if (input.comment !== undefined) existing.comment = input.comment;
      if (input.grants !== undefined) existing.grants = [...input.grants];
      return { credential: { ...existing, grants: [...existing.grants] } };
    }
    const credential: OrgCredentialView = {
      id: `cred-${input.name.toLowerCase()}`,
      name: input.name,
      comment: input.comment ?? null,
      createdByMembershipId: 'm-june',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      grants: input.grants === undefined
        ? [{ subjectKind: 'membership', subjectId: 'm-june', access: 'write' }]
        : [...input.grants],
    };
    orgCredentials.push(credential);
    return { credential: { ...credential, grants: [...credential.grants] } };
  },

  revokeOrgCredential: async (name) => {
    await delay();
    const index = orgCredentials.findIndex((row) => row.name === name);
    if (index !== -1) orgCredentials.splice(index, 1);
  },

  replaceOrgCredentialGrants: async (name, input) => {
    await delay();
    const found = orgCredentials.find((row) => row.name === name);
    if (found === undefined) throw new ApiRequestError('No such credential.', 404, null);
    found.grants = [...input.grants];
    found.updatedAt = Date.now();
    return { credential: { ...found, grants: [...found.grants] } };
  },

  importOrgCredentials: async (input) => {
    await delay();
    const results: OrgCredentialImportResult[] = [];
    const lines = input.text.split('\n');
    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (line === '' || line.startsWith('#')) return;
      const match = /^(?:export\s+)?([A-Za-z][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (match === null) {
        results.push({ name: line.slice(0, 32), line: index + 1, outcome: 'refused', reason: 'not KEY=value' });
        return;
      }
      // The pattern has both groups, so a match always fills them; the
      // defaults only satisfy the indexed-access check.
      const [, name = '', value = ''] = match;
      const existing = orgCredentials.find((row) => row.name === name);
      const outcome = existing === undefined ? 'stored' : 'rotated';
      results.push({ name, line: index + 1, outcome });
      if (input.dryRun === true || value === '') return;
      if (existing !== undefined) {
        existing.updatedAt = Date.now();
      } else {
        orgCredentials.push({
          id: `cred-${name.toLowerCase()}`,
          name,
          comment: null,
          createdByMembershipId: 'm-june',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          grants: [{ subjectKind: 'membership', subjectId: 'm-june', access: 'write' }],
        });
      }
    });
    return { results, linesRead: lines.length };
  },

  resolveGrantProposal: async (proposalId, input) => {
    await delay();
    const found = grantProposals.find((row) => row.id === proposalId);
    if (found === undefined) throw new ApiRequestError('No such proposal.', 404, null);
    found.state = input.approve ? 'approved' : 'denied';
    found.applied = input.approve ? [...input.changes] : [];
    return { proposal: { ...found, proposed: [...found.proposed] } };
  },

  listGithubInstallations: () => respond({
    installations: [
      { id: 1, accountLogin: 'acme', accountType: 'Organization', repositorySelection: 'all' as const },
    ],
  }),

  listGithubRepositories: () => respond({
    repositories: [
      { repo: 'acme/robot-fw', accountLogin: 'acme', private: true },
      { repo: 'acme/site', accountLogin: 'acme', private: false },
      { repo: 'junpark/dotfiles', accountLogin: 'junpark', private: false },
    ],
    truncated: false,
  }),

  listConnectionCatalog: () => respond({ providers: connectionCatalog.map((entry) => ({ ...entry })) }),

  putConnectionGrant: async (provider, input) => {
    await delay();
    const grant: UserGrantView = {
      provider,
      manifestId: input.manifestId,
      kind: 'pat',
      label: input.label ?? null,
      scopes: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      accessExpiresAt: null,
    };
    const index = userGrants.findIndex((row) => row.provider === provider);
    if (index === -1) userGrants.push(grant);
    else userGrants[index] = grant;
  },

  mintWorkspaceConnection: async (workspaceId, connectionName) => {
    await delay();
    return {
      lease: {
        id: `lease-${connectionName}`,
        workspaceId,
        boxId: null,
        connection: connectionName,
        userId: 'usr-june',
        scopes: [],
        mode: 'proxy' as const,
        issuedAt: Date.now(),
        expiresAt: Date.now() + HOUR,
        state: 'active' as const,
      },
    };
  },

  disconnectWorkspaceConnection: () => delay(),

  createFolderGrant: async (_folderId, membershipId, role) => {
    await delay();
    const person = orgMembers.find((member) => member.id === membershipId);
    const existing = folderGrants.find((row) => row.membershipId === membershipId);
    if (existing !== undefined) {
      existing.role = role;
      return { grant: { ...existing } };
    }
    const grant: FolderGrantView = {
      id: `grant-${membershipId}`,
      membershipId,
      role,
      createdAt: Date.now(),
      member: {
        name: person?.name ?? membershipId,
        email: person?.email ?? `${membershipId}@acme.dev`,
        avatarUrl: person?.avatarUrl ?? null,
      },
    };
    folderGrants.push(grant);
    return { grant };
  },

  setFolderOrgRole: async (_folderId, orgRole) => {
    await delay();
    folderState.orgRole = orgRole;
  },

  revokeFolderGrant: async (_folderId, grantId) => {
    await delay();
    const index = folderGrants.findIndex((row) => row.id === grantId);
    if (index !== -1) folderGrants.splice(index, 1);
  },
};

// SAFETY: preview-only client. The gallery mounts only components whose client
// calls are implemented in `methods` above (each component was read to list
// its calls), so no unimplemented ControlPlaneClient method is ever invoked.
const cast = methods as ControlPlaneClient;

export const previewClient = cast;
