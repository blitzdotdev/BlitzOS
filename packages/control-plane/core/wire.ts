import type { BoxPayloadConfig } from "./wire-box-payload.js";

export * from "./wire-box-payload.js";

export const FEED_MAX_BYTES = 1_048_576;
export const HARNESSES = ["claude", "codex"] as const;
export const FILES_MULTIPART_CHUNK_BYTES = 32 * 1024 * 1024;

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type FolderRole = "owner" | "admin" | "editor" | "viewer";

export interface FolderGrantView {
  id: string;
  membershipId: string;
  role: "editor" | "viewer";
  createdAt: number;
  member: { name: string; email: string; avatarUrl: string | null };
}

export interface FolderView {
  id: string;
  name: string;
  role: FolderRole | null;
  orgRole: "editor" | "viewer" | null;
  owner: { name: string; avatarUrl: string | null };
  attachedWorkspaceIds: string[];
  createdAt: number;
  updatedAt: number;
  grants?: FolderGrantView[];
}

export interface FolderObjectView {
  key: string;
  size: number;
  mtime: number;
  editedBy: string;
}

export interface ListFolderObjectsResponse {
  objects: FolderObjectView[];
  cursor: string | null;
  truncated: boolean;
}

export interface FolderAttachmentView {
  id: string;
  name: string;
  role: FolderRole;
  guestPath: string | null;
  attachedAt: number;
}

export interface ListFolderAttachmentsResponse {
  folders: FolderAttachmentView[];
}

export interface CredentialManifest {
  integrations: Record<string, JsonObject>;
}

export interface WorkspaceEnvironment {
  env: Record<string, string>;
  startupScript: string | null;
}

export interface WorkspaceEnvironmentResponse extends WorkspaceEnvironment {
  filesReady: boolean;
}

/** The envelope `GET /workspaces/self/agent-rules` returns to a box.
 *
 * This crosses a runtime boundary the other views do not: the producer is the
 * control-plane Worker and the consumer is a shell/Node reader baked into the
 * box image (`packages/box/rootfs/usr/local/bin/blitz-rules`). Both are pinned
 * to `packages/schema/fixtures/agent-rules/`. `version` is a content hash of
 * `content`, so a box can tell an edit from a redelivery. */
export interface AgentRulesResponse {
  version: string;
  content: string;
}

/** One selectable agent-rules document. The built-in doc is served in the same
 * list with `id: null` and `builtIn: true` so the picker can offer it — and
 * pre-fill an edit of it — without a second endpoint. */
export interface AgentRuleView {
  id: string | null;
  name: string;
  content: string;
  updatedAt: number | null;
  builtIn: boolean;
}

export interface ListAgentRulesResponse {
  rules: AgentRuleView[];
}

export interface PutAgentRuleRequest {
  name: string;
  content: string;
}

export interface PutAgentRuleResponse {
  rule: AgentRuleView;
}

/** The envelope `GET /workspaces/self/box-config` returns to the VM host.
 *
 * This crosses a runtime boundary: the producer is the control-plane Worker
 * and the consumer is the host-side updater bash/python emitted by
 * `core/bootstrap.ts` (`blitz-box-update`). Both are pinned to
 * `packages/schema/fixtures/box-config/`.
 *
 * `boxImageRef` is the deployment's current pin (`runtime.vars.boxImageRef`).
 * `controlPlaneOrigin` is the one origin the box gateway should trust; the
 * host rewrites `/var/lib/blitz/origin` on every poll when it differs, which
 * needs no restart because the gateway re-reads the file per request.
 * `updateRequested` is the per-workspace flag; image updates are request-gated
 * because replacing the container kills every process inside it. */
export interface BoxConfigResponse {
  boxImageRef: string;
  controlPlaneOrigin: string;
  updateRequested: boolean;
  payload?: BoxPayloadConfig | null;
}

/** What the host reports after an update attempt, in the order it tries:
 * `up-to-date` (the requested ref already runs, nothing replaced),
 * `unsupported` (a tarball https ref, which the updater cannot pull),
 * `pull-failed` (the pull failed; the old container was never touched),
 * `updated` (the new container runs), `rolled-back` (the new container did
 * not start and the old ref runs again), `start-failed` (neither started). */
export const BOX_UPDATE_OUTCOMES = [
  "updated",
  "up-to-date",
  "rolled-back",
  "pull-failed",
  "start-failed",
  "unsupported",
] as const;

