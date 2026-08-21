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
  orgRole: "editor" | "viewer" | null;
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
  guestPath: string | null;
  attachedAt: number;
}

export interface ListFolderAttachmentsResponse {
  folders: FolderAttachmentView[];
}

export interface CredentialManifest {
  integrations: Record<string, JsonObject>;
}

export interface WorkspaceEnvironment {
  env: Record<string, string>;
  startupScript: string | null;
}

export interface WorkspaceEnvironmentResponse extends WorkspaceEnvironment {
  filesReady: boolean;
}

/** The envelope `GET /workspaces/self/agent-rules` returns to a box.
 *
 * This crosses a runtime boundary the other views do not: the producer is the
 * control-plane Worker and the consumer is a shell/Node reader baked into the
 * box image (`packages/box/rootfs/usr/local/bin/blitz-rules`). Both are pinned
 * to `packages/schema/fixtures/agent-rules/`. `version` is a content hash of
 * `content`, so a box can tell an edit from a redelivery. */
export interface AgentRulesResponse {
  version: string;
  content: string;
}

/** One selectable agent-rules document. The built-in doc is served in the same
 * list with `id: null` and `builtIn: true` so the picker can offer it — and
 * pre-fill an edit of it — without a second endpoint. */
export interface AgentRuleView {
  id: string | null;
  name: string;
  content: string;
  updatedAt: number | null;
  builtIn: boolean;
}

export interface ListAgentRulesResponse {
  rules: AgentRuleView[];
}

export interface PutAgentRuleRequest {
  name: string;
  content: string;
}

export interface PutAgentRuleResponse {
  rule: AgentRuleView;
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
  orgShareRole: "editor" | "viewer" | null;
  owner: {
    name: string;
    avatarUrl: string | null;
  };
  environment: WorkspaceEnvironment | null;
  agentRuleId: string | null;
}

export interface TemplateConnectionView {
  provider: string;
  required: boolean;
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
  folders: { id: string; name: string; role: FolderRole | null }[];
  /** Provider names only. `required` blocks create until the creator connects. */
  connections: TemplateConnectionView[];
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
}

export interface CreateWorkspaceTemplateResponse {
  template: WorkspaceTemplateView;
}

export interface ListMachineTypesResponse {
  machineTypes: MachineType[];
  failures: MachineTypeProviderFailure[];
}

export interface CreateWorkspaceRequest {
  /** Required unless templateId is set; then the template's machine type is the default. */
  machineTypeId?: string;
  /** Creates from a workspace template: its folders attach automatically. */
  templateId?: string;
  /** Shares the new workspace with every active org member at this role. */
  orgShareRole?: "editor" | "viewer";
  name?: string;
  sshPublicKey?: string;
  volumeId?: string;
  userData?: string;
  manifest?: CredentialManifest;
  /** Providers to enable in the new workspace. The manifest stays the ceiling;
   * this is the provision list, and the ceiling wins on conflict. */
  connections?: string[];
  environment?: WorkspaceEnvironment;
  /** Overrides the template's rule; null (or absent) falls back to the
   * template's rule and then the built-in doc. */
  agentRuleId?: string | null;
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
