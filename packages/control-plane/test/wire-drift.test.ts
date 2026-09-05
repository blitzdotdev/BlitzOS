import * as schema from "@blitzos/schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import type * as connections from "../core/connections/types.js";
import * as wire from "../core/wire.js";

type SharedShape<Wire, Schema> = Wire & Schema;

const machineType: SharedShape<wire.MachineType, schema.MachineType> = {
  id: "mv-2c2g@lab",
  providerId: "microvm",
  supportsVolumes: false,
  name: "MicroVM 2 vCPU / 2 GB",
  cpuCores: 2,
  memGb: 2,
  diskGb: 8,
  arch: "x86",
  location: "lab",
  monthlyPrice: null,
};

// The microvm literal above declares no price, so the priced shape needs its
// own row: JSON round-tripping null covers a different field than an object.
const pricedMachineType: SharedShape<wire.MachineType, schema.MachineType> = {
  ...machineType,
  id: "cx23@hel1",
  providerId: "hetzner",
  location: "hel1",
  monthlyPrice: { amount: 6.49, currency: "USD" },
};

const machineTypeFailure: SharedShape<
  wire.MachineTypeProviderFailure,
  schema.MachineTypeProviderFailure
> = {
  providerId: "microvm",
  error: "capacity unavailable",
};

const volume: SharedShape<wire.Volume, schema.Volume> = {
  id: "volume",
  name: "state",
  sizeGb: 20,
  location: "fsn1",
  status: "attached",
  attachedTo: "workspace",
};

const environment: SharedShape<
  wire.WorkspaceEnvironment,
  schema.WorkspaceEnvironment
> = {
  env: { API_ORIGIN: "https://api.example" },
  startupScript: "npm install\n",
};

const environmentResponse: SharedShape<
  wire.WorkspaceEnvironmentResponse,
  schema.WorkspaceEnvironmentResponse
> = { ...environment, filesReady: true };

const agentRulesResponse: SharedShape<
  wire.AgentRulesResponse,
  schema.AgentRulesResponse
> = { version: "292a5824fd833548", content: "# Blitz box — agent rules\n" };

const payloadFile: SharedShape<wire.BoxPayloadFile, schema.BoxPayloadFile> = {
  path: "rootfs/usr/local/bin/blitz-box-gateway",
  sha256: "a".repeat(64),
  mode: "0755",
};

const payloadArchive: SharedShape<wire.BoxPayloadArchive, schema.BoxPayloadArchive> = {
  url: "https://cp.example/box-payload/v1/payload.tar.gz",
  sha256: "b".repeat(64),
  bytes: 1_234,
};

const payloadDaemon: SharedShape<
  wire.BoxPayloadDaemonArchive,
  schema.BoxPayloadDaemonArchive
> = {
  version: "0.88.1+blitz.3",
  protocolVersion: 7,
  url: "https://cp.example/box-payload/v1/daemon.tar.gz",
  sha256: "c".repeat(64),
  bytes: 4_321,
};

const payloadRestart: SharedShape<
  wire.BoxPayloadRestart,
  schema.BoxPayloadRestart
> = { gateway: [payloadFile.path], "lody-daemon": [] };

const payloadManifest: SharedShape<
  wire.BoxPayloadManifest,
  schema.BoxPayloadManifest
> = {
  version: "20260904T2130Z-9f3c1a2b",
  createdAt: 1_788_550_000_000,
  minUpdater: 2,
  files: [payloadFile],
  directories: ["rootfs/etc/s6-overlay/s6-rc.d/user2/contents.d"],
  archive: payloadArchive,
  daemon: payloadDaemon,
  restart: payloadRestart,
};

const payloadConfig: SharedShape<wire.BoxPayloadConfig, schema.BoxPayloadConfig> = {
  version: payloadManifest.version,
  manifestUrl: "https://cp.example/box-payload/v1/manifest.json",
};

const payloadResult: SharedShape<
  wire.BoxPayloadResultRequest,
  schema.BoxPayloadResultRequest
> = {
  version: payloadManifest.version,
  daemonVersion: payloadDaemon.version,
  outcome: "rolled-back",
  detail: "gateway health check failed; previous payload restored",
};

const boxConfigResponse: SharedShape<
  wire.BoxConfigResponse,
  schema.BoxConfigResponse
> = {
  boxImageRef: "ghcr.io/blitzdotdev/blitz-box:v2",
  controlPlaneOrigin: "https://cp.example",
  updateRequested: true,
  payload: payloadConfig,
};

const boxUpdateResult: SharedShape<
  wire.BoxUpdateResultRequest,
  schema.BoxUpdateResultRequest
> = { ref: boxConfigResponse.boxImageRef, outcome: "rolled-back" };

const agentRule: SharedShape<wire.AgentRuleView, schema.AgentRuleView> = {
  id: "rule",
  name: "House rules",
  content: "# House rules\n",
  updatedAt: 4,
  builtIn: false,
};

const agentRules: SharedShape<
  wire.ListAgentRulesResponse,
  schema.ListAgentRulesResponse
> = { rules: [agentRule] };

const putAgentRuleRequest: SharedShape<
  wire.PutAgentRuleRequest,
  schema.PutAgentRuleRequest
> = { name: agentRule.name, content: agentRule.content };

const putAgentRuleResponse: SharedShape<
  wire.PutAgentRuleResponse,
  schema.PutAgentRuleResponse
> = { rule: agentRule };

const recipe: SharedShape<wire.RecipeView, schema.RecipeView> = {
  id: "recipe",
  name: "nightly evals",
  templateId: "template",
  harness: "claude",
  model: "claude-sonnet-5",
  effort: "xhigh",
  prompt: "Aggregate usage and write evals.\n",
};

const recipes: SharedShape<
  wire.ListRecipesResponse,
  schema.ListRecipesResponse
> = { recipes: [recipe] };

const createRecipeRequest: SharedShape<
  wire.CreateRecipeRequest,
  schema.CreateRecipeRequest
> = {
  name: recipe.name,
  templateId: recipe.templateId,
  harness: recipe.harness,
  model: recipe.model,
  effort: recipe.effort,
  prompt: recipe.prompt,
};

const recipeResponse: SharedShape<
  wire.RecipeResponse,
  schema.RecipeResponse
> = { recipe };

const orgUsageCapture: SharedShape<
  wire.OrgUsageCaptureResponse,
  schema.OrgUsageCaptureResponse
> = { enabled: true, folderId: "folder" };

