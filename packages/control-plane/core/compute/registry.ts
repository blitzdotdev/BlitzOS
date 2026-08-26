import { HttpError } from "../http.js";
import type {
  MachineType,
  MachineTypeProviderFailure,
} from "../wire.js";
import type { ComputeCredentialSource, VmProvider } from "./types.js";

export interface VmProviderListResult {
  machineTypes: MachineType[];
  failures: MachineTypeProviderFailure[];
}

export interface ResolvedVmProvider {
  provider: VmProvider;
  credentialSource: ComputeCredentialSource | null;
}

export type VmProviderResolver = (
  provider: VmProvider,
  orgId: string,
  requiredSource?: ComputeCredentialSource | null,
) => Promise<ResolvedVmProvider | null>;

export class VmProviderRegistry {
  private readonly providers: readonly VmProvider[];
  private readonly providersById: ReadonlyMap<string, VmProvider>;

  constructor(
    providers: readonly VmProvider[],
    private readonly resolver?: VmProviderResolver,
  ) {
    const providersById = new Map<string, VmProvider>();
    for (const provider of providers) {
      if (provider.id === "") throw new Error("VM provider id must not be empty");
      if (providersById.has(provider.id)) {
        throw new Error(`duplicate VM provider id: ${provider.id}`);
      }
      providersById.set(provider.id, provider);
    }
    this.providers = [...providers];
    this.providersById = providersById;
  }

  get(id: string): VmProvider | undefined {
    return this.providersById.get(id);
  }

  all(): readonly VmProvider[] {
    return this.providers;
  }

  private machineTypeOwner(machineTypeId: string): VmProvider {
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

  forMachineType(machineTypeId: string): VmProvider;
  forMachineType(machineTypeId: string, orgId: string): Promise<ResolvedVmProvider>;
  forMachineType(
    machineTypeId: string,
    orgId?: string,
  ): VmProvider | Promise<ResolvedVmProvider> {
    const provider = this.machineTypeOwner(machineTypeId);
    return orgId === undefined
      ? provider
      : this.resolve(provider, orgId);
  }

  forVmId(vmId: string): VmProvider | undefined {
    const claimants = this.providers.filter((provider) => provider.ownsVmId(vmId));
    return claimants.length === 1 ? claimants[0] : undefined;
  }

  async resolveVmId(
    vmId: string,
    orgId: string,
    requiredSource?: ComputeCredentialSource | null,
  ): Promise<ResolvedVmProvider | undefined> {
    const provider = this.forVmId(vmId);
    return provider === undefined
      ? undefined
      : this.resolve(provider, orgId, requiredSource);
  }

  private async resolve(
    provider: VmProvider,
    orgId: string,
    requiredSource?: ComputeCredentialSource | null,
  ): Promise<ResolvedVmProvider> {
    const resolved = await this.resolver?.(provider, orgId, requiredSource);
    return resolved ?? { provider, credentialSource: null };
  }

  async listMachineTypes(
    orgId?: string,
    excludedProviderIds: ReadonlySet<string> = new Set(),
  ): Promise<VmProviderListResult> {
    const listedProviders = this.providers.filter(
      ({ id }) => !excludedProviderIds.has(id),
    );
    const settled = await Promise.allSettled(
      listedProviders.map(async (registered) => {
        const provider = orgId === undefined
          ? registered
          : (await this.resolve(registered, orgId)).provider;
        const capabilities = provider.capabilities();
        if (capabilities.offersMachineTypes === false) return { machineTypes: [] };
        const supportsVolumes = capabilities.volumes;
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
        providerId: listedProviders[index]?.id ?? "unknown",
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
