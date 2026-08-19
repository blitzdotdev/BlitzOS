import type { MachineType } from "./machine.js";
import type { CredentialManifest } from "./credential.js";
import type { Volume } from "./volume.js";
import type { RetryAction, WorkspaceView } from "./workspace.js";

export interface MachineTypeProviderFailure {
  providerId: string;
  error: string;
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
  /** Optional display name; blank means the server picks a random one. */
  name?: string;
  sshPublicKey?: string;
  volumeId?: string;
  /** User-data is readable inside the VM; never put secrets here. */
  userData?: string;
  manifest?: CredentialManifest;
  /** Providers to enable in the new workspace. The manifest stays the ceiling;
   * this is the provision list, and the ceiling wins on conflict. */
  connections?: string[];
}

export interface CreateWorkspaceResponse {
  workspace: WorkspaceView;
}

export interface PollResponse {
  /** A poll is authoritative and can add, update, or remove rows. */
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
