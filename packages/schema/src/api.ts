import type { MachineType } from "./machine.js";
import type { Volume } from "./volume.js";
import type { RetryAction, WorkspaceView } from "./workspace.js";

export interface ListMachineTypesResponse {
  machineTypes: MachineType[];
}

export interface CreateWorkspaceRequest {
  machineTypeId: string;
  sshPublicKey?: string;
  volumeId?: string;
  /** User-data is readable inside the VM; never put secrets here. */
  userData?: string;
  manifest?: {
    integrations: Record<string, Record<string, unknown>>;
  };
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