const machine: SharedShape<wire.MachineView, schema.MachineView> = {
  id: "machine",
  state: "running",
  machineTypeId: "mv-2c2g@lab",
  volumeId: volume.id,
  volumeUsedPercent: 62,
  payloadVersion: payloadManifest.version,
  daemonVersion: payloadDaemon.version,
  payloadOutcome: "rolled-back",
  payloadReportedAt: 1_700_000_004_000,
  membershipId: "membership",
  error: null,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_005_000,
};

// A machine whose guest has not reported yet answers null, which covers
// different ground than an integer does.
const unreportedMachine: SharedShape<wire.MachineView, schema.MachineView> = {
  ...machine,
  id: "machine-unreported",
  volumeUsedPercent: null,
  payloadVersion: null,
  daemonVersion: null,
  payloadOutcome: null,
  payloadReportedAt: null,
};

const machineStats: SharedShape<
  wire.MachineStatsRequest,
  schema.MachineStatsRequest
> = { diskUsedPercent: 62 };

const workspaceMember: SharedShape<
  wire.WorkspaceMemberView,
  schema.WorkspaceMemberView
> = {
  membershipId: machine.membershipId,
  name: "Owner",
  avatarUrl: null,
  role: "admin",
  machine,
};

// A viewer holds no machine, ever (plan §2.2). Null covers different ground
// than an object, so it needs its own row.
const viewerMember: SharedShape<
  wire.WorkspaceMemberView,
  schema.WorkspaceMemberView
> = {
  membershipId: "viewer-membership",
  name: "Watcher",
  avatarUrl: "https://avatars.example/watcher.png",
  role: "viewer",
  machine: null,
};

const machineResponse: SharedShape<
  wire.MachineResponse,
  schema.MachineResponse
> = { machine };

const setMachineTypeRequest: SharedShape<
  wire.SetMachineTypeRequest,
  schema.SetMachineTypeRequest
> = { machineTypeId: pricedMachineType.id };

const setMachinePayloadHoldRequest: SharedShape<
  wire.SetMachinePayloadHoldRequest,
  schema.SetMachinePayloadHoldRequest
> = { payloadHold: true };

const addWorkspaceMemberRequest: SharedShape<
  wire.AddWorkspaceMemberRequest,
  schema.AddWorkspaceMemberRequest
> = {
  membershipId: viewerMember.membershipId,
  role: "member",
  machineTypeId: pricedMachineType.id,
  persistentVolume: false,
};

const updateWorkspaceMemberRequest: SharedShape<
  wire.UpdateWorkspaceMemberRequest,
  schema.UpdateWorkspaceMemberRequest
> = { role: "viewer" };

const provisionMemberMachineRequest: SharedShape<
  wire.ProvisionMemberMachineRequest,
  schema.ProvisionMemberMachineRequest
> = { machineTypeId: pricedMachineType.id, persistentVolume: true };

// Every settings field at once. `agentRuleId` also travels as an explicit
// null — the way back to the built-in doc — which is different ground than a
// string, so it gets its own row below.
const updateWorkspaceRequest: SharedShape<
  wire.UpdateWorkspaceRequest,
  schema.UpdateWorkspaceRequest
> = {
  name: "engineering",
  defaultMachineTypeId: machineType.id,
  autoProvision: false,
  agentRuleId: "rule",
};

const clearAgentRuleRequest: SharedShape<
  wire.UpdateWorkspaceRequest,
  schema.UpdateWorkspaceRequest
> = { agentRuleId: null };

const workspaceMemberResponse: SharedShape<
  wire.WorkspaceMemberResponse,
  schema.WorkspaceMemberResponse
> = { member: workspaceMember };

// The org credential plane (plans/ORG-CREDENTIALS.md §4, §7). One row per
// grant subject kind, because null subjectId covers different ground than a
// string one.
const orgWideGrant: SharedShape<
  wire.OrgCredentialGrantView,
  schema.OrgCredentialGrantView
> = { subjectKind: "org", subjectId: null, access: "read" };

const workspaceGrant: SharedShape<
  wire.OrgCredentialGrantView,
  schema.OrgCredentialGrantView
> = { subjectKind: "workspace", subjectId: "workspace", access: "read" };

const membershipGrant: SharedShape<
  wire.OrgCredentialGrantView,
  schema.OrgCredentialGrantView
> = { subjectKind: "membership", subjectId: "membership", access: "write" };

const orgCredential: SharedShape<
  wire.OrgCredentialView,
  schema.OrgCredentialView
> = {
  id: "org-credential",
  name: "STRIPE_API_KEY",
  comment: "test-mode key, safe for CI",
  createdByMembershipId: "membership",
  createdAt: 6,
  updatedAt: 7,
  grants: [orgWideGrant, workspaceGrant, membershipGrant],
};

const listOrgCredentialsResponse: SharedShape<
  wire.ListOrgCredentialsResponse,
  schema.ListOrgCredentialsResponse
> = { credentials: [orgCredential] };

const putOrgCredentialRequest: SharedShape<
  wire.PutOrgCredentialRequest,
  schema.PutOrgCredentialRequest
> = {
  name: orgCredential.name,
  value: "sk_test_only",
  comment: "test-mode key, safe for CI",
  grants: [workspaceGrant],
};

const putOrgCredentialResponse: SharedShape<
  wire.PutOrgCredentialResponse,
  schema.PutOrgCredentialResponse
> = { credential: orgCredential };

const replaceOrgCredentialGrantsRequest: SharedShape<
  wire.ReplaceOrgCredentialGrantsRequest,
  schema.ReplaceOrgCredentialGrantsRequest
> = { grants: [orgWideGrant, membershipGrant] };

const replaceOrgCredentialGrantsResponse: SharedShape<
  wire.ReplaceOrgCredentialGrantsResponse,
  schema.ReplaceOrgCredentialGrantsResponse
> = { credential: orgCredential };

const importOrgCredentialsRequest: SharedShape<
  wire.ImportOrgCredentialsRequest,
  schema.ImportOrgCredentialsRequest
> = { text: "STRIPE_API_KEY=sk_test_only\n", dryRun: true };

const importOrgCredentialsResponse: SharedShape<
  wire.ImportOrgCredentialsResponse,
  schema.ImportOrgCredentialsResponse
> = {
  results: [
    { name: orgCredential.name, line: 1, outcome: "stored" },
    { name: "GOOGLE_SA_JSON", line: 2, outcome: "refused", reason: "empty value" },
  ],
  linesRead: 2,
};

