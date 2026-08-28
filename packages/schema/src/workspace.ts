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

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";

export const PHASE_TRANSITIONS = {
  creating: ["ready", "error"],
  ready: ["destroying"],
  error: ["destroying"],
  destroying: ["destroyed"],
  destroyed: [],
} satisfies Record<Phase, readonly Phase[]>;

export interface WorkspaceView {
  id: string;
  /** Display name; the server generates one when the creator omits it. */
  name: string;
  machineTypeId: string;
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
