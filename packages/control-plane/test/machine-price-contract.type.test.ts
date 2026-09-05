import { describe, expect, it } from "vitest";
import type { ProviderMachineType } from "../core/compute/types.js";

/**
 * `tsc -p tsconfig.type-tests.json` checks this file, so each
 * @ts-expect-error below is a gate and not a comment. `npm run typecheck`
 * runs it.
 *
 * Each gate leaves out ONE field. A literal missing two required fields still
 * errors when one of them goes optional again, so the gate would keep passing
 * while it had stopped testing anything.
 */

/** What a new backend writes when nobody made it think about either field. */
const bare = {
  id: "new-1@lab",
  name: "New 1",
  cpuCores: 2,
  memGb: 4,
  diskGb: 20,
  arch: "x86",
  location: "lab",
} as const;

/** Silent on price, and on price alone. */
const forgetful = { ...bare, standsInFor: null } as const;

/** Silent on the stand-in, and on that alone. */
const unlabelled = { ...bare, monthlyPrice: null } as const;

describe("machine price contract", () => {
  it("refuses a provider that never answers on price", () => {
    // @ts-expect-error monthlyPrice is required, so this literal cannot be a
    // ProviderMachineType. Make the field optional again and this line stops
    // erroring, and the typecheck fails here instead. That is the point: a
    // silent provider must break the build, not ship a blank card.
    const machineType: ProviderMachineType = forgetful;

    expect(machineType.id).toBe("new-1@lab");
  });

  it("refuses a provider that never answers on the stand-in", () => {
    // @ts-expect-error standsInFor is required for the same reason. A
    // provider that says nothing must not leave a card claiming, by silence,
    // that it is offered in its own right.
    const machineType: ProviderMachineType = unlabelled;

    expect(machineType.id).toBe("new-1@lab");
  });

  it("accepts a provider that declares it has no price", () => {
    const machineType: ProviderMachineType = { ...bare, monthlyPrice: null, standsInFor: null };

    expect(machineType.monthlyPrice).toBeNull();
  });

  it("accepts a provider that declares a price in its own currency", () => {
    const machineType: ProviderMachineType = {
      ...bare,
      monthlyPrice: { amount: 6.49, currency: "USD" },
      standsInFor: null,
    };

    expect(machineType.monthlyPrice).toEqual({ amount: 6.49, currency: "USD" });
  });

  it("accepts a provider that names the sold-out entry it replaces", () => {
    const machineType: ProviderMachineType = {
      ...bare,
      monthlyPrice: { amount: 41.99, currency: "USD" },
      standsInFor: "cx33",
    };

    expect(machineType.standsInFor).toBe("cx33");
  });
});