const agentCredentialEntry: SharedShape<
  wire.AgentCredentialEntry,
  schema.AgentCredentialEntry
> = { name: "linear", scope: "connection", comment: null, writable: false };

const agentCredentialsResponse: SharedShape<
  wire.AgentCredentialsResponse,
  schema.AgentCredentialsResponse
> = {
  credentials: [
    agentCredentialEntry,
    {
      name: orgCredential.name,
      scope: "org",
      comment: orgCredential.comment,
      writable: true,
    },
  ],
};

const agentCredentialTokenResponse: SharedShape<
  wire.AgentCredentialTokenResponse,
  schema.AgentCredentialTokenResponse
> = {
  name: orgCredential.name,
  scope: "org",
  token: "sk_test_only",
  env: [{ name: orgCredential.name, value: "sk_test_only" }],
};

const putAgentCredentialRequest: SharedShape<
  wire.PutAgentCredentialRequest,
  schema.PutAgentCredentialRequest
> = { value: "sk_test_only", comment: "test-mode key, safe for CI" };

const credentialRequestFiledError: SharedShape<
  wire.CredentialRequestFiledError,
  schema.CredentialRequestFiledError
> = { error: "connection linear is not configured", request_id: "request" };

// Grant proposals (§7a). One row per action, and a null-subject change,
// because each covers ground the others do not.
const addGrantChange: SharedShape<wire.GrantChange, schema.GrantChange> = {
  name: orgCredential.name,
  action: "add",
  subjectKind: "workspace",
  subjectId: "workspace",
  access: "read",
};

const removeGrantChange: SharedShape<wire.GrantChange, schema.GrantChange> = {
  name: orgCredential.name,
  action: "remove",
  subjectKind: "org",
  subjectId: null,
  access: "write",
};

const proposeGrantChangesRequest: SharedShape<
  wire.ProposeGrantChangesRequest,
  schema.ProposeGrantChangesRequest
> = { changes: [addGrantChange, removeGrantChange], reason: "the CI workspace needs it" };

const proposeGrantChangesResponse: SharedShape<
  wire.ProposeGrantChangesResponse,
  schema.ProposeGrantChangesResponse
> = { id: "proposal", state: "pending" };

const pendingGrantProposal: SharedShape<
  wire.GrantProposalView,
  schema.GrantProposalView
> = {
  id: "proposal",
  state: "pending",
  machineId: "machine",
  membershipId: "membership",
  reason: "the CI workspace needs it",
  proposed: [addGrantChange, removeGrantChange],
  applied: null,
  createdAt: 9,
};

const approvedGrantProposal: SharedShape<
  wire.GrantProposalView,
  schema.GrantProposalView
> = { ...pendingGrantProposal, state: "approved", applied: [addGrantChange] };

const listGrantProposalsResponse: SharedShape<
  wire.ListGrantProposalsResponse,
  schema.ListGrantProposalsResponse
> = { proposals: [pendingGrantProposal] };

const resolveGrantProposalRequest: SharedShape<
  wire.ResolveGrantProposalRequest,
  schema.ResolveGrantProposalRequest
> = { approve: true, changes: [addGrantChange] };

const resolveGrantProposalResponse: SharedShape<
  wire.ResolveGrantProposalResponse,
  schema.ResolveGrantProposalResponse
> = { proposal: approvedGrantProposal };

const workspace: SharedShape<wire.WorkspaceView, schema.WorkspaceView> = {
  id: "workspace",
  name: "brave-otter",
  machineTypeId: "mv-2c2g@lab",
  phase: "ready",
  retryAction: null,
  canObserve: true,
  launchable: true,
  revision: 3,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_005_000,
  ssh: {
    host: "203.0.113.10",
    port: 22,
    user: "blitz",
    hostPublicKey: "ssh-ed25519 AAAAhost",
  },
  volumeId: volume.id,
  error: null,
  role: "owner",
  owner: { name: "Owner", avatarUrl: null },
  agentRuleId: agentRule.id,
  connections: ["linear"],
  recipeId: recipe.id,
  orgId: "org",
  ownerMembershipId: workspaceMember.membershipId,
  defaultMachineTypeId: machineType.id,
  autoProvision: true,
  myRole: "admin",
  members: [workspaceMember, viewerMember],
};

const templateConnection: SharedShape<
  wire.TemplateConnectionView,
  schema.TemplateConnectionView
> = { provider: "linear" };

const templateRepo: SharedShape<
  wire.TemplateRepoView,
  schema.TemplateRepoView
> = { repo: "blitzdotdev/blitz-core", private: true };

const addWorkspaceRepoRequest: SharedShape<
  wire.AddWorkspaceRepoRequest,
  schema.AddWorkspaceRepoRequest
> = { repo: templateRepo.repo };

const listWorkspaceReposResponse: SharedShape<
  wire.ListWorkspaceReposResponse,
  schema.ListWorkspaceReposResponse
> = { repos: [templateRepo] };

const sessionShare: SharedShape<
  wire.SessionShareView,
  schema.SessionShareView
> = {
  id: "share-1",
  sessionId: "sess-abc",
  ownerMembershipId: "membership-owner",
  granteeMembershipId: "membership-grantee",
  level: "rw",
  createdAt: 1_788_000_000_000,
  createdByMembershipId: "membership-owner",
};

const listSessionSharesResponse: SharedShape<
  wire.ListSessionSharesResponse,
  schema.ListSessionSharesResponse
> = { granted: [sessionShare], received: [sessionShare] };

const grantSessionShareRequest: SharedShape<
  wire.GrantSessionShareRequest,
  schema.GrantSessionShareRequest
> = {
  sessionId: sessionShare.sessionId,
  granteeMembershipId: sessionShare.granteeMembershipId,
  level: "ro",
  ownerMembershipId: sessionShare.ownerMembershipId,
};

const githubInstallation: SharedShape<
  wire.GithubInstallationView,
  schema.GithubInstallationView
> = {
  id: 42,
  accountLogin: "blitzdotdev",
  accountType: "Organization",
  repositorySelection: "selected",
};

const listGithubInstallations: SharedShape<
  wire.ListGithubInstallationsResponse,
  schema.ListGithubInstallationsResponse
> = { installations: [githubInstallation] };

const githubRepository: SharedShape<
  wire.GithubRepositoryView,
  schema.GithubRepositoryView
> = { repo: templateRepo.repo, accountLogin: "blitzdotdev", private: true };

const listGithubRepositories: SharedShape<
  wire.ListGithubRepositoriesResponse,
  schema.ListGithubRepositoriesResponse
