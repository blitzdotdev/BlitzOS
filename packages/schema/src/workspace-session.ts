export const WORKSPACE_SESSION_KINDS = [
  "claude",
  "codex",
  "opencode",
  "pi",
  "kimi",
  "prime",
  "terminal",
  "chat",
] as const;

export type WorkspaceSessionKind = (typeof WORKSPACE_SESSION_KINDS)[number];

export interface WorkspaceSessionView {
  id: string;
  workspaceId: string;
  kind: WorkspaceSessionKind;
  title: string | null;
  chatSessionId: string | null;
  chatProvider: "claude" | "codex" | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkspaceSessionRequest {
  kind: WorkspaceSessionKind;
  title?: string;
}

export interface UpdateWorkspaceSessionRequest {
  revision: number;
  title?: string | null;
  chatSessionId?: string | null;
  chatProvider?: "claude" | "codex" | null;
}

export interface WorkspaceSessionResponse {
  session: WorkspaceSessionView;
}

export interface ListWorkspaceSessionsResponse {
  sessions: WorkspaceSessionView[];
}
