import { describe, expect, it } from "vitest";
import { HttpError } from "../core/http.js";
import { VmProviderRegistry } from "../core/compute/registry.js";
import type {
  CreatedVm,
  CreateVmInput,
  ProviderMachineType,
  VmInspection,
  VmProvider,
} from "../core/compute/types.js";

class StubVmProvider implements VmProvider {
  constructor(
    readonly id: string,
    private readonly machineTypeId: string,
    private readonly vmId: string,
    private readonly listingError?: Error,
  ) {}

  ownsMachineType(machineTypeId: string): boolean {
    return machineTypeId === this.machineTypeId;
  }

  ownsVmId(vmId: string): boolean {
    return vmId === this.vmId;
  }

  capabilities() {
    return { volumes: this.id === "cloud", maxUserDataBytes: null };
  }

  async listMachineTypes(): Promise<ProviderMachineType[]> {
    if (this.listingError !== undefined) throw this.listingError;
    return [{
      id: this.machineTypeId,
      name: this.machineTypeId,
      cpuCores: 2,
      memGb: 4,
      diskGb: 20,
      arch: "x86",
      location: "test",
      // The stub declares a price so the aggregate proves it carries one
      // through, in the currency the provider named.
      monthlyPrice: { amount: 12.34, currency: "USD" },
    }];
  }

  async createVm(_input: CreateVmInput): Promise<CreatedVm> {
    return { id: this.vmId, host: "192.0.2.1", port: 22, user: "blitz" };
  }

  async shutdown(_id: string): Promise<void> {}
  async destroy(_id: string): Promise<void> {}

  async inspect(id: string): Promise<VmInspection | null> {
    return { id, host: "192.0.2.1", port: 22, user: "blitz", state: "running" };
  }
}

function expectHttp400(operation: () => unknown, message: string): void {
  try {
    operation();
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    expect(error.status).toBe(400);
    expect(error.message).toBe(message);
    return;
  }
  throw new Error("expected HttpError 400");
}

describe("VM provider registry", () => {
  it("routes machine types and VM IDs only when exactly one provider claims them", () => {
    const cloud = new StubVmProvider("cloud", "cx22@fsn1", "42");
    const microvm = new StubVmProvider("microvm", "mv-2c2g@lab", "microvm:v1:lab:1");
    const registry = new VmProviderRegistry([cloud, microvm]);

    expect(registry.get("cloud")).toBe(cloud);
    expect(registry.all()).toEqual([cloud, microvm]);
    expect(registry.forMachineType("cx22@fsn1")).toBe(cloud);
    expect(registry.forMachineType("mv-2c2g@lab")).toBe(microvm);
    expect(registry.forVmId("42")).toBe(cloud);
    expect(registry.forVmId("missing")).toBeUndefined();
  });

  it("rejects unknown and ambiguous machine type claims with clear 400 errors", () => {
    const first = new StubVmProvider("first", "shared", "first-vm");
    const second = new StubVmProvider("second", "shared", "second-vm");
    const registry = new VmProviderRegistry([first, second]);

    expectHttp400(
      () => registry.forMachineType("missing"),
      "unknown machine type: missing",
    );
    expectHttp400(
      () => registry.forMachineType("shared"),
      "machine type shared is claimed by multiple providers: first, second",
    );
  });

  it("rejects duplicate stable provider IDs at construction", () => {
    const first = new StubVmProvider("duplicate", "first", "first-vm");
    const second = new StubVmProvider("duplicate", "second", "second-vm");

    expect(() => new VmProviderRegistry([first, second])).toThrow(
      "duplicate VM provider id: duplicate",
    );
  });

  it("stamps aggregate listings and exposes partial provider failures", async () => {
    const cloud = new StubVmProvider("cloud", "cx22@fsn1", "42");
    const unavailable = new StubVmProvider(
      "microvm",
      "mv-2c2g@lab",
      "microvm:v1:lab:1",
      new Error("capacity unavailable"),
    );

    await expect(new VmProviderRegistry([cloud, unavailable]).listMachineTypes()).resolves.toEqual({
      machineTypes: [{
        id: "cx22@fsn1",
        providerId: "cloud",
        supportsVolumes: true,
        name: "cx22@fsn1",
        cpuCores: 2,
        memGb: 4,
        diskGb: 20,
        arch: "x86",
        location: "test",
        monthlyPrice: { amount: 12.34, currency: "USD" },
      }],
      failures: [{ providerId: "microvm", error: "capacity unavailable" }],
    });
  });
});