> = { repositories: [githubRepository], truncated: false };

const githubRepositoryCheck: SharedShape<
  wire.GithubRepositoryCheckView,
  schema.GithubRepositoryCheckView
> = { repo: "blitzdotdev/blitz-core", verdict: "private-reachable" };

const checkGithubRepositoriesRequest: SharedShape<
  wire.CheckGithubRepositoriesRequest,
  schema.CheckGithubRepositoriesRequest
> = { repos: [githubRepositoryCheck.repo] };

const checkGithubRepositoriesResponse: SharedShape<
  wire.CheckGithubRepositoriesResponse,
  schema.CheckGithubRepositoriesResponse
> = { results: [githubRepositoryCheck] };

const workspaceTemplate: SharedShape<
  wire.WorkspaceTemplateView,
  schema.WorkspaceTemplateView
> = {
  id: "template",
  name: "web analysis",
  machineTypeId: "mv-2c2g@lab",
  createdAt: 1,
  createdBy: { name: "Owner", avatarUrl: null },
  environment,
  agentRuleId: agentRule.id,
  isOrgDefault: true,
  folders: [{ id: "folder", name: "Shared", role: "editor" }],
  connections: [templateConnection],
  repos: [templateRepo],
};

const workspaceTemplates: SharedShape<
  wire.ListWorkspaceTemplatesResponse,
  schema.ListWorkspaceTemplatesResponse
> = { templates: [workspaceTemplate] };

const createWorkspaceTemplate: SharedShape<
  wire.CreateWorkspaceTemplateRequest,
  schema.CreateWorkspaceTemplateRequest
> = {
  name: "web analysis",
  machineTypeId: "mv-2c2g@lab",
  folderIds: ["folder"],
  connections: [templateConnection],
  environment,
  agentRuleId: agentRule.id,
  repos: [templateRepo.repo],
  isOrgDefault: true,
};

const createdWorkspaceTemplate: SharedShape<
  wire.CreateWorkspaceTemplateResponse,
  schema.CreateWorkspaceTemplateResponse
> = { template: workspaceTemplate };

const listMachineTypesResponse: SharedShape<
  wire.ListMachineTypesResponse,
  schema.ListMachineTypesResponse
> = {
  machineTypes: [machineType],
  failures: [machineTypeFailure],
};

const createWorkspaceRequest: SharedShape<
  wire.CreateWorkspaceRequest,
  schema.CreateWorkspaceRequest
> = {
  machineTypeId: machineType.id,
  defaultMachineTypeId: machineType.id,
  autoProvision: false,
  members: [{
    membershipId: viewerMember.membershipId,
    role: "member",
    machineTypeId: machineType.id,
    persistentVolume: false,
  }],
  cloneFromWorkspaceId: "workspace",
  volumeId: volume.id,
  userData: "#cloud-config\n",
  manifest: {
    integrations: {
      github: { scopes: ["contents:read"] },
    },
  },
  connections: ["github"],
  agentRuleId: agentRule.id,
  repos: [templateRepo.repo],
};

const createWorkspaceResponse: SharedShape<
  wire.CreateWorkspaceResponse,
  schema.CreateWorkspaceResponse
> = { workspace };

const pollResponse: SharedShape<wire.PollResponse, schema.PollResponse> = {
  workspaces: [workspace],
};

const registerKeysResponse: SharedShape<
  wire.RegisterKeysResponse,
  schema.RegisterKeysResponse
> = {
  memberUnixName: "operator",
  broker: {
    host: "broker.example",
    port: 2222,
    sshHostPublicKey: "ssh-ed25519 AAAAbroker",
  },
};

const apiError: SharedShape<wire.ApiError, schema.ApiError> = {
  error: "workspace is still creating",
  retryAction: "poll",
};

// The seat refusal is the one error that carries a way out, so the optional
// field needs a row of its own: an absent field covers different ground than
// a present one.
const seatLimitError: SharedShape<wire.ApiError, schema.ApiError> = {
  error: "seat limit reached",
  retryAction: "upgrade",
  paymentUrl: "https://billing.example/checkout#token=header.payload.signature",
};

const entitlementsRequest: SharedShape<
  wire.EntitlementsRequest,
  schema.EntitlementsRequest
> = { seatLimit: 3, vmLimit: 10, platformCompute: true };

const orgUsage: SharedShape<wire.OrgUsageResponse, schema.OrgUsageResponse> = {
  seatsUsed: 2,
  seatLimit: 3,
  vmsUsed: 1,
  vmLimit: 10,
  platformCompute: true,
};

// No billing service attached: a null cap is a different field than a number.
const uncappedOrgUsage: SharedShape<wire.OrgUsageResponse, schema.OrgUsageResponse> = {
  ...orgUsage,
  seatLimit: null,
};

const orgBilling: SharedShape<wire.OrgBillingResponse, schema.OrgBillingResponse> = {
  url: "https://billing.example/checkout#token=header.payload.signature",
};

const createVolumeRequest: SharedShape<
  wire.CreateVolumeRequest,
  schema.CreateVolumeRequest
> = {
  name: volume.name,
  sizeGb: volume.sizeGb,
  location: volume.location,
};

const createVolumeResponse: SharedShape<
  wire.CreateVolumeResponse,
  schema.CreateVolumeResponse
> = { volume };

const listVolumesResponse: SharedShape<
  wire.ListVolumesResponse,
  schema.ListVolumesResponse
> = { volumes: [volume] };

const deleteVolumeResponse: SharedShape<
  wire.DeleteVolumeResponse,
  schema.DeleteVolumeResponse
> = { id: volume.id };

const feedKey: SharedShape<wire.FeedKey, schema.FeedKey> = {
  pubkey: "ssh-ed25519 AAAAkey",
  op: "mint",
};

const feedMember: SharedShape<wire.FeedMember, schema.FeedMember> = {
  unixName: "operator",
  harnesses: ["claude", "codex"],
  keys: [feedKey],
};

const feedResponse: SharedShape<wire.FeedResponse, schema.FeedResponse> = {
  version: "version",
  members: [feedMember],
};

const folderGrant: SharedShape<wire.FolderGrantView, schema.FolderGrantView> = {
  id: "grant",
  membershipId: "member",
  role: "editor",
  createdAt: 1,
  member: { name: "Editor", email: "editor@example.com", avatarUrl: null },
};