export type BoxUpdateOutcome = (typeof BOX_UPDATE_OUTCOMES)[number];

/** The body of `POST /workspaces/self/box-update-result`: the host is the
 * producer (bash/python in the emitted updater), the control plane is the
 * consumer. The control plane clears the workspace's update flag and stores
 * `ref` on the row (`box_image_reported`) whatever the outcome, so a failed
 * attempt never leaves the flag re-triggering forever. */
export interface BoxUpdateResultRequest {
  ref: string;
  outcome: BoxUpdateOutcome;
}

export const PHASES = [
  "creating",
  "ready",
  "destroying",
  "destroyed",
  "error",
] as const;
export type Phase = (typeof PHASES)[number];

// "upgrade" is the odd one out: the first three are what a workspace can do
// about its own phase, and the fourth is what a person can do about a seat
// limit. It lives here because it travels in the same envelope field, and
// leaving it out made that field lie about what the wire already carried.
export const RETRY_ACTIONS = ["poll", "destroy", "create", "upgrade"] as const;
export type RetryAction = (typeof RETRY_ACTIONS)[number] | null;

/** The ticket role. It is the access role a webApp ticket carries and the
 * legacy `WorkspaceView.role`, and it is pinned by the webApp-ticket fixture
 * corpus on three runtimes — so it keeps its four values and its name.
 * The STORED workspace role is `WorkspaceMemberRole` below. */
export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

// The member-machines vocabulary lives in its own module and is re-exported
// here, so `core/wire.ts` stays under the 700-line warn while every consumer
// keeps one import.
export {
  MACHINE_STATES,
  WORKSPACE_MEMBER_ROLES,
  type AddWorkspaceMemberRequest,
  type MachineResponse,
  type MachineState,
  type MachineStatsRequest,
  type MachineView,
  type ProvisionMemberMachineRequest,
  type SetMachinePayloadHoldRequest,
  type SetMachineTypeRequest,
  type UpdateWorkspaceMemberRequest,
  type UpdateWorkspaceRequest,
  type WorkspaceMemberResponse,
  type WorkspaceMemberRole,
  type WorkspaceMemberView,
} from "./wire-machines.js";
// Session sharing lives beside them for the same reason.
export {
  type GrantSessionShareRequest,
  type ListSessionSharesResponse,
  type SessionShareLevel,
  type SessionShareView,
} from "./wire-sharing.js";
// The org-credential plane (plans/ORG-CREDENTIALS.md) lives beside them too.
// A star export, because that module is types only and every name is wire.
export * from "./wire-org-credentials.js";
// The two names the declarations below reference by hand. A re-export does
// not bind them locally, so they are imported as well as re-exported.
import type {
  WorkspaceMemberRole,
  WorkspaceMemberView,
} from "./wire-machines.js";

export const PHASE_TRANSITIONS = {
  creating: ["ready", "error"],
  ready: ["destroying"],
  error: ["destroying"],
  destroying: ["destroyed"],
  destroyed: [],
} satisfies Record<Phase, readonly Phase[]>;

/** What one machine costs for one month, in the vendor's own currency. */
export interface MachinePrice {
  /** The amount for one month, as the vendor's own price list gives it. */
  amount: number;
  /** The ISO 4217 code, for example "EUR" or "USD". Vendors do not all bill
   * in euro. A card that assumes one lies about money. */
  currency: string;
}

export interface MachineType {
  id: string;
  providerId: string;
  supportsVolumes: boolean;
  name: string;
  cpuCores: number;
  memGb: number;
  diskGb: number;
  arch: "x86" | "arm64";
  location: string;
  /** The price to show, or null when this machine has none to show.
   * The field is required, so every provider must answer. It was optional
   * once, and silence let a provider ship a blank price with no decision
   * behind it. */
  monthlyPrice: MachinePrice | null;
}

export interface MachineTypeProviderFailure {
  providerId: string;
  error: string;
}

export interface MachineTypeProviderStatus {
  providerId: string;
  access: "org" | "deployment" | "credential-required";
}

export interface Volume {
  id: string;
  name: string;
  sizeGb: number;
  location: string;
  status: "available" | "attached";
  attachedTo: string | null;
}

