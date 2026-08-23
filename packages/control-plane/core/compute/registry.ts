import { HttpError } from "../http.js";
import type {
  MachineType,
  MachineTypeProviderFailure,
} from "../wire.js";
import type { VmProvider } from "./types.js";

export interface VmProviderListResult {
  machineTypes: MachineType[];
  failures: MachineTypeProviderFailure[];
}

export class VmProviderRegistry {
  private readonly providers: readonly VmProvider[];

  constructor(providers: readonly VmProvider[]) {
    const seenIds = new Set<string>();
    for (const provider of providers) {
      if (provider.id === "") throw new Error("VM provider id must not be empty");
      if (seenIds.has(provider.id)) {
        throw new Error(`duplicate VM provider id: ${provider.id}`);
      }
      seenIds.add(provider.id);
    }
    this.providers = [...providers];
  }

  all(): readonly VmProvider[] {
    return this.providers;
  }

  forMachineType(machineTypeId: string): VmProvider {
    const claimants = this.providers.filter((provider) =>
      provider.ownsMachineType(machineTypeId)
    );
    if (claimants.length === 0) {
      throw new HttpError(400, `unknown machine type: ${machineTypeId}`);
    }
    if (claimants.length > 1) {
      throw new HttpError(
        400,
        `machine type ${machineTypeId} is claimed by multiple providers: ${claimants.map(({ id }) => id).join(", ")}`,
      );
    }
    const provider = claimants[0];
    if (provider === undefined) throw new Error("VM provider claimant disappeared");
    return provider;
  }

  forVmId(vmId: string): VmProvider | undefined {
    const claimants = this.providers.filter((provider) => provider.ownsVmId(vmId));
    return claimants.length === 1 ? claimants[0] : undefined;
  }

  async listMachineTypes(): Promise<VmProviderListResult> {
    const settled = await Promise.allSettled(
      this.providers.map(async (provider) => {
        const supportsVolumes = provider.capabilities().volumes;
        const machineTypes = (await provider.listMachineTypes()).map((machineType) => ({
          ...machineType,
          providerId: provider.id,
          supportsVolumes,
        } satisfies MachineType));
        return { machineTypes };
      }),
    );
    const machineTypes = settled.flatMap((result) =>
      result.status === "fulfilled" ? result.value.machineTypes : []
    );
    const failures = settled.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      return [{
        providerId: this.providers[index]?.id ?? "unknown",
        error: result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      } satisfies MachineTypeProviderFailure];
    });
    if (machineTypes.length === 0) {
      const failure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    }
    return { machineTypes, failures };
  }
}
