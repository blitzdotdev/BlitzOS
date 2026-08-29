import type { WorkspaceEnvironment } from "./environment.js";

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

/** The stored workspace role (plans/MEMBER-MACHINES.md §3). `admin` here is
 * workspace admin, which is not the org role of the same name: an org admin
 * reaches every workspace of the org implicitly without holding a row. */
export const WORKSPACE_MEMBER_ROLES = ["admin", "member", "viewer"] as const;

export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

export const MACHINE_STATES = [
  "provisioning",
  "running",
  "stopped",
  "error",
  "destroying",
  "destroyed",
] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

export const PHASE_TRANSITIONS = {
  creating: ["ready", "error"],
  ready: ["destroying"],
  error: ["destroying"],
  destroying: ["destroyed"],
  destroyed: [],
} satisfies Record<Phase, readonly Phase[]>;

/** One member's VM. The volume is the durable half and survives a machine-type
 * change; `vmId` never crosses the wire, because a provider identifier is not
 * a product concept. */
export interface MachineView {
  id: string;
  state: MachineState;
  /** This machine's type. The workspace holds only a default. */
  machineTypeId: string;
  volumeId: string | null;
  membershipId: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceMemberView {
  membershipId: string;
  name: string;
  avatarUrl: string | null;
  role: WorkspaceMemberRole;
  /** Null when nothing is provisioned: `autoProvision` is off, or the member
   * is a viewer, who never holds a machine. */
  machine: MachineView | null;
}

/** A workspace credential, names only. A value never crosses the wire after
 * the write that created it. */
export interface WorkspaceCredentialView {
  name: string;
  label: string | null;
  createdAt: number;
}

export interface WorkspaceView {
  id: string;
  /** Display name; the server generates one when the creator omits it. */
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
  /** Monotonic per workspace; clients must drop older revisions. */
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
  /** The member-machines fields. Every current server sends all of them.
   *
   * They are optional for the same reason `ListMachineTypesResponse.providerStatuses`
   * is: this view is parsed by clients that ship on their own cadence, and a
   * required field would break every one of them on the day the server grew
   * it. A client that reads `members` still has to handle its absence, which
   * is honest — a response from an older deployment genuinely does not carry
   * one. */
  orgId?: string | null;
  ownerMembershipId?: string | null;
  /** A default for new machines, never a restriction: every machine carries
   * its own type and may be changed to another (§1a). */
  defaultMachineTypeId?: string;
  /** Provision and start a machine the moment a member is added. */
  autoProvision?: boolean;
  /** The caller's stored workspace role, or null when they reach this
   * workspace only through implicit org-admin access. */
  myRole?: WorkspaceMemberRole | null;
  members?: WorkspaceMemberView[];
  /** Names only. Present for members and admins; empty for a caller who may
   * not use them. */
  credentials?: WorkspaceCredentialView[];
}

export interface MachineResponse {
  machine: MachineView;
}

/** Same-location only: the volume stays, the VM is replaced. A type in another
 * location needs a volume move, which is deferred (plan §5). */
export interface SetMachineTypeRequest {
  machineTypeId: string;
}

export interface AddWorkspaceMemberRequest {
  membershipId: string;
  role: WorkspaceMemberRole;
  /** Per-member override of the workspace default. */
  machineTypeId?: string;
}

export interface UpdateWorkspaceMemberRequest {
  role: WorkspaceMemberRole;
}

export interface WorkspaceMemberResponse {
  member: WorkspaceMemberView;
}

/** Add or rotate: one live row per (workspace, name), so a second write to a
 * live name replaces its value. */
export interface PutWorkspaceCredentialRequest {
  name: string;
  label?: string;
  value: string;
}

export interface ListWorkspaceCredentialsResponse {
  credentials: WorkspaceCredentialView[];
}

export interface TemplateConnectionView {
  provider: string;
}

export interface TemplateRepoView {
  repo: string;
  private: boolean;
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
  folders: { id: string; name: string; role: "owner" | "admin" | "editor" | "viewer" | null }[];
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