export interface WorkspaceView {
  id: string;
  name: string;
  /** Legacy: the REQUESTING member's machine type, falling back to the
   * workspace default. `defaultMachineTypeId` and `members[].machine` are the
   * fields that state the model. */
  machineTypeId: string;
  /** Legacy: the requesting member's machine state, projected onto the old
   * workspace phase so a poller still sees create finish. A workspace has no
   * phase of its own — only machines have lifecycle. */
  phase: Phase;
  retryAction: RetryAction;
  canObserve: boolean;
  launchable: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  ssh: {
    host: string;
    port: number;
    user: string;
    hostPublicKey: string | null;
  } | null;
  volumeId: string | null;
  error: string | null;
  role: WorkspaceRole | null;
  owner: {
    name: string;
    avatarUrl: string | null;
  };
  agentRuleId: string | null;
  /** Connection names the workspace's ceiling enables — its template's
   * stipulated providers plus any named at create. The workspace connections
   * panel draws one status row per name; gated on the viewer's role. */
  connections: string[];
  /** Present when a recipe launch created this workspace (provenance). */
  recipeId?: string;
  /** The member-machines fields.
   *
   * The only client of this view is the webapp in this repository, and it is
   * built from `packages/schema` — so these are required, and a server that
   * drops one fails the wire-drift gate rather than the browser. */
  orgId: string | null;
  ownerMembershipId: string | null;
  /** A default for new machines, never a restriction: every machine carries
   * its own type and may be changed to another (§1a). */
  defaultMachineTypeId: string;
  /** Provision and start a machine the moment a member is added. */
  autoProvision: boolean;
  /** The caller's stored workspace role, or null when they reach this
   * workspace only through implicit org-admin access. */
  myRole: WorkspaceMemberRole | null;
  /** Empty for a caller who cannot open the workspace. */
  members: WorkspaceMemberView[];
}

export interface TemplateConnectionView {
  provider: string;
}

export interface TemplateRepoView {
  repo: string;
  private: boolean;
}

/** One repo to add to a live workspace ("owner/name"). The server derives
 * `private` with the caller's own GitHub credential, exactly as create does —
 * privacy is provider truth, not a client assertion. */
export interface AddWorkspaceRepoRequest {
  repo: string;
}

/** The workspace's own clone list. A change lands on the machines provisioned
 * after it: the box clones at boot, so an existing machine keeps what it
 * already has until it is recreated. */
export interface ListWorkspaceReposResponse {
  repos: TemplateRepoView[];
}

export interface GithubInstallationView {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
}

export interface ListGithubInstallationsResponse {
  installations: GithubInstallationView[];
}

export interface GithubRepositoryView {
  repo: string;
  accountLogin: string;
  private: boolean;
}

/** Every row here came through an App installation, reached with the member's
 * own token. There is no second path, so nothing names which one answered. */
export interface ListGithubRepositoriesResponse {
  repositories: GithubRepositoryView[];
  truncated: boolean;
}

export type GithubRepositoryCheckVerdict =
  | "public"
  | "private-reachable"
  | "not-found"
  | "unreachable";

/** One requested repo and the Git transport verdict GitHub returned. */
export interface GithubRepositoryCheckView {
  repo: string;
  verdict: GithubRepositoryCheckVerdict;
}

/** Repos ("owner/name") to prove clonable with the caller's credential when
 * one exists. */
export interface CheckGithubRepositoriesRequest {
  repos: string[];
}

/** Probe verdicts in the same order as the request, after deduplication. */
export interface CheckGithubRepositoriesResponse {
  results: GithubRepositoryCheckView[];
}

export interface WorkspaceTemplateView {
  id: string;
  name: string;
  machineTypeId: string;
  createdAt: number;
  createdBy: { name: string; avatarUrl: string | null };
  environment: WorkspaceEnvironment | null;
  agentRuleId: string | null;
  /** True on the org's default template — the one the create dialog
   * preselects for every member. At most one per org. */
  isOrgDefault: boolean;
  /** Role is the viewer's access; null flags a folder they cannot reach yet. */
  folders: { id: string; name: string; role: FolderRole | null }[];
  /** Provider names only. Each name draws a status row in the workspace
   * connections panel; creation never blocks on connections. */
  connections: TemplateConnectionView[];
  /** GitHub repos cloned into /workspace/<name>. Privacy lets create require
   * the member's GitHub grant before bootstrap starts. */
  repos: TemplateRepoView[];
}

export interface ListWorkspaceTemplatesResponse {
  templates: WorkspaceTemplateView[];
}

