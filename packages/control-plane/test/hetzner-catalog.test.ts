/**
 * The Hetzner catalog, and the stand-in it offers for a sold-out entry.
 *
 * The server-type payload below is a trimmed copy of the live one, read on
 * 2026-09-05: same cores, RAM, disk, category, prices and availability flags.
 * Hetzner had cx33 sold out in every EU location that day and cx23 sold out in
 * fsn1 alone, which is exactly the case this rule exists for.
 */
import { describe, expect, it } from "vitest";
import { HetznerProvider } from "../core/compute/hetzner.js";
import {
  hetznerCatalogWithStandIns,
  type HetznerOffer,
  type HetznerTypeSpec,
} from "../core/compute/hetzner-config.js";

const EU = ["fsn1", "nbg1", "hel1"] as const;
const US = ["ash", "hil"] as const;

interface FixtureType {
  name: string;
  category: string;
  cores: number;
  memory: number;
  disk: number;
  available: readonly string[];
  price: string;
}

/** Live figures, 2026-09-05. This account bills in USD. */
const FIXTURE: readonly FixtureType[] = [
  { name: "cx23", category: "cost_optimized", cores: 2, memory: 4, disk: 40, available: ["nbg1", "hel1"], price: "6.4900" },
  { name: "cx33", category: "cost_optimized", cores: 4, memory: 8, disk: 80, available: [], price: "9.9900" },
  { name: "cpx22", category: "regular_purpose", cores: 2, memory: 4, disk: 80, available: EU, price: "22.9900" },
  { name: "cpx32", category: "regular_purpose", cores: 4, memory: 8, disk: 160, available: EU, price: "41.9900" },
  { name: "cpx21", category: "regular_purpose", cores: 3, memory: 4, disk: 80, available: US, price: "10.9900" },
  { name: "cpx31", category: "regular_purpose", cores: 4, memory: 8, disk: 160, available: US, price: "20.4900" },
  // The dedicated line is in stock everywhere and must never be a stand-in:
  // it costs another order again.
  { name: "ccx23", category: "general_purpose", cores: 4, memory: 16, disk: 160, available: [...EU, ...US], price: "101.4900" },
];

const ALL_LOCATIONS = [...EU, ...US];

function serverTypesPayload(): unknown {
  return {
    server_types: FIXTURE.map((type, index) => ({
      id: index + 1,
      name: type.name,
      category: type.category,
      cpu_type: "shared",
      architecture: "x86",
      cores: type.cores,
      memory: type.memory,
      disk: type.disk,
      deprecated: false,
      deprecation: null,
      locations: ALL_LOCATIONS.map((location, locationIndex) => ({
        id: locationIndex + 1,
        name: location,
        available: type.available.includes(location),
        recommended: false,
        deprecation: null,
      })),
      prices: ALL_LOCATIONS.map((location) => ({
        location,
        price_monthly: { gross: type.price },
      })),
    })),
    meta: { pagination: { next_page: null } },
  };
}

function hetznerFetcher(): (input: RequestInfo | URL) => Promise<Response> {
  return (input) => {
    const url = String(input);
    if (url.includes("/pricing")) {
      return Promise.resolve(Response.json({ pricing: { currency: "USD" } }));
    }
    if (url.includes("/server_types")) {
      return Promise.resolve(Response.json(serverTypesPayload()));
    }
    throw new Error(`unexpected Hetzner request ${url}`);
  };
}

function provider(catalog: string): HetznerProvider {
  return new HetznerProvider("test-token", {
    fetcher: hetznerFetcher(),
    machineTypeCatalog: catalog,
  });
}

/** `id` → what a card would say about being a stand-in. */
async function offering(catalog: string): Promise<Record<string, string | null>> {
  const types = await provider(catalog).listMachineTypes();
  return Object.fromEntries(types.map((type) => [type.id, type.standsInFor]));
}

