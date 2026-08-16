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
  owner: {
    name: string;
    avatarUrl: string | null;
  };
}