/** The shared model → provider catalog.
 *
 * It mirrors the per-provider model and effort lists the pinned harness CLIs
 * accept; "default" is expressed by omitting the model or effort, so it is not
 * listed. The providers are the TUI harness list (`HARNESSES` above) — one
 * constant, derived, never re-spelled. The canonical copy lives in
 * `packages/schema/src/agent-catalog.ts` (core code may not import packages);
 * `test/wire-drift.test.ts` holds the two together. Extend both copies in the
 * same change. */
export const AGENT_PROVIDERS = HARNESSES;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const AGENT_MODELS = {
  claude: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  // Codex CLI user-selectable models; excluded on purpose: codex-auto-review (single-purpose review model), gpt-reserve (routing placeholder).
  codex: [
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
  ],
} satisfies Record<AgentProvider, readonly string[]>;

/** The per-provider BASE effort lists: every model of the provider accepts at
 * least these, in ascending order. Models that accept more appear in
 * AGENT_MODEL_EFFORTS. */
export const AGENT_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
} satisfies Record<AgentProvider, readonly string[]>;

/** Per-model effort extensions: only models whose list differs from their
 * provider base appear. The codex gpt-5.6 family adds `max`; sol and terra
 * also add `ultra`. Claude efforts are flat, so no claude model is listed. */
export const AGENT_MODEL_EFFORTS = {
  "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
  "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
} satisfies Record<string, readonly string[]>;

function isEffortExtendedModel(model: string): model is keyof typeof AGENT_MODEL_EFFORTS {
  return model in AGENT_MODEL_EFFORTS;
}

/** The effective ordered effort list for one provider and pinned model: the
 * model's extended list when it has one, otherwise the provider base. An
 * absent model (the harness default) always takes the base. */
export function agentEffortsForModel(provider: AgentProvider, model?: string): readonly string[] {
  if (model !== undefined && isEffortExtendedModel(model)) return AGENT_MODEL_EFFORTS[model];
  return AGENT_EFFORTS[provider];
}

/** A recipe is one row: a template reference plus an invocation — harness,
 * model, effort, prompt. Launching one creates a normal workspace from the
 * template and delivers the invocation to the box (plans/RECIPES.md).
 * The harness choices are the TUI harnesses. */
export const RECIPE_HARNESSES = [...HARNESSES] as const;

export type RecipeHarness = (typeof RECIPE_HARNESSES)[number];

export interface RecipeView {
  id: string;
  name: string;
  templateId: string;
  harness: RecipeHarness;
  /** A catalog model (see AGENT_MODELS); absent means the harness
   * default. */
  model?: string;
  effort?: string;
  prompt: string;
}

export interface ListRecipesResponse {
  recipes: RecipeView[];
}

/** POST /workspace-recipes and PUT /workspace-recipes/:id share this
 * full-replacement shape, exactly like workspace templates. */
export interface CreateRecipeRequest {
  name: string;
  templateId: string;
  harness: RecipeHarness;
  model?: string;
  effort?: string;
  prompt: string;
}

/** Envelope for GET /workspace-recipes/:id, POST /workspace-recipes (201),
 * and PUT /workspace-recipes/:id. POST /workspace-recipes/:id/launch answers
 * with CreateWorkspaceResponse instead. */
export interface RecipeResponse {
  recipe: RecipeView;
}

/** Admin switch for org-wide agent-usage capture (GET and PUT
 * /orgs/self/usage-capture). The folder is lazy-created on first enable and
 * survives a disable, so re-enabling keeps the corpus in one place. */
export interface OrgUsageCaptureResponse {
  enabled: boolean;
  folderId: string | null;
}

export interface CreateWorkspaceTemplateRequest {
  name: string;
  machineTypeId: string;
  folderIds: string[];
  connections?: TemplateConnectionView[];
  environment?: WorkspaceEnvironment;
  /** An org agent rule to hand every workspace made from this template; null
   * (or absent) leaves it on the built-in doc. */
  agentRuleId?: string | null;
  /** Repo names to clone at create. Naming any force-attaches the github
   * connection; the server derives privacy with the caller's credential. */
  repos?: string[];
  /** True marks this template as the org default (admin only). False clears
   * the mark iff it currently points at this template. Absent leaves the org
   * pointer alone — it is org state, not template state. */
  isOrgDefault?: boolean;
}

export interface CreateWorkspaceTemplateResponse {
  template: WorkspaceTemplateView;
}

