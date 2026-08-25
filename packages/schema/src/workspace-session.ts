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
  /** The key the browser hands the box terminal (`blitz-term <kind> <key>`),
   * which names the tmux session. Server-created sessions use their own id;
   * sessions migrated from a V1 document keep the numeric tab id they were
   * already running under, so an upgrade attaches to the live tmux session
   * instead of spawning a second agent beside it. */
  terminalKey: string;
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
