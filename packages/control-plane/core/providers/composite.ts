import type { MachineType } from "../wire.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderCapabilities,
  VmInspection,
  VmProvider,
} from "./types.js";
import type { MicrovmPoolProvider } from "./microvm.js";

export class CompositeVmProvider implements VmProvider {
  constructor(
    private readonly hetzner: VmProvider,
    private readonly microvm: MicrovmPoolProvider,
  ) {}

  capabilities(): ProviderCapabilities {
    return this.hetzner.capabilities();
  }

  async listMachineTypes(): Promise<MachineType[]> {
    const [hetzner, microvm] = await Promise.all([
      this.hetzner.listMachineTypes(),
      this.microvm.listMachineTypes(),
    ]);
    return [...hetzner, ...microvm];
  }

  async createVm(input: CreateVmInput): Promise<CreatedVm> {
    return input.machineTypeId.startsWith("mv-")
      ? this.microvm.createVm(input)
      : this.hetzner.createVm(input);
  }

  async shutdown(id: string): Promise<void> {
    return this.microvm.owns(id)
      ? this.microvm.shutdown(id)
      : this.hetzner.shutdown(id);
  }

  async destroy(id: string): Promise<void> {
    return this.microvm.owns(id)
      ? this.microvm.destroy(id)
      : this.hetzner.destroy(id);
  }

  async inspect(id: string): Promise<VmInspection | null> {
    return this.microvm.owns(id)
      ? this.microvm.inspect(id)
      : this.hetzner.inspect(id);
  }
}