const folder: SharedShape<wire.FolderView, schema.FolderView> = {
  id: "folder",
  name: "Shared",
  role: "owner",
  orgRole: "viewer",
  owner: { name: "Owner", avatarUrl: null },
  attachedWorkspaceIds: ["workspace"],
  createdAt: 1,
  updatedAt: 2,
  grants: [folderGrant],
};

const folderObject: SharedShape<wire.FolderObjectView, schema.FolderObjectView> = {
  key: "notes/today.txt",
  size: 12,
  mtime: 1,
  editedBy: "Editor",
};

const folderObjects: SharedShape<
  wire.ListFolderObjectsResponse,
  schema.ListFolderObjectsResponse
> = { objects: [folderObject], cursor: null, truncated: false };

const folderAttachment: SharedShape<
  wire.FolderAttachmentView,
  schema.FolderAttachmentView
> = {
  id: "folder",
  name: "Shared",
  guestPath: null,
  role: "editor",
  attachedAt: 3,
};

const folderAttachments: SharedShape<
  wire.ListFolderAttachmentsResponse,
  schema.ListFolderAttachmentsResponse
> = { folders: [folderAttachment] };

// The credential module keeps its own copy of the same views in
// core/connections/types.ts. It is the second hand-mirrored wire in the
// repository and had no drift coverage at all, which is how MintResult grew a
// fifth key on one side only.
const catalogAdminForm: SharedShape<
  connections.CatalogAdminFormView,
  schema.CatalogAdminFormView
> = {
  rootLabel: "Permanent token",
  rootHelp: "Create it in the vendor's own settings.",
  placements: [
    { kind: "env", name: "VENDOR_TOKEN", fill: "token" },
    { kind: "env", name: "VENDOR_BASE_URL", fill: "proxy-url" },
  ],
};

const catalogEntry: SharedShape<
  connections.CatalogEntryView,
  schema.CatalogEntryView
> = {
  id: "linear",
  title: "Linear",
  summary: "Issues, projects, and comments through one GraphQL endpoint.",
  custody: "proxy",
  oauthAvailable: true,
  oauthConfigured: false,
  personalTokenLabel: "Personal API key",
  personalTokenFallbackOnly: false,
  personalTokenHelp: "Create it in Linear's own settings.",
  personalTokenBaseUrlLabel: null,
  adminForm: catalogAdminForm,
};

const userGrant: SharedShape<connections.UserGrantView, schema.UserGrantView> = {
  provider: "linear",
  manifestId: "linear",
  kind: "pat",
  label: "work",
  scopes: ["read"],
  createdAt: 1,
  updatedAt: 2,
  accessExpiresAt: null,
};

const providerHealth: SharedShape<
  connections.ProviderHealthView,
  schema.ProviderHealthView
> = {
  provider: "linear",
  state: "healthy",
  detail: null,
  checkedAt: 3,
  latencyMs: 120,
};

const connectionView: SharedShape<
  connections.ConnectionView,
  schema.ConnectionView
> = {
  name: "linear",
  provider: "linear",
  kind: "static",
  custody: "proxy",
  status: "active",
  createdBy: "operator",
  proxyBaseUrl: "https://tracker.example",
};

const credentialLease: SharedShape<
  connections.Lease,
  schema.CredentialLeaseView
> = {
  id: "lease",
  workspaceId: "workspace",
  boxId: "box",
  connection: "linear",
  userId: "operator",
  scopes: ["read"],
  mode: "proxy",
  issuedAt: 1,
  expiresAt: 2,
  state: "active",
};

/** The box pull wire: exactly these keys, on both sides. */
const mintResult: SharedShape<connections.MintResult, schema.MintResult> = {
  connection: "linear",
  mode: "proxy",
  token: "lease-token",
  env: [{ name: "LINEAR_API_KEY", value: "lease-token" }],
  header: { name: "Authorization", prefix: "Bearer " },
  expiresAt: 4,
};

const catalogResponse: schema.ListCatalogResponse = { providers: [catalogEntry] };
const userGrantsResponse: schema.ListUserGrantsResponse = { grants: [userGrant] };
const providerHealthResponse: schema.ListProviderHealthResponse = {
  providers: [providerHealth],
};
const credentialLeasesResponse: schema.ListCredentialLeasesResponse = {
  leases: [credentialLease],
};
const connectionsResponse: SharedShape<
  connections.ListConnectionsResponse,
  schema.ListConnectionsResponse
> = { connections: [connectionView] };

const fullFieldValues = [
  machine,
  unreportedMachine,
  machineStats,
  workspaceMember,
  viewerMember,
  machineResponse,
  setMachinePayloadHoldRequest,
  setMachineTypeRequest,
  addWorkspaceMemberRequest,
  updateWorkspaceMemberRequest,
  provisionMemberMachineRequest,
  updateWorkspaceRequest,
  clearAgentRuleRequest,
  workspaceMemberResponse,
  orgWideGrant,
  workspaceGrant,
  membershipGrant,
  orgCredential,
  listOrgCredentialsResponse,
  putOrgCredentialRequest,
  putOrgCredentialResponse,
  replaceOrgCredentialGrantsRequest,
  replaceOrgCredentialGrantsResponse,
  importOrgCredentialsRequest,
  importOrgCredentialsResponse,
  agentCredentialEntry,
  agentCredentialsResponse,
  agentCredentialTokenResponse,
  putAgentCredentialRequest,
  credentialRequestFiledError,
  addGrantChange,
  removeGrantChange,
  proposeGrantChangesRequest,
  proposeGrantChangesResponse,
  pendingGrantProposal,
  approvedGrantProposal,
  listGrantProposalsResponse,
  resolveGrantProposalRequest,
  resolveGrantProposalResponse,
  machineType,
  pricedMachineType,
  machineTypeFailure,
  volume,
  environment,
  environmentResponse,
  agentRulesResponse,
  payloadFile,
  payloadArchive,
  payloadDaemon,
  payloadRestart,
  payloadManifest,
  payloadConfig,
  payloadResult,
  boxConfigResponse,
  boxUpdateResult,
  agentRule,
  agentRules,
  putAgentRuleRequest,
  putAgentRuleResponse,
  workspace,
  templateConnection,
  templateRepo,
  addWorkspaceRepoRequest,
  listWorkspaceReposResponse,
  sessionShare,
  listSessionSharesResponse,
  grantSessionShareRequest,
  githubInstallation,
  listGithubInstallations,
  githubRepository,
  listGithubRepositories,
  githubRepositoryCheck,
  checkGithubRepositoriesRequest,
  checkGithubRepositoriesResponse,
  workspaceTemplate,
  workspaceTemplates,
  createWorkspaceTemplate,
  createdWorkspaceTemplate,
  recipe,
  recipes,
  createRecipeRequest,
  recipeResponse,
  orgUsageCapture,
  listMachineTypesResponse,
  createWorkspaceRequest,
  createWorkspaceResponse,
  pollResponse,
  registerKeysResponse,
  apiError,
  seatLimitError,
  entitlementsRequest,
  orgUsage,
  uncappedOrgUsage,
  orgBilling,
  createVolumeRequest,
  createVolumeResponse,
  listVolumesResponse,
  deleteVolumeResponse,
  feedKey,
  feedMember,
  feedResponse,
  folderGrant,
  folder,
  folderObject,
  folderObjects,
  folderAttachment,
  folderAttachments,
  catalogAdminForm,
  catalogEntry,
  userGrant,
  providerHealth,
  connectionView,
  credentialLease,
  mintResult,
  catalogResponse,
  userGrantsResponse,
  providerHealthResponse,
  credentialLeasesResponse,
  connectionsResponse,
];

