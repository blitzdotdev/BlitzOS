import type { MachineType } from "../wire.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderCapabilities,
  SurfacePort,
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
    const settled = await Promise.allSettled([
      this.hetzner.listMachineTypes(),
      this.microvm.listMachineTypes(),
    ]);
    const types = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        const provider = index === 0 ? "hetzner" : "microvm";
        const reason =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        console.warn(`listMachineTypes: ${provider} provider unavailable: ${reason}`);
      }
    });
    if (types.length === 0) {
      const failure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    }
    return types;
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

  async proxySurface(
    id: string,
    port: SurfacePort,
    pathAndQuery: string,
    request: Request,
  ): Promise<Response | null> {
    return this.microvm.owns(id)
      ? this.microvm.proxySurface(id, port, pathAndQuery, request)
      : null;
  }
}