describe("the Hetzner catalog stands in for a sold-out entry", () => {
  it("offers the RAM-equal regular type in the same location", async () => {
    // The shipped default catalog, unchanged.
    const catalog = [
      "cx23@nbg1", "cx33@nbg1",
      "cx23@fsn1", "cx33@fsn1",
      "cx23@hel1", "cx33@hel1",
      "cpx21@hil", "cpx31@hil",
    ].join(",");

    expect(await offering(catalog)).toEqual({
      // In stock, so they are offered as themselves.
      "cx23@nbg1": null,
      "cx23@hel1": null,
      "cpx21@hil": null,
      "cpx31@hil": null,
      // cx33 is sold out in all three, so each gets the RAM-equal cpx32.
      "cpx32@nbg1": "cx33",
      "cpx32@fsn1": "cx33",
      "cpx32@hel1": "cx33",
      // cx23 is sold out in fsn1 alone, so only fsn1 gets cpx22.
      "cpx22@fsn1": "cx23",
    });
  });

  it("shows no stand-in where the cost-optimized type is in stock", async () => {
    // hel1 has cx23 on the shelf, so no cpx22 appears beside it. nbg1 is the
    // same. fsn1 does not, so its stand-in is the whole answer.
    expect(await offering("cx23@hel1")).toEqual({ "cx23@hel1": null });
    expect(await offering("cx23@fsn1")).toEqual({ "cpx22@fsn1": "cx23" });
  });

  it("never crosses a location, because a volume cannot", async () => {
    // cx43 is not in the payload at all, and cx33@fsn1 must not reach for a
    // cpx32 in nbg1 even though one is in stock there.
    const offered = await offering("cx33@fsn1");
    expect(Object.keys(offered)).toEqual(["cpx32@fsn1"]);
  });

  it("never stands in with the dedicated line", async () => {
    // 16 GB has exactly one match in stock, ccx23, and it is general_purpose.
    // A silent jump from a $35 machine to a $101 one is not a stand-in.
    const specs = new Map<string, HetznerTypeSpec>([
      ["cx53", { category: "cost_optimized", cpuCores: 16, memGb: 16 }],
    ]);
    const offers: HetznerOffer[] = [{
      category: "general_purpose",
      machineType: {
        id: "ccx23@hel1",
        name: "ccx23",
        cpuCores: 4,
        memGb: 16,
        diskGb: 160,
        arch: "x86",
        location: "hel1",
        monthlyPrice: { amount: 101.49, currency: "USD" },
        standsInFor: null,
      },
    }];
    expect(hetznerCatalogWithStandIns(offers, specs, new Set(["cx53@hel1"]))).toEqual([]);
  });

  it("never stands in for a regular type, only a cost-optimized one", async () => {
    // cpx21 is sold out in the EU. It is not a cost-optimized entry, so the
    // row goes away exactly as it always did.
    expect(await offering("cpx21@hel1")).toEqual({});
  });

  it("never lets two sold-out entries land on the same stand-in", async () => {
    // Both name 4 GB, and only one 4 GB regular type is in stock in fsn1.
    const specs = new Map<string, HetznerTypeSpec>([
      ["cx23", { category: "cost_optimized", cpuCores: 2, memGb: 4 }],
      ["cax11", { category: "cost_optimized", cpuCores: 2, memGb: 4 }],
    ]);
    const offers: HetznerOffer[] = [{
      category: "regular_purpose",
      machineType: {
        id: "cpx22@fsn1",
        name: "cpx22",
        cpuCores: 2,
        memGb: 4,
        diskGb: 80,
        arch: "x86",
        location: "fsn1",
        monthlyPrice: { amount: 22.99, currency: "USD" },
        standsInFor: null,
      },
    }];
    const catalog = hetznerCatalogWithStandIns(
      offers,
      specs,
      new Set(["cx23@fsn1", "cax11@fsn1"]),
    );
    expect(catalog.map((type) => [type.id, type.standsInFor])).toEqual([
      ["cpx22@fsn1", "cx23"],
    ]);
  });

  it("prefers the same cpu count over the cheaper machine", async () => {
    const specs = new Map<string, HetznerTypeSpec>([
      ["cx33", { category: "cost_optimized", cpuCores: 4, memGb: 8 }],
    ]);
    const sameCpu = {
      category: "regular_purpose",
      machineType: {
        id: "cpx32@hel1",
        name: "cpx32",
        cpuCores: 4,
        memGb: 8,
        diskGb: 160,
        arch: "x86" as const,
        location: "hel1",
        monthlyPrice: { amount: 41.99, currency: "USD" },
        standsInFor: null,
      },
    };
    const cheaper = {
      category: "regular_purpose",
      machineType: {
        ...sameCpu.machineType,
        id: "cpx99@hel1",
        name: "cpx99",
        cpuCores: 2,
        monthlyPrice: { amount: 30, currency: "USD" },
      },
    };
    const catalog = hetznerCatalogWithStandIns(
      [cheaper, sameCpu],
      specs,
      new Set(["cx33@hel1"]),
    );
    expect(catalog.map((type) => type.id)).toEqual(["cpx32@hel1"]);
  });
});
