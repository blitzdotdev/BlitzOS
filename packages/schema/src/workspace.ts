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

export const PHASE_TRANSITIONS: Record<Phase, readonly Phase[]> = {
  creating: ["ready", "error"],
  ready: ["destroying"],
  error: ["destroying"],
  destroying: ["destroyed"],
  destroyed: [],
};

export interface WorkspaceView {
  id: string;
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
}
