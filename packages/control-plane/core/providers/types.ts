import type { CreateVolumeRequest, MachineType, Volume } from "../wire.js";

export type ProviderMachineType = Omit<
  MachineType,
  "providerId" | "supportsVolumes"
>;

export interface ProviderCapabilities {
  volumes: boolean;
  maxUserDataBytes?: number | null;
  webAppActorBypassesGateway?: boolean;
  /** Epoch ms from which VMs this provider creates boot a guest that verifies
   * v1 webApp tickets. Guest channels version independently, so a workspace's
   * created_at only means something against its own provider's cutoff.
   * Undefined is "never": those VMs keep receiving the static token. */
  webAppTicketsSinceMs?: number;
}

export interface CreateVmInput {
  workspaceId: string;
  machineTypeId: string;
  sshPublicKey?: string;
  phoneHomeUrl: string;
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

export type WebAppPort = 7444 | 7445;

export interface VmProvider {
  readonly id: string;
  ownsMachineType(machineTypeId: string): boolean;
  ownsVmId(vmId: string): boolean;
  capabilities(): ProviderCapabilities;
  listMachineTypes(): Promise<ProviderMachineType[]>;
  createVm(input: CreateVmInput): Promise<CreatedVm>;
  shutdown(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  inspect(id: string): Promise<VmInspection | null>;
  proxyWebApp?(
    id: string,
    port: WebAppPort,
    pathAndQuery: string,
    request: Request,
  ): Promise<Response | null>;
}

export interface VolumeProvider {
  createVolume(input: CreateVolumeRequest): Promise<Volume>;
  attachVolume(volumeId: string, vmId: string): Promise<void>;
  detachVolume(volumeId: string, vmId: string): Promise<void>;
  deleteVolume(id: string): Promise<void>;
  listVolumes(): Promise<Volume[]>;
}
