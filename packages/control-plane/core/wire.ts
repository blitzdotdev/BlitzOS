export const FEED_MAX_BYTES = 1_048_576;
export const HARNESSES = ["claude", "codex"] as const;
export const FILES_MULTIPART_CHUNK_BYTES = 32 * 1024 * 1024;

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type FolderRole = "owner" | "admin" | "editor" | "viewer";

export interface FolderGrantView {
  id: string;
  membershipId: string;
  role: "editor" | "viewer";
  createdAt: number;
  member: { name: string; email: string; avatarUrl: string | null };
}

export interface FolderView {
  id: string;
  name: string;
  role: FolderRole | null;
  owner: { name: string; avatarUrl: string | null };
  attachedWorkspaceIds: string[];
  createdAt: number;
  updatedAt: number;
  grants?: FolderGrantView[];
}

export interface FolderObjectView {
  key: string;
  size: number;
  mtime: number;
  editedBy: string;
}

export interface ListFolderObjectsResponse {
  objects: FolderObjectView[];
  cursor: string | null;
  truncated: boolean;
}

export interface FolderAttachmentView {
  id: string;
  name: string;
  role: FolderRole;
  attachedAt: number;
}

export interface ListFolderAttachmentsResponse {
  folders: FolderAttachmentView[];
}

export interface CredentialManifest {
  integrations: Record<string, JsonObject>;
}

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

export interface MachineType {
  id: string;
  providerId: string;
  supportsVolumes: boolean;
  name: string;
  cpuCores: number;
  memGb: number;
  diskGb: number;
  arch: "x86" | "arm64";
  location: string;
}

export interface MachineTypeProviderFailure {
  providerId: string;
  error: string;
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
  name: string;
  machineTypeId: string;
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
  role: WorkspaceRole | null;
  owner: {
    name: string;
    avatarUrl: string | null;
  };
}

export interface ListMachineTypesResponse {
  machineTypes: MachineType[];
  failures: MachineTypeProviderFailure[];
}

export interface CreateWorkspaceRequest {
  machineTypeId: string;
  name?: string;
  sshPublicKey?: string;
  volumeId?: string;
  userData?: string;
  manifest?: CredentialManifest;
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

export const INVITE_TTL_DAYS = 7;

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
