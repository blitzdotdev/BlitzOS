// Wire shapes for shared workspace sessions and organization presence. Split
// from wire.ts on touch (CLAUDE.md max-lines); wire.ts re-exports everything
// here, so importers and the schema drift test see one module.

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

export const PRESENCE_CONNECTION_TTL_MS = 35_000;
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 15_000;
export const PRESENCE_VISIBLE_POLL_INTERVAL_MS = 5_000;
export const PRESENCE_HIDDEN_POLL_INTERVAL_MS = 30_000;

export type PresenceSessionSurfaceInput = {
  kind: "session";
  sessionId: string;
};

export type PresenceClientSurfaceInput = {
  kind: "file" | "preview";
  surfaceId: string;
  label: string;
};

export type PresencePanelSurfaceInput = {
  kind: "panel";
  panel: "files" | "previews" | "connections";
};

export type PresenceWorkspaceSurfaceInput = {
  kind: "workspace";
};

export type PresenceSurfaceInput =
  | PresenceSessionSurfaceInput
  | PresenceClientSurfaceInput
  | PresencePanelSurfaceInput
  | PresenceWorkspaceSurfaceInput;

export interface PutPresenceConnectionRequest {
  workspaceId: string | null;
  surfaces: PresenceSurfaceInput[];
  focusedSurface: number | null;
  visible: boolean;
  focused: boolean;
}

export type PresenceSurfaceView =
  | {
      kind: "session";
      sessionId: string;
      sessionKind: WorkspaceSessionKind;
      title: string | null;
    }
  | PresenceClientSurfaceInput
  | PresencePanelSurfaceInput
  | PresenceWorkspaceSurfaceInput;

interface PresenceActivityBase {
  visible: boolean;
  focused: boolean;
  lastSeenAt: number;
}

export type PresenceActivityView =
  | (PresenceActivityBase & { location: "organization" })
  | (PresenceActivityBase & { location: "other-workspace" })
  | (PresenceActivityBase & {
      location: "workspace";
      workspaceId: string;
      workspaceName: string;
      surfaces: PresenceSurfaceView[];
      focusedSurface: number | null;
    });

export type PresenceMemberState = "active" | "online" | "away";

export interface PresenceMemberView {
  membershipId: string;
  userId: string;
  name: string;
  avatarUrl: string | null;
  state: PresenceMemberState;
  activities: PresenceActivityView[];
}

export interface PresenceSnapshotResponse {
  serverTime: number;
  expiresAfterMs: number;
  /** True when the organization had more live connections than one snapshot
   * carries; the least active connections were dropped, so a member may show
   * fewer activities than they have, and an idle member may be missing. */
  truncated: boolean;
  members: PresenceMemberView[];
}
