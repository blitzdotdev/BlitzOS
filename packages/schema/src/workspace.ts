export interface WorkspaceEnvironment {
  env: Record<string, string>;
  startupScript: string | null;
}

export interface WorkspaceEnvironmentResponse extends WorkspaceEnvironment {
  filesReady: boolean;
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
  /** How full the machine's persistent volume is, 0-100, as the guest last
   * measured it. Null means the question has no answer yet: there is no
   * volume, or no guest has reported one (every box image before the reporter
   * shipped). Null is never 0 — an unmeasured disk is not an empty one. */
  volumeUsedPercent: number | null;
  membershipId: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The guest's own disk report (`POST /workspaces/self/machine-stats`).
 * `diskUsedPercent` is an integer 0-100, the used percentage of the filesystem
 * holding the state directory. Anything else is a 400: a machine reporting
 * nonsense about its disk must not overwrite the last true figure. */
export interface MachineStatsRequest {
  diskUsedPercent: number;
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
  owner: {
    name: string;
    avatarUrl: string | null;
  };
  agentRuleId: string | null;
  /** Connection names the workspace's ceiling enables — inherited providers
   * plus any named at create. The workspace connections
   * panel draws one status row per name; gated on the viewer's role. */
  connections: string[];
  /** The member-machines fields.
   *
   * The only client of this view is the webapp in this repository, and it is
   * built from this file — so these are required, and a server that drops one
   * fails the wire-drift gate rather than the browser. */
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
  /** Whether this member's machine gets its own persistent volume. Default
   * true. False provisions the VM with no disk of its own, so nothing on it
   * survives the VM — for a throwaway machine that has nothing to keep. */
  persistentVolume?: boolean;
}

export interface UpdateWorkspaceMemberRequest {
  role: WorkspaceMemberRole;
}

/** Provisions a machine for a member row that holds none — the manual half of
 * §2.1, for a workspace whose `autoProvision` is off or a member whose machine
 * was destroyed. A viewer is refused: they never hold one (§2.2). */
export interface ProvisionMemberMachineRequest {
  /** Overrides the workspace default for this one machine (§1a). */
  machineTypeId?: string;
  /** Whether this member's machine gets its own persistent volume. Default
   * true. False provisions the VM with no disk of its own, so nothing on it
   * survives the VM — for a throwaway machine that has nothing to keep. */
  persistentVolume?: boolean;
}

export interface WorkspaceMemberResponse {
  member: WorkspaceMemberView;
}

/**
 * The workspace settings write (§3, first matrix row). Every field is
 * optional and an absent one is left alone, so a caller who edits the name
 * does not have to restate the rest.
 *
 * `defaultMachineTypeId` is a default, never a restriction: changing it moves
 * FUTURE provisions and touches no existing machine (§1a). `agentRuleId` takes
 * an explicit null to fall back to the built-in doc.
 */
export interface UpdateWorkspaceRequest {
  name?: string;
  defaultMachineTypeId?: string;
  autoProvision?: boolean;
  agentRuleId?: string | null;
}

export interface WorkspaceRepoView {
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
  repos: WorkspaceRepoView[];
}

/** One granted session, as both halves of the share UI read it.
 *
 * `sessionId` is the Lody session id and is opaque to the control plane
 * (plans/LODY-SHARING.md §1.1): the daemon on the owner's box is the only thing
 * that knows which sessions exist. */
export interface SessionShareView {
  id: string;
  sessionId: string;
  /** The membership whose machine runs the session. */
  ownerMembershipId: string;
  granteeMembershipId: string;
  level: SessionShareLevel;
  createdAt: number;
  createdByMembershipId: string;
}

/** Read-only follows the transcript and the session's diffs; read-write is a
 * full co-driver (prompt, steer, cancel, answer a permission request). */
export type SessionShareLevel = "ro" | "rw";

/** Both halves of one screen: `granted` is what the caller may manage — their
 * own shares, or every share in the workspace for an admin — and `received` is
 * what other members have shared with the caller. One route, because the share
 * dialog reads the first and the rail reads the second. */
export interface ListSessionSharesResponse {
  granted: SessionShareView[];
  received: SessionShareView[];
}

/** Grant, or change an existing grant's level: the write upserts on
 * (workspace, session, grantee), so re-granting at another level is this same
 * call. `ownerMembershipId` defaults to the caller, which is the ordinary case;
 * a workspace admin may name another member, which is how §0.1's "admins
 * grant/revoke" works without the admin owning the session. */
export interface GrantSessionShareRequest {
  sessionId: string;
  granteeMembershipId: string;
  level: SessionShareLevel;
  ownerMembershipId?: string;
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
