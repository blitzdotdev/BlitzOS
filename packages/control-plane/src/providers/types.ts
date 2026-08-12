import type {
  CreateVolumeRequest,
  MachineType,
  Volume,
} from "@blitzos/schema";

export interface ProviderCapabilities {
  volumes: boolean;
}

export interface CreateVmInput {
  workspaceId: string;
  machineTypeId: string;
  sshPublicKey: string;
  userData: string;
}

export interface CreatedVm {
  id: string;
  host: string;
  port: number;
  user: string;
}

export interface VmInspection extends CreatedVm {
  state: "running" | "stopped";
}

export interface VmProvider {
  capabilities(): ProviderCapabilities;
  listMachineTypes(): Promise<MachineType[]>;
  createVm(input: CreateVmInput): Promise<CreatedVm>;
  destroy(id: string): Promise<void>;
  inspect(id: string): Promise<VmInspection | null>;
}

export interface VolumeProvider {
  createVolume(input: CreateVolumeRequest): Promise<Volume>;
  attachVolume(volumeId: string, vmId: string): Promise<void>;
  detachVolume(volumeId: string, vmId: string): Promise<void>;
  deleteVolume(id: string): Promise<void>;
  listVolumes(): Promise<Volume[]>;
}
