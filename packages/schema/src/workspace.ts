import type { WorkspaceEnvironment } from "./environment.js";

export const PHASES = [
  "creating",
  "ready",
  "destroying",
  "destroyed",
  "error",
] as const;

export type Phase = (typeof PHASES)[number];

export const RETRY_ACTIONS = ["poll", "destroy", "create"] as const;

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
  /** Present when a recipe launch created this workspace (provenance). */
  recipeId?: string;
}

export interface WorkspaceTemplateView {
  id: string;
  name: string;
  machineTypeId: string;
  createdAt: number;
  createdBy: { name: string; avatarUrl: string | null };
  environment: WorkspaceEnvironment | null;
  agentRuleId: string | null;
  /** Role is the viewer's access; null flags a folder they cannot reach yet. */
  folders: { id: string; name: string; role: "owner" | "admin" | "editor" | "viewer" | null }[];
}

export interface ListWorkspaceTemplatesResponse {
  templates: WorkspaceTemplateView[];
}

export interface CreateWorkspaceTemplateRequest {
  name: string;
  machineTypeId: string;
  folderIds: string[];
  environment?: WorkspaceEnvironment;
  /** An org agent rule to hand every workspace made from this template; null
   * (or absent) leaves it on the built-in doc. */
  agentRuleId?: string | null;
}

export interface CreateWorkspaceTemplateResponse {
  template: WorkspaceTemplateView;
}
