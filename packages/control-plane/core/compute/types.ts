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
  /** True when the provider attaches volumes as part of the VM create call,
   * so the disk is present before the guest's first boot. A provider that
   * answers false (or stays silent) is attached after create, which races the
   * guest's one-shot device scan in `core/bootstrap.ts`. */
  attachesVolumesAtCreate?: boolean;
  /** False keeps this provider's machine types off the create page while
   * leaving it registered for lifecycle. Undefined and true both offer them.
   * Dropping a provider from the registry instead would strand every VM it
   * already owns as an unowned id, which the registry refuses with a 409 and
   * the janitors skip. */
  offersMachineTypes?: boolean;
}

export interface CreateVmInput {
  workspaceId: string;
  /** The machine this VM is an incarnation of. It names the server, because a
   * workspace holds one VM per member now and a provider that names servers
   * after the workspace would collide on the second member. The workspace id
   * stays as the label operators match resources by. */
  machineId: string;
  machineTypeId: string;
  sshPublicKey?: string;
  phoneHomeUrl: string;
  userData: string;
  /** Volumes to attach during create, for a provider whose capabilities claim
   * `attachesVolumesAtCreate`. Every id must already exist in the same
   * location as the machine type. Providers that do not claim the capability
   * ignore this field and are attached afterwards. */
  volumeIds?: readonly string[];
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
  /** The location an auto-created workspace volume must be placed in for this
   * machine type, or null when the provider cannot say. The machine-type id
   * format belongs to the provider (`cx23@hel1` is a Hetzner shape), so the
   * question is asked here rather than parsed by core. A provider that omits
   * the member gets no auto-created volume, which is the honest answer for a
   * backend whose placement is not known until the VM exists. */
  volumeLocation?(machineTypeId: string): string | null;
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

export type ComputeCredentialSource = "org" | "deployment";

export interface ResolvedVolumeProvider {
  provider: VolumeProvider;
  credentialSource: ComputeCredentialSource | null;
}

export interface VolumeProviderResolver {
  forOrg(
    orgId: string,
    requiredSource?: ComputeCredentialSource | null,
  ): Promise<ResolvedVolumeProvider>;
}
