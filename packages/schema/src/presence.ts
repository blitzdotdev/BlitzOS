import type { WorkspaceSessionKind } from "./workspace-session.js";

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
  members: PresenceMemberView[];
}
