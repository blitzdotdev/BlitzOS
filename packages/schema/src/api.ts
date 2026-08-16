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
  machineTypeId: string;
  /** Optional display name; blank means the server picks a random one. */
  name?: string;
  sshPublicKey?: string;
  volumeId?: string;
  /** User-data is readable inside the VM; never put secrets here. */
  userData?: string;
  manifest?: CredentialManifest;
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
