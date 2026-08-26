import { describe, expect, it } from "vitest";
import type { ProviderMachineType } from "../core/compute/types.js";

/**
 * `tsc -p tsconfig.type-tests.json` checks this file, so the @ts-expect-error
 * below is a gate and not a comment. `npm run typecheck` runs it.
 */

/** What a new backend writes when nobody made it think about price. */
const forgetful = {
  id: "new-1@lab",
  name: "New 1",
  cpuCores: 2,
  memGb: 4,
  diskGb: 20,
  arch: "x86",
  location: "lab",
} as const;

describe("machine price contract", () => {
  it("refuses a provider that never answers on price", () => {
    // @ts-expect-error monthlyPrice is required, so this literal cannot be a
    // ProviderMachineType. Make the field optional again and this line stops
    // erroring, and the typecheck fails here instead. That is the point: a
    // silent provider must break the build, not ship a blank card.
    const machineType: ProviderMachineType = forgetful;

    expect(machineType.id).toBe("new-1@lab");
  });

  it("accepts a provider that declares it has no price", () => {
    const machineType: ProviderMachineType = { ...forgetful, monthlyPrice: null };

    expect(machineType.monthlyPrice).toBeNull();
  });

  it("accepts a provider that declares a price in its own currency", () => {
    const machineType: ProviderMachineType = {
      ...forgetful,
      monthlyPrice: { amount: 6.49, currency: "USD" },
    };

    expect(machineType.monthlyPrice).toEqual({ amount: 6.49, currency: "USD" });
  });
});
