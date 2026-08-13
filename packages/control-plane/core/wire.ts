export const FEED_MAX_BYTES = 1_048_576;
export const HARNESSES = ["claude", "codex"] as const;

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

export interface MachineType {
  id: string;
  name: string;
  cpuCores: number;
  memGb: number;
  diskGb: number;
  arch: "x86" | "arm64";
  location: string;
}

export interface Volume {
  id: string;
  name: string;
  sizeGb: number;
  location: string;
  status: "available" | "attached";
  attachedTo: string | null;
}

export interface WorkspaceView {
  id: string;
  phase: Phase;
  retryAction: RetryAction;
  canObserve: boolean;
  launchable: boolean;
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

export interface ListMachineTypesResponse {
  machineTypes: MachineType[];
}

export interface CreateWorkspaceRequest {
  machineTypeId: string;
  sshPublicKey: string;
  volumeId?: string;
  userData?: string;
}

export interface CreateWorkspaceResponse {
  workspace: WorkspaceView;
}

export interface PollResponse {
  workspaces: WorkspaceView[];
}

export interface RegisterKeysResponse {
  memberUnixName: string;
  broker: {
    host: string;
    port: number;
    sshHostPublicKey: string;
  };
}

export interface ApiError {
  error: string;
  retryAction: RetryAction;
}

export interface CreateVolumeRequest {
  name: string;
  sizeGb: number;
  location: string;
}

export interface CreateVolumeResponse {
  volume: Volume;
}

export interface ListVolumesResponse {
  volumes: Volume[];
}

export interface DeleteVolumeResponse {
  id: string;
}

export interface FeedResponse {
  version: string;
  members: FeedMember[];
}

export interface FeedMember {
  unixName: string;
  harnesses: string[];
  keys: FeedKey[];
}

export interface FeedKey {
  pubkey: string;
  op: "mint" | "deposit";
}
