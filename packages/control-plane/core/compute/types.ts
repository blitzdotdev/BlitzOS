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
  /** Epoch ms from which this provider's guests enforce viewer read-only
   * correctly. Undefined is "never": viewers are refused. */
  webAppViewerGuardsSinceMs?: number;
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
  /** Every entry states a monthly price, or states null for no price.
   * `monthlyPrice` is required, so a new provider cannot compile until it
   * answers. A provider that stays silent used to ship a blank price. */
  listMachineTypes(): Promise<ProviderMachineType[]>;
  createVm(input: CreateVmInput): Promise<CreatedVm>;
  shutdown(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  inspect(id: string): Promise<VmInspection | null>;
  /** Bash lines the bootstrap runs only on this provider's machines. They are
   * spliced into the shared apt setup. Return complete lines, each one ending
   * in a newline. Omit the member when the provider needs nothing extra.
   * AWS returns a probe for Canonical's EC2 mirrors. That probe lived in the
   * shared script until 2026-08-25 and killed every Hetzner box that ran it.
   * See plans/PROVIDER-BOOTSTRAP.md. */
  bootstrapAptSetup?(): string;
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
