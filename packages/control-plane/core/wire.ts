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

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

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
  machineTypeId: string;
  phase: Phase;
  retryAction: RetryAction;
  canObserve: boolean;
  launchable: boolean;
  revision: number;
  ssh: {
    host: string;
    port: number;
    user: string;
    hostPublicKey: string | null;
  } | null;
  volumeId: string | null;
  error: string | null;
  role: WorkspaceRole | null;
  orgShareRole: "editor" | "viewer" | null;
  owner: {
    name: string;
    avatarUrl: string | null;
  };
  environment: WorkspaceEnvironment | null;
  agentRuleId: string | null;
  /** Connection names the workspace's ceiling enables — its template's
   * stipulated providers plus any named at create. The workspace connections
   * panel draws one status row per name; gated on the viewer's role like
   * `environment`. */
  connections: string[];
  /** Present when a recipe launch created this workspace (provenance). */
  recipeId?: string;
}

export interface TemplateConnectionView {
  provider: string;
}



/** POST /connections/github/repositories/check: why one repo failed the
 * anonymous clone probe. */
export type GithubRepositoryCheckFailure = "not-public" | "unreachable";

/** One requested repo and the anonymous clone verdict GitHub returned. */
export interface GithubRepositoryCheckView {
  repo: string;
  reachable: boolean;
  /** Absent when `reachable` is true. */
  failure?: GithubRepositoryCheckFailure;
}

/** Repos ("owner/name") to prove clonable without credentials. */
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
  /** GitHub repos ("owner/name") cloned into /workspace/<name> when a
   * workspace is created from this template. */
  repos: string[];
}

export interface ListWorkspaceTemplatesResponse {
  templates: WorkspaceTemplateView[];
}

/** The shared model → provider catalog.
 *
 * It mirrors the per-provider model and effort lists the box actor accepts
 * (`packages/box/actor/src/agent-config.ts`); "default" is expressed by
 * omitting the model or effort, so it is not listed. The providers are the
 * TUI harness list (`HARNESSES` above) — one constant, derived, never
 * re-spelled. The canonical copy lives in
 * `packages/schema/src/agent-catalog.ts` (core code may not import packages);
 * `test/wire-drift.test.ts` holds the two together. Extend both copies and
 * the actor catalog in the same change. */
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
 * The harness choices are the TUI harnesses plus the headless chat run. */
export const RECIPE_HARNESSES = [...HARNESSES, "chat"] as const;

export type RecipeHarness = (typeof RECIPE_HARNESSES)[number];

export interface RecipeView {
  id: string;
  name: string;
  templateId: string;
  harness: RecipeHarness;
  /** A catalog model (see AGENT_MODELS); absent means the harness default.
   * Required for `chat`, whose model also selects the adapter provider. */
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
  /** Repos ("owner/name") to clone at create. Naming any force-attaches the
   * github connection. */
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
  /** Required unless templateId is set; then the template's machine type is the default. */
  machineTypeId?: string;
  /** Creates from a workspace template: its folders attach automatically. */
  templateId?: string;
  /** Shares the new workspace with every active org member at this role. */
  orgShareRole?: "editor" | "viewer";
  name?: string;
  sshPublicKey?: string;
  volumeId?: string;
  userData?: string;
  manifest?: CredentialManifest;
  /** Providers to enable in the new workspace. The manifest stays the ceiling;
   * this is the provision list, and the ceiling wins on conflict. */
  connections?: string[];
  environment?: WorkspaceEnvironment;
  /** Overrides the template's rule; null (or absent) falls back to the
   * template's rule and then the built-in doc. */
  agentRuleId?: string | null;
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

/** What an organization's limits are and how much of them is in use.
 * `seatLimit` is null where no billing service is attached: that deployment
 * has no cap to show, rather than a large one. */
export interface OrgUsageResponse {
  seatsUsed: number;
  seatLimit: number | null;
  vmsUsed: number;
  vmLimit: number;
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