describe("local wire copies", () => {
  it("keeps every duplicated type exactly equal to @blitzos/schema", () => {
    expectTypeOf<wire.Phase>().toEqualTypeOf<schema.Phase>();
    expectTypeOf<wire.RetryAction>().toEqualTypeOf<schema.RetryAction>();
    expectTypeOf<wire.WorkspaceRole>().toEqualTypeOf<schema.WorkspaceRole>();
    expectTypeOf<wire.WorkspaceMemberRole>().toEqualTypeOf<schema.WorkspaceMemberRole>();
    expectTypeOf<wire.MachineState>().toEqualTypeOf<schema.MachineState>();
    expectTypeOf<wire.MachineView>().toEqualTypeOf<schema.MachineView>();
    expectTypeOf<wire.MachineStatsRequest>().toEqualTypeOf<schema.MachineStatsRequest>();
    expectTypeOf<wire.MachineResponse>().toEqualTypeOf<schema.MachineResponse>();
    expectTypeOf<wire.SetMachinePayloadHoldRequest>()
      .toEqualTypeOf<schema.SetMachinePayloadHoldRequest>();
    expectTypeOf<wire.SetMachineTypeRequest>().toEqualTypeOf<schema.SetMachineTypeRequest>();
    expectTypeOf<wire.WorkspaceMemberView>().toEqualTypeOf<schema.WorkspaceMemberView>();
    expectTypeOf<wire.AddWorkspaceMemberRequest>().toEqualTypeOf<schema.AddWorkspaceMemberRequest>();
    expectTypeOf<wire.UpdateWorkspaceMemberRequest>().toEqualTypeOf<schema.UpdateWorkspaceMemberRequest>();
    expectTypeOf<wire.ProvisionMemberMachineRequest>().toEqualTypeOf<schema.ProvisionMemberMachineRequest>();
    expectTypeOf<wire.UpdateWorkspaceRequest>().toEqualTypeOf<schema.UpdateWorkspaceRequest>();
    expectTypeOf<wire.WorkspaceMemberResponse>().toEqualTypeOf<schema.WorkspaceMemberResponse>();
    expectTypeOf<wire.OrgCredentialGrantSubjectKind>().toEqualTypeOf<schema.OrgCredentialGrantSubjectKind>();
    expectTypeOf<wire.OrgCredentialAccess>().toEqualTypeOf<schema.OrgCredentialAccess>();
    expectTypeOf<wire.OrgCredentialGrantView>().toEqualTypeOf<schema.OrgCredentialGrantView>();
    expectTypeOf<wire.OrgCredentialView>().toEqualTypeOf<schema.OrgCredentialView>();
    expectTypeOf<wire.ListOrgCredentialsResponse>().toEqualTypeOf<schema.ListOrgCredentialsResponse>();
    expectTypeOf<wire.PutOrgCredentialRequest>().toEqualTypeOf<schema.PutOrgCredentialRequest>();
    expectTypeOf<wire.PutOrgCredentialResponse>().toEqualTypeOf<schema.PutOrgCredentialResponse>();
    expectTypeOf<wire.ReplaceOrgCredentialGrantsRequest>().toEqualTypeOf<schema.ReplaceOrgCredentialGrantsRequest>();
    expectTypeOf<wire.ReplaceOrgCredentialGrantsResponse>().toEqualTypeOf<schema.ReplaceOrgCredentialGrantsResponse>();
    expectTypeOf<wire.ImportOrgCredentialsRequest>().toEqualTypeOf<schema.ImportOrgCredentialsRequest>();
    expectTypeOf<wire.OrgCredentialImportResult>().toEqualTypeOf<schema.OrgCredentialImportResult>();
    expectTypeOf<wire.ImportOrgCredentialsResponse>().toEqualTypeOf<schema.ImportOrgCredentialsResponse>();
    expectTypeOf<wire.AgentCredentialScope>().toEqualTypeOf<schema.AgentCredentialScope>();
    expectTypeOf<wire.AgentCredentialEntry>().toEqualTypeOf<schema.AgentCredentialEntry>();
    expectTypeOf<wire.AgentCredentialsResponse>().toEqualTypeOf<schema.AgentCredentialsResponse>();
    expectTypeOf<wire.AgentCredentialTokenResponse>().toEqualTypeOf<schema.AgentCredentialTokenResponse>();
    expectTypeOf<wire.PutAgentCredentialRequest>().toEqualTypeOf<schema.PutAgentCredentialRequest>();
    expectTypeOf<wire.GrantChangeAction>().toEqualTypeOf<schema.GrantChangeAction>();
    expectTypeOf<wire.GrantChange>().toEqualTypeOf<schema.GrantChange>();
    expectTypeOf<wire.ProposeGrantChangesRequest>().toEqualTypeOf<schema.ProposeGrantChangesRequest>();
    expectTypeOf<wire.GrantProposalState>().toEqualTypeOf<schema.GrantProposalState>();
    expectTypeOf<wire.ProposeGrantChangesResponse>().toEqualTypeOf<schema.ProposeGrantChangesResponse>();
    expectTypeOf<wire.GrantProposalView>().toEqualTypeOf<schema.GrantProposalView>();
    expectTypeOf<wire.ListGrantProposalsResponse>().toEqualTypeOf<schema.ListGrantProposalsResponse>();
    expectTypeOf<wire.ResolveGrantProposalRequest>().toEqualTypeOf<schema.ResolveGrantProposalRequest>();
    expectTypeOf<wire.ResolveGrantProposalResponse>().toEqualTypeOf<schema.ResolveGrantProposalResponse>();
    expectTypeOf<wire.MachinePrice>().toEqualTypeOf<schema.MachinePrice>();
    expectTypeOf<wire.MachineType>().toEqualTypeOf<schema.MachineType>();
    expectTypeOf<wire.MachineTypeProviderFailure>().toEqualTypeOf<schema.MachineTypeProviderFailure>();
    expectTypeOf<wire.Volume>().toEqualTypeOf<schema.Volume>();
    expectTypeOf<wire.WorkspaceEnvironment>().toEqualTypeOf<schema.WorkspaceEnvironment>();
    expectTypeOf<wire.WorkspaceEnvironmentResponse>().toEqualTypeOf<schema.WorkspaceEnvironmentResponse>();
    expectTypeOf<wire.AgentRulesResponse>().toEqualTypeOf<schema.AgentRulesResponse>();
    expectTypeOf<wire.BoxPayloadFile>().toEqualTypeOf<schema.BoxPayloadFile>();
    expectTypeOf<wire.BoxPayloadArchive>().toEqualTypeOf<schema.BoxPayloadArchive>();
    expectTypeOf<wire.BoxPayloadDaemonArchive>()
      .toEqualTypeOf<schema.BoxPayloadDaemonArchive>();
    expectTypeOf<wire.BoxPayloadRestart>().toEqualTypeOf<schema.BoxPayloadRestart>();
    expectTypeOf<wire.BoxPayloadManifest>().toEqualTypeOf<schema.BoxPayloadManifest>();
    expectTypeOf<wire.BoxPayloadConfig>().toEqualTypeOf<schema.BoxPayloadConfig>();
    expectTypeOf<wire.BoxPayloadOutcome>().toEqualTypeOf<schema.BoxPayloadOutcome>();
    expectTypeOf<wire.BoxPayloadResultRequest>()
      .toEqualTypeOf<schema.BoxPayloadResultRequest>();
    expectTypeOf<wire.BoxConfigResponse>().toEqualTypeOf<schema.BoxConfigResponse>();
    expectTypeOf<wire.BoxUpdateOutcome>().toEqualTypeOf<schema.BoxUpdateOutcome>();
    expectTypeOf<wire.BoxUpdateResultRequest>().toEqualTypeOf<schema.BoxUpdateResultRequest>();
    expectTypeOf<wire.AgentRuleView>().toEqualTypeOf<schema.AgentRuleView>();
    expectTypeOf<wire.ListAgentRulesResponse>().toEqualTypeOf<schema.ListAgentRulesResponse>();
    expectTypeOf<wire.PutAgentRuleRequest>().toEqualTypeOf<schema.PutAgentRuleRequest>();
    expectTypeOf<wire.PutAgentRuleResponse>().toEqualTypeOf<schema.PutAgentRuleResponse>();
    expectTypeOf<wire.WorkspaceView>().toEqualTypeOf<schema.WorkspaceView>();
    expectTypeOf<wire.TemplateConnectionView>().toEqualTypeOf<schema.TemplateConnectionView>();
    expectTypeOf<wire.TemplateRepoView>().toEqualTypeOf<schema.TemplateRepoView>();
    expectTypeOf<wire.AddWorkspaceRepoRequest>().toEqualTypeOf<schema.AddWorkspaceRepoRequest>();
    expectTypeOf<wire.ListWorkspaceReposResponse>().toEqualTypeOf<schema.ListWorkspaceReposResponse>();
    expectTypeOf<wire.SessionShareLevel>().toEqualTypeOf<schema.SessionShareLevel>();
    expectTypeOf<wire.SessionShareView>().toEqualTypeOf<schema.SessionShareView>();
    expectTypeOf<wire.ListSessionSharesResponse>().toEqualTypeOf<schema.ListSessionSharesResponse>();
    expectTypeOf<wire.GrantSessionShareRequest>().toEqualTypeOf<schema.GrantSessionShareRequest>();
    expectTypeOf<wire.GithubInstallationView>().toEqualTypeOf<schema.GithubInstallationView>();
    expectTypeOf<wire.ListGithubInstallationsResponse>().toEqualTypeOf<schema.ListGithubInstallationsResponse>();
    expectTypeOf<wire.GithubRepositoryView>().toEqualTypeOf<schema.GithubRepositoryView>();
    expectTypeOf<wire.ListGithubRepositoriesResponse>().toEqualTypeOf<schema.ListGithubRepositoriesResponse>();
    expectTypeOf<wire.GithubRepositoryCheckVerdict>().toEqualTypeOf<schema.GithubRepositoryCheckVerdict>();
    expectTypeOf<wire.GithubRepositoryCheckView>().toEqualTypeOf<schema.GithubRepositoryCheckView>();
    expectTypeOf<wire.CheckGithubRepositoriesRequest>().toEqualTypeOf<schema.CheckGithubRepositoriesRequest>();
    expectTypeOf<wire.CheckGithubRepositoriesResponse>().toEqualTypeOf<schema.CheckGithubRepositoriesResponse>();
    expectTypeOf<wire.WorkspaceTemplateView>().toEqualTypeOf<schema.WorkspaceTemplateView>();
    expectTypeOf<wire.ListWorkspaceTemplatesResponse>().toEqualTypeOf<schema.ListWorkspaceTemplatesResponse>();
    expectTypeOf<wire.CreateWorkspaceTemplateRequest>().toEqualTypeOf<schema.CreateWorkspaceTemplateRequest>();
    expectTypeOf<wire.CreateWorkspaceTemplateResponse>().toEqualTypeOf<schema.CreateWorkspaceTemplateResponse>();
    expectTypeOf<wire.AgentProvider>().toEqualTypeOf<schema.AgentProvider>();
    expectTypeOf<wire.RecipeHarness>().toEqualTypeOf<schema.RecipeHarness>();
    expectTypeOf<wire.RecipeView>().toEqualTypeOf<schema.RecipeView>();
    expectTypeOf<wire.ListRecipesResponse>().toEqualTypeOf<schema.ListRecipesResponse>();
    expectTypeOf<wire.CreateRecipeRequest>().toEqualTypeOf<schema.CreateRecipeRequest>();
    expectTypeOf<wire.RecipeResponse>().toEqualTypeOf<schema.RecipeResponse>();
    expectTypeOf<wire.OrgUsageCaptureResponse>().toEqualTypeOf<schema.OrgUsageCaptureResponse>();
    expectTypeOf<wire.ListMachineTypesResponse>().toEqualTypeOf<schema.ListMachineTypesResponse>();
    expectTypeOf<wire.CreateWorkspaceRequest>().toEqualTypeOf<schema.CreateWorkspaceRequest>();
    expectTypeOf<wire.CreateWorkspaceResponse>().toEqualTypeOf<schema.CreateWorkspaceResponse>();
    expectTypeOf<wire.PollResponse>().toEqualTypeOf<schema.PollResponse>();
    expectTypeOf<wire.RegisterKeysResponse>().toEqualTypeOf<schema.RegisterKeysResponse>();
    expectTypeOf<wire.ApiError>().toEqualTypeOf<schema.ApiError>();
    expectTypeOf<wire.EntitlementsRequest>().toEqualTypeOf<schema.EntitlementsRequest>();
    expectTypeOf<wire.OrgUsageResponse>().toEqualTypeOf<schema.OrgUsageResponse>();
    expectTypeOf<wire.OrgBillingResponse>().toEqualTypeOf<schema.OrgBillingResponse>();
    expectTypeOf<wire.CreateVolumeRequest>().toEqualTypeOf<schema.CreateVolumeRequest>();
    expectTypeOf<wire.CreateVolumeResponse>().toEqualTypeOf<schema.CreateVolumeResponse>();
    expectTypeOf<wire.ListVolumesResponse>().toEqualTypeOf<schema.ListVolumesResponse>();
    expectTypeOf<wire.DeleteVolumeResponse>().toEqualTypeOf<schema.DeleteVolumeResponse>();
    expectTypeOf<wire.FeedResponse>().toEqualTypeOf<schema.FeedResponse>();
    expectTypeOf<wire.FeedMember>().toEqualTypeOf<schema.FeedMember>();
    expectTypeOf<wire.FeedKey>().toEqualTypeOf<schema.FeedKey>();
    expectTypeOf<wire.FolderRole>().toEqualTypeOf<schema.FolderRole>();
    expectTypeOf<wire.FolderGrantView>().toEqualTypeOf<schema.FolderGrantView>();
    expectTypeOf<wire.FolderView>().toEqualTypeOf<schema.FolderView>();
    expectTypeOf<wire.FolderObjectView>().toEqualTypeOf<schema.FolderObjectView>();
    expectTypeOf<wire.ListFolderObjectsResponse>().toEqualTypeOf<schema.ListFolderObjectsResponse>();
    expectTypeOf<wire.FolderAttachmentView>().toEqualTypeOf<schema.FolderAttachmentView>();
    expectTypeOf<wire.ListFolderAttachmentsResponse>().toEqualTypeOf<schema.ListFolderAttachmentsResponse>();
  });

  it("keeps the credential module's copies exactly equal to @blitzos/schema", () => {
    expectTypeOf<connections.MintKind>().toEqualTypeOf<schema.MintKind>();
    expectTypeOf<connections.Custody>().toEqualTypeOf<schema.Custody>();
    expectTypeOf<connections.TokenHeader>().toEqualTypeOf<schema.TokenHeader>();
    expectTypeOf<connections.ConnectionEnv>().toEqualTypeOf<schema.ConnectionEnv>();
    expectTypeOf<connections.MintResult>().toEqualTypeOf<schema.MintResult>();
    expectTypeOf<connections.Lease>().toEqualTypeOf<schema.CredentialLeaseView>();
    expectTypeOf<connections.CatalogAdminPlacement>().toEqualTypeOf<schema.CatalogAdminPlacement>();
    expectTypeOf<connections.CatalogAdminFormView>().toEqualTypeOf<schema.CatalogAdminFormView>();
    expectTypeOf<connections.CatalogEntryView>().toEqualTypeOf<schema.CatalogEntryView>();
    expectTypeOf<connections.UserGrantView>().toEqualTypeOf<schema.UserGrantView>();
    expectTypeOf<connections.ProviderHealthView>().toEqualTypeOf<schema.ProviderHealthView>();
    expectTypeOf<connections.ConnectionView>().toEqualTypeOf<schema.ConnectionView>();
    expectTypeOf<connections.ListConnectionsResponse>()
      .toEqualTypeOf<schema.ListConnectionsResponse>();
  });

  it("keeps every duplicated constant and every field-bearing JSON shape covered", () => {
    expect(wire.FEED_MAX_BYTES).toBe(schema.FEED_MAX_BYTES);
    expect(wire.HARNESSES).toEqual(schema.HARNESSES);
    expect(wire.RECIPE_HARNESSES).toEqual(schema.RECIPE_HARNESSES);
    expect(wire.AGENT_PROVIDERS).toEqual(schema.AGENT_PROVIDERS);
    expect(wire.AGENT_MODELS).toEqual(schema.AGENT_MODELS);
    expect(wire.AGENT_EFFORTS).toEqual(schema.AGENT_EFFORTS);
    expect(wire.AGENT_MODEL_EFFORTS).toEqual(schema.AGENT_MODEL_EFFORTS);
    // The helper too: same effective list for every catalog model and for the
    // absent-model (provider base) case, on both sides.
    for (const provider of schema.AGENT_PROVIDERS) {
      expect(wire.agentEffortsForModel(provider)).toEqual(schema.agentEffortsForModel(provider));
      for (const model of schema.AGENT_MODELS[provider]) {
        expect(wire.agentEffortsForModel(provider, model))
          .toEqual(schema.agentEffortsForModel(provider, model));
      }
    }
    expect(wire.BOX_UPDATE_OUTCOMES).toEqual(schema.BOX_UPDATE_OUTCOMES);
    expect(wire.BOX_PAYLOAD_OUTCOMES).toEqual(schema.BOX_PAYLOAD_OUTCOMES);
    expect(wire.PHASES).toEqual(schema.PHASES);
    expect(wire.WORKSPACE_MEMBER_ROLES).toEqual(schema.WORKSPACE_MEMBER_ROLES);
    expect(wire.MACHINE_STATES).toEqual(schema.MACHINE_STATES);
    expect(wire.RETRY_ACTIONS).toEqual(schema.RETRY_ACTIONS);
    expect(wire.PHASE_TRANSITIONS).toEqual(schema.PHASE_TRANSITIONS);
    expect(wire.INVITE_TTL_DAYS).toBe(schema.INVITE_TTL_DAYS);
    expect(wire.FILES_MULTIPART_CHUNK_BYTES).toBe(schema.FILES_MULTIPART_CHUNK_BYTES);
    for (const value of fullFieldValues) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });
});