export interface ListMachineTypesResponse {
  machineTypes: MachineType[];
  failures: MachineTypeProviderFailure[];
  /** Present on current servers. Optional keeps older API clients and test
   * doubles source-compatible while they adopt inline credential setup. */
  providerStatuses?: MachineTypeProviderStatus[];
}

export interface CreateWorkspaceRequest {
  /** Legacy spelling of `defaultMachineTypeId`; either satisfies the
   * requirement, and `defaultMachineTypeId` wins when both are sent. */
  machineTypeId?: string;
  /** The default a machine takes when nothing else names one. */
  defaultMachineTypeId?: string;
  /** Provision and start a machine on every member add. Default true. */
  autoProvision?: boolean;
  /** Existing org members, added immediately. The creator is the first
   * workspace admin and never needs a row here. */
  members?: {
    membershipId: string;
    role: WorkspaceMemberRole;
    machineTypeId?: string;
    /** Default true; false gives that member's machine no volume. */
    persistentVolume?: boolean;
  }[];
  /** Copies config — default machine type, agent rule, repos — and neither
   * members nor credentials (credentials are org-scoped now,
   * plans/ORG-CREDENTIALS.md §3). The workspace is the template now, so this
   * is "new workspace from existing". */
  cloneFromWorkspaceId?: string;
  /** Retired with the template tables (plans/MEMBER-MACHINES.md §0). Sending
   * one is refused rather than ignored. */
  templateId?: string;
  name?: string;
  volumeId?: string;
  userData?: string;
  manifest?: CredentialManifest;
  /** Providers to enable in the new workspace. The manifest stays the ceiling;
   * this is the provision list, and the ceiling wins on conflict. */
  connections?: string[];
  /** Overrides the clone source's rule; null (or absent) falls back to the
   * source's rule and then the built-in doc. */
  agentRuleId?: string | null;
  /** GitHub repositories ("owner/name") the box clones into /workspace. Only
   * for a create with no template: a template already carries its own list,
   * and a request that names both is refused rather than merged. */
  repos?: string[];
}

export interface CreateWorkspaceResponse {
  workspace: WorkspaceView;
}

export interface PollResponse {
  workspaces: WorkspaceView[];
}

export interface RegisterKeysResponse {
  memberUnixName: string;
  broker: {
    host: string;
    port: number;
    sshHostPublicKey: string;
  };
}

export interface ApiError {
  error: string;
  retryAction: RetryAction;
  /** Where a person can pay their way past this refusal. Present only on the
   * 402 a seat gate throws, and only where the deployment has a billing
   * service with a checkout surface — a refusal with nowhere to go is still a
   * refusal, it just cannot offer a way out. */
  paymentUrl?: string;
}

/** The one write a private billing service makes. Two integers and one flag;
 * no plan name, ever. `platformCompute` is optional and absent means 0: the
 * body states an organization's whole entitlement, so a write that omits the
 * flag says the organization does not have it, exactly as a missing row does.
 */
export interface EntitlementsRequest {
  seatLimit: number;
  vmLimit: number;
  platformCompute?: boolean;
}

/** What an organization's limits are and how much of them is in use.
 * `seatLimit` is null where no billing service is attached: that deployment
 * has no cap to show, rather than a large one. `platformCompute` is why a
 * workspace create is refused or allowed without an organization credential,
 * so an admin can see the reason rather than guess at it. */
export interface OrgUsageResponse {
  seatsUsed: number;
  seatLimit: number | null;
  vmsUsed: number;
  vmLimit: number;
  platformCompute: boolean;
}

/** Where an admin goes to deal with billing, carrying a signed hop. One link,
 * not one per errand: the billing service reads the hop and offers buying or
 * the portal depending on what the organization already has, so choosing here
 * would only be a second opinion about the same fact. */
export interface OrgBillingResponse {
  url: string;
}

export interface CreateVolumeRequest {
  name: string;
  sizeGb: number;
  location: string;
}

export interface CreateVolumeResponse {
  volume: Volume;
}

export interface ListVolumesResponse {
  volumes: Volume[];
}

export interface DeleteVolumeResponse {
  id: string;
}

export const INVITE_TTL_DAYS = 7;

export interface FeedResponse {
  version: string;
  members: FeedMember[];
}

export interface FeedMember {
  unixName: string;
  harnesses: string[];
  keys: FeedKey[];
}

export interface FeedKey {
  pubkey: string;
  op: "mint" | "deposit";
}
