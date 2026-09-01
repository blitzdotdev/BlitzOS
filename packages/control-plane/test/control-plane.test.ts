import type {
  FeedResponse,
  ListMachineTypesResponse,
  PollResponse,
  RegisterKeysResponse,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAZY_SWEEP_INTERVAL_MS,
  maybeScheduleLazySweep,
  runInvariantSweep,
  runOrphanSweep,
  VmProviderRegistry,
} from "../core/index.js";
import { buildUserData } from "../core/cloud-init.js";
import { hashSecret } from "../core/crypto.js";
import {
  BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,
  BOX_IMAGE_TICKETS_SINCE_MS,
  BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
} from "../core/webapp-tickets.js";
import {
  DEFAULT_HETZNER_MACHINE_TYPES,
  HetznerProvider,
  hetznerMachineTypeAllowlistFromEnv,
} from "../core/compute/hetzner.js";
import worker from "../src/worker.js";
import {
  OPERATOR_KEY,
  appWithProviders,
  appRequest,
  createWorkspace,
  enrollBox,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  testRuntime,
  userSession,
  machineIdFor,
} from "./helpers.js";

interface WorkspaceResponse {
  workspace: WorkspaceView;
}

/**
 * The broker unix name `core/registry.ts` derives for the `operator`
 * principal. A golden, not a re-derivation: recomputing it with the same
 * primitive the route uses would pass for any algorithm, including one that
 * silently started handing two members the same home.
 */
const OPERATOR_BROKER_NAME = "m-06e55b633481";
const BROKER_NAME_PATTERN = /^m-[0-9a-f]{12}$/u;

/**
 * Listing the Hetzner catalog reads two endpoints: the paged /server_types,
 * and /pricing for the billing currency. One canned response cannot serve
 * both, and a Response body reads once, so the tests answer by URL and build
 * a fresh Response for every call.
 */
function mockHetznerApi(serverTypes: () => Response, pricing: () => Response): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
    Promise.resolve(String(input).includes("/pricing") ? pricing() : serverTypes())
  );
}

/** The /v1/pricing answer, cut down to the field the provider reads. */
function hetznerPricing(currency: string): Response {
  return Response.json({ pricing: { currency, vat_rate: "0.000000" } });
}

/** Enrol `box` as a broker box reachable at `host`. */
async function enrollBroker(
  app: ReturnType<typeof harness>["app"],
  box: { box_id: string; access_token: string },
  host: string,
): Promise<void> {
  const response = await appRequest(app, `/boxes/${box.box_id}/broker`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${box.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ host, port: 22, sshHostPublicKey: "ssh-ed25519 AAAAbroker" }),
  });
  if (response.status !== 204) throw new Error(`broker enrolment failed: ${response.status}`);
}

/** Create a workspace for `cookie`'s principal and phone it home into a box. */
async function workspaceBox(
  app: ReturnType<typeof harness>["app"],
  providers: ReturnType<typeof harness>["providers"],
  cookie: string,
): Promise<{ box_id: string; access_token: string; workspaceId: string }> {
  const workspace = await createWorkspace(app, cookie);
  const ready = await app.request(
    phoneHomeUrl(providers, workspace.id),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
    },
    { DB: env.DB },
  );
  const box = await ready.json<{ box_id: string; access_token: string }>();
  return { ...box, workspaceId: workspace.id };
}

/** The broker's own view of one box: what `blitz-broker sync` would apply. */
async function brokerFeed(
  app: ReturnType<typeof harness>["app"],
  broker: { box_id: string; access_token: string },
): Promise<FeedResponse> {
  const response = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
    headers: { Authorization: `Bearer ${broker.access_token}` },
  });
  if (response.status !== 200) throw new Error(`feed failed: ${response.status}`);
  return response.json<FeedResponse>();
}

/** Register one mint + one deposit key for a workspace box. */
function registerKeys(
  app: ReturnType<typeof harness>["app"],
  box: { box_id: string; access_token: string },
  suffix = "",
): Promise<Response> {
  return appRequest(app, `/boxes/${box.box_id}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${box.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      keys: [
        { pubkey: `ssh-ed25519 AAAAmint${suffix}`, op: "mint" },
        { pubkey: `ssh-ed25519 AAAAdeposit${suffix}`, op: "deposit" },
      ],
    }),
  });
}

describe("control plane security and lifecycle", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose operator-key session exchange or authenticate routes", async () => {
    const { app } = harness();
    const absent = await appRequest(app, "/sessions", { method: "POST" });
    const keyed = await appRequest(app, "/machine-types", {
      headers: { Authorization: `Bearer ${OPERATOR_KEY}` },
    });
    expect(absent.status).toBe(404);
    expect(keyed.status).toBe(401);
  });

  it("stores only a hash for a user session with the default expiry", async () => {
    const { app } = harness();
    const defaultCookie = await operatorSession(app);
    const defaultToken = defaultCookie.slice(defaultCookie.indexOf("=") + 1);
    const defaultRow = await env.DB
      .prepare("SELECT created_at, expires_at FROM sessions WHERE token_hash = ?1")
      .bind(await hashSecret(defaultToken))
      .first<{ created_at: number; expires_at: number }>();
    expect(defaultRow).not.toBeNull();
    expect((defaultRow?.expires_at ?? 0) - (defaultRow?.created_at ?? 0)).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    expect(defaultRow?.created_at).not.toBe(defaultToken);
  });

  it("returns 401 for expired sessions", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    await env.DB.prepare("UPDATE sessions SET expires_at = 0").run();

    const response = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized", retryAction: null });
  });

  it("deletes expired sessions from scheduled and lazy janitors", async () => {
    const { providers } = harness();
    await env.DB
      .prepare(
        `INSERT INTO principals (id, unix_name, harnesses)
         VALUES ('janitor-principal', 'janitor', '[]')`,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO sessions (token_hash, principal_id, created_at)
         VALUES ('scheduled-expired', 'janitor-principal', 0)`,
      )
      .run();

    const executionContext = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }),
      env as never,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE token_hash = 'scheduled-expired'")
        .first<number>("count"),
    ).toBe(0);

    await env.DB
      .prepare(
        `INSERT INTO sessions (token_hash, principal_id, created_at, expires_at)
         VALUES ('lazy-expired', 'janitor-principal', 0, 0)`,
      )
      .run();
    let scheduled: Promise<unknown> | undefined;
    const runtime = {
      ...testRuntime(providers),
      waitUntil(promise: Promise<unknown>) {
        scheduled = promise;
      },
    };
    maybeScheduleLazySweep(runtime, "/sessions");
    await scheduled;
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE token_hash = 'lazy-expired'")
        .first<number>("count"),
    ).toBe(0);
  });

  it("lists machine types for an authenticated operator", async () => {
    const { app, providers } = harness();
    const unauthenticated = await appRequest(app, "/machine-types");
    expect(unauthenticated.status).toBe(401);

    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/machine-types", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json<ListMachineTypesResponse>()).toEqual({
      ...await new VmProviderRegistry([providers]).listMachineTypes(),
      providerStatuses: [],
    });
  });

  it("rejects an unknown machine type before inserting a workspace", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);

    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "unknown-machine" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "unknown machine type: unknown-machine",
      retryAction: null,
    });
    expect(providers.createCalls).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<number>("count"),
    ).toBe(0);
  });

  it("returns a clear error instead of falling back for an unowned workspace VM ID", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await env.DB
      .prepare("UPDATE machines SET state = 'running', vm_id = 'unowned' WHERE workspace_id = ?1")
      .bind(workspace.id)
      .run();

    const webApp = await appRequest(
      app,
      `/workspaces/${workspace.id}/webapp/7445/ports`,
      { headers: { Cookie: cookie } },
    );
    const destroy = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    for (const response of [webApp, destroy]) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "no VM provider owns VM ID unowned",
        retryAction: null,
      });
    }
    expect(providers.destroyCalls).toBe(0);
    expect(
      await env.DB.prepare("SELECT state FROM machines WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<string>("state"),
    // The destroy reached the provider lookup and stopped there, so the
    // machine is left mid-flight for the janitor rather than tombstoned.
    ).toBe("destroying");
  });

  it("creates workspaces without an SSH key and normalizes blank keys to absence", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);

    for (const sshPublicKey of [undefined, "", " \t\n "]) {
      const response = await appRequest(app, "/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          machineTypeId: "small",
          ...(sshPublicKey === undefined ? {} : { sshPublicKey }),
        }),
      });

      expect(response.status).toBe(201);
      const { workspace } = await response.json<WorkspaceResponse>();
      expect(workspace.createdAt).toBeTypeOf("number");
      expect(workspace.updatedAt).toBeGreaterThanOrEqual(workspace.createdAt);
      const userData = providers.userData.get(workspace.id);
      expect(userData).toBeDefined();
      expect(userData).not.toContain("ssh_authorized_keys");
      expect(userData).not.toContain("SSH_PUBLIC_KEY");
      expect(userData).toContain(
        "[ -e /var/lib/blitz/authorized_key ] || : >/var/lib/blitz/authorized_key",
      );
      expect(userData).toContain(
        "src=/var/lib/blitz/authorized_key,dst=/run/blitz/authorized_key,readonly",
      );
      expect(providers.sshPublicKeys.get(workspace.id)).toBeUndefined();
    }
    expect(providers.createCalls).toBe(3);
  });

  // The workspace-level sshPublicKey field is DELETED (a legacy decision that
  // outlived its reason). A key reaches a machine through
  // POST /machines/:id/provision|recreate and nowhere else, so these pin the
  // field's ABSENCE rather than its behaviour.
  it("no longer accepts an sshPublicKey at workspace creation", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
      }),
    });

    // Ignored, not refused: an old client that still sends one keeps working
    // and simply gets a machine with no key.
    expect(response.status).toBe(201);
    const { workspace } = await response.json<WorkspaceResponse>();
    expect(providers.sshPublicKeys.get(workspace.id)).toBeUndefined();
    expect(providers.userData.get(workspace.id)).not.toContain("SSH_PUBLIC_KEY");
  });

  it("does not validate a workspace-level sshPublicKey, because there is none", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small", sshPublicKey: "not-a-key" }),
    });

    expect(response.status).toBe(201);
    expect(providers.createCalls).toBe(1);
  });

  it("filters deprecated and non-allowlisted Hetzner machine types from the API response", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server_types: [
          {
            name: "cpx31",
            cores: 4,
            memory: 8,
            disk: 160,
            architecture: "x86",
            deprecation: {
              announced: "2025-10-16T06:00:00Z",
              unavailable_after: "2025-12-31T23:59:59Z",
            },
            locations: [{ name: "hil", available: true, deprecation: null }],
          },
          {
            name: "cpx21",
            cores: 3,
            memory: 4,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [
              {
                name: "hil",
                available: true,
                deprecation: {
                  announced: "2026-01-01T00:00:00Z",
                  unavailable_after: "2026-06-01T00:00:00Z",
                },
              },
              { name: "ash", available: true, deprecation: null },
            ],
          },
          {
            name: "cx23",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "fsn1", available: true, deprecation: null }],
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const provider = new HetznerProvider("test-token");
    const app = appWithProviders(provider, provider);
    const cookie = await operatorSession(app);

    const response = await appRequest(app, "/machine-types", {
      headers: { Cookie: cookie },
    });

    // cpx31@hil is allowlisted but type-deprecated; cpx21@hil is allowlisted
    // but location-deprecated; cpx21@ash and cx23@fsn1 are healthy but not
    // allowlisted.
    expect(response.status).toBe(200);
    const body = await response.json<ListMachineTypesResponse>();
    expect(body.machineTypes.map(({ id }) => id)).toEqual([]);
    const listHeaders = fetchMock.mock.calls[0]?.[1]?.headers ?? {};
    expect(Object.keys(listHeaders)).toEqual(["Authorization"]);
    expect("Content-Type" in listHeaders).toBe(false);
    expect(JSON.stringify(listHeaders)).toBe('{"Authorization":"Bearer test-token"}');
  });

  it("caps Hetzner JSON responses before parsing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { headers: { "Content-Length": "65537" } }),
    );
    const provider = new HetznerProvider("test-token");

    await expect(provider.listMachineTypes()).rejects.toThrow("Hetzner response is too large");
  });

  it("recognizes only Hetzner's letter-then-digit server type and decimal VM ID grammars", () => {
    const provider = new HetznerProvider("test-token");

    expect(provider.ownsMachineType("cx22@fsn1")).toBe(true);
    expect(provider.ownsMachineType("cpx31@nbg1")).toBe(true);
    expect(provider.ownsMachineType("cax11")).toBe(true);
    expect(provider.ownsMachineType("cx-22@fsn1")).toBe(false);
    expect(provider.ownsMachineType("mv-2c2g@lab")).toBe(false);
    expect(provider.ownsVmId("12345678")).toBe(true);
    expect(provider.ownsVmId("microvm:v1:lab:vm-1")).toBe(false);
  });

  it("excludes Hetzner machine types with no currently available placement", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server_types: [
          {
            id: 104,
            name: "cx22",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [
              { id: 1, name: "fsn1", available: false, deprecation: null },
              { id: 2, name: "nbg1", available: false, deprecation: null },
            ],
          },
          {
            id: 105,
            name: "cx23",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [],
          },
          {
            id: 106,
            name: "cpx21",
            cores: 3,
            memory: 4,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [
              { id: 2, name: "hil", available: true, deprecation: null },
            ],
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const provider = new HetznerProvider("test-token");

    expect((await provider.listMachineTypes()).map(({ id }) => id)).toEqual([
      "cpx21@hil",
    ]);
  });

  it("keeps the four-type default catalog when HETZNER_MACHINE_TYPES is unset or blank", () => {
    expect(DEFAULT_HETZNER_MACHINE_TYPES).toEqual([
      "cx23@hel1",
      "cx33@hel1",
      "cpx21@hil",
      "cpx31@hil",
    ]);
    expect([...hetznerMachineTypeAllowlistFromEnv(undefined)].sort()).toEqual([
      "cpx21@hil",
      "cpx31@hil",
      "cx23@hel1",
      "cx33@hel1",
    ]);
    expect([...hetznerMachineTypeAllowlistFromEnv("  ")].sort()).toEqual([
      "cpx21@hil",
      "cpx31@hil",
      "cx23@hel1",
      "cx33@hel1",
    ]);
  });

  it("keeps the default catalog's Helsinki cx types through the allowlist filter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server_types: [
          {
            name: "cx23",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [
              { name: "hel1", available: true, deprecation: null },
              { name: "fsn1", available: true, deprecation: null },
            ],
          },
          {
            name: "cx33",
            cores: 4,
            memory: 8,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "hel1", available: true, deprecation: null }],
          },
          {
            name: "cpx31",
            cores: 4,
            memory: 8,
            disk: 160,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "hil", available: true, deprecation: null }],
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const provider = new HetznerProvider("test-token");

    // cx23@fsn1 is healthy but not allowlisted; only hel1 carries the cx line
    // in the default catalog. This fixture carries no prices, so each entry
    // states null rather than staying silent.
    expect(await provider.listMachineTypes()).toEqual([
      {
        id: "cx23@hel1",
        name: "cx23",
        cpuCores: 2,
        memGb: 4,
        diskGb: 40,
        arch: "x86",
        location: "hel1",
        monthlyPrice: null,
      },
      {
        id: "cx33@hel1",
        name: "cx33",
        cpuCores: 4,
        memGb: 8,
        diskGb: 80,
        arch: "x86",
        location: "hel1",
        monthlyPrice: null,
      },
      {
        id: "cpx31@hil",
        name: "cpx31",
        cpuCores: 4,
        memGb: 8,
        diskGb: 160,
        arch: "x86",
        location: "hil",
        monthlyPrice: null,
      },
    ]);
  });

  /** Two locations, two prices. The fsn1 row comes first and costs less. */
  function twoPricedLocations(): Response {
    return Response.json({
      server_types: [
        {
          name: "cx23",
          cores: 2,
          memory: 4,
          disk: 40,
          architecture: "x86",
          deprecation: null,
          locations: [
            { name: "fsn1", available: true, deprecation: null },
            { name: "hel1", available: true, deprecation: null },
          ],
          prices: [
            // A first-entry read would under-price the Helsinki card by 66
            // cents each month.
            {
              location: "fsn1",
              price_hourly: { gross: "0.0092", net: "0.0077" },
              price_monthly: { gross: "5.8300", net: "4.9000" },
            },
            {
              location: "hel1",
              price_hourly: { gross: "0.0104", net: "0.0087" },
              price_monthly: { gross: "6.4900", net: "5.4538" },
            },
          ],
        },
      ],
      meta: { pagination: { next_page: null } },
    });
  }

  it("takes the Hetzner monthly price from the entry for the machine's own location", async () => {
    mockHetznerApi(twoPricedLocations, () => hetznerPricing("EUR"));
    const provider = new HetznerProvider("test-token", {
      machineTypeCatalog: "cx23@fsn1,cx23@hel1",
    });

    // Gross, because gross is what the customer pays.
    expect(
      (await provider.listMachineTypes()).map(({ id, monthlyPrice }) => ({ id, monthlyPrice })),
    ).toEqual([
      { id: "cx23@fsn1", monthlyPrice: { amount: 5.83, currency: "EUR" } },
      { id: "cx23@hel1", monthlyPrice: { amount: 6.49, currency: "EUR" } },
    ]);
  });

  // Hetzner bills some accounts in euro and some in dollars, and /server_types
  // names no currency. The provider read a "EUR" constant, so the real account
  // behind this repo, which Hetzner bills in USD, showed "€6.49/mo".
  it("takes the Hetzner currency from the vendor, in euro or in dollars", async () => {
    for (const currency of ["EUR", "USD"]) {
      mockHetznerApi(twoPricedLocations, () => hetznerPricing(currency));
      const provider = new HetznerProvider("test-token", {
        machineTypeCatalog: "cx23@hel1",
      });

      expect((await provider.listMachineTypes())[0]?.monthlyPrice).toEqual({
        amount: 6.49,
        currency,
      });
      vi.restoreAllMocks();
    }
  });

  it("asks Hetzner for the currency once, beside the catalog pages", async () => {
    mockHetznerApi(twoPricedLocations, () => hetznerPricing("USD"));
    const fetchMock = vi.mocked(globalThis.fetch);

    await new HetznerProvider("test-token").listMachineTypes();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((url) => url.includes("/pricing")).length).toBe(1);
    // The catalog page is asked for first, so the currency never delays it.
    expect(urls[0]).toContain("/server_types");
  });

  it("leaves the price out when Hetzner states no usable currency", async () => {
    const warnings: string[] = [];
    // Hetzner answers /pricing, but the currency is not an ISO 4217 code.
    // A price with no currency is worse than no price: the card would have to
    // guess a sign, and guessing a sign is the defect this test guards.
    mockHetznerApi(twoPricedLocations, () => Response.json({ pricing: { currency: "euro" } }));
    const provider = new HetznerProvider("test-token", {
      machineTypeCatalog: "cx23@hel1",
      warn: (warning) => warnings.push(warning.event),
    });

    const machineTypes = await provider.listMachineTypes();

    expect(machineTypes.map(({ id, monthlyPrice }) => ({ id, monthlyPrice }))).toEqual([
      { id: "cx23@hel1", monthlyPrice: null },
    ]);
    expect(warnings).toEqual(["hetzner_price_currency_unavailable"]);
  });

  it("still lists Hetzner machines when the currency request fails", async () => {
    const warnings: string[] = [];
    // The /pricing response was 41.9 KiB against a 64 KiB cap on 2026-08-25
    // and it grows. Losing every machine over a missing currency would be a
    // worse outage than losing the price label.
    mockHetznerApi(
      twoPricedLocations,
      () => new Response("{}", { headers: { "Content-Length": "65537" } }),
    );
    const provider = new HetznerProvider("test-token", {
      machineTypeCatalog: "cx23@hel1",
      warn: (warning) => warnings.push(warning.event),
    });

    const machineTypes = await provider.listMachineTypes();

    expect(machineTypes.map(({ id }) => id)).toEqual(["cx23@hel1"]);
    expect(machineTypes[0]?.monthlyPrice).toBeNull();
    expect(warnings).toEqual(["hetzner_price_currency_unavailable"]);
  });

  it("leaves the Hetzner price out when the vendor entry is missing or malformed", async () => {
    mockHetznerApi(() => Response.json({
        server_types: [
          {
            // No prices array at all.
            name: "cx23",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "hel1", available: true, deprecation: null }],
          },
          {
            // Priced, but only for a location this machine does not sit in.
            name: "cx33",
            cores: 4,
            memory: 8,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "hel1", available: true, deprecation: null }],
            prices: [{ location: "fsn1", price_monthly: { gross: "9.99", net: "8.39" } }],
          },
          {
            // Blank gross. Number(" ") is 0, and a free machine is a lie.
            name: "cpx21",
            cores: 3,
            memory: 4,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "hil", available: true, deprecation: null }],
            prices: [{ location: "hil", price_monthly: { gross: " ", net: " " } }],
          },
          {
            // Gross is words, not digits.
            name: "cpx31",
            cores: 4,
            memory: 8,
            disk: 160,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "hil", available: true, deprecation: null }],
            prices: [{ location: "hil", price_monthly: { gross: "on request" } }],
          },
          {
            // Gross is a JSON number. Hetzner documents a string.
            name: "cax11",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "arm",
            deprecation: null,
            locations: [{ name: "fsn1", available: true, deprecation: null }],
            prices: [{ location: "fsn1", price_monthly: { gross: 3.79 } }],
          },
        ],
        meta: { pagination: { next_page: null } },
      }), () => hetznerPricing("USD"));
    const provider = new HetznerProvider("test-token", {
      machineTypeCatalog: "cx23@hel1,cx33@hel1,cpx21@hil,cpx31@hil,cax11@fsn1",
    });

    // Every card still lists. None of them shows a price, and none of them
    // shows a wrong one.
    expect(
      (await provider.listMachineTypes()).map(({ id, monthlyPrice }) => ({ id, monthlyPrice })),
    ).toEqual([
      { id: "cx23@hel1", monthlyPrice: null },
      { id: "cx33@hel1", monthlyPrice: null },
      { id: "cpx21@hil", monthlyPrice: null },
      { id: "cpx31@hil", monthlyPrice: null },
      { id: "cax11@fsn1", monthlyPrice: null },
    ]);
  });

  it("offers the HETZNER_MACHINE_TYPES catalog instead of the default", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server_types: [
          {
            name: "cpx21",
            cores: 3,
            memory: 4,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [
              { name: "hil", available: true, deprecation: null },
              { name: "ash", available: true, deprecation: null },
            ],
          },
          {
            name: "cx23",
            cores: 2,
            memory: 4,
            disk: 40,
            architecture: "x86",
            deprecation: null,
            locations: [{ name: "fsn1", available: true, deprecation: null }],
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const provider = new HetznerProvider("test-token", {
      machineTypeCatalog: " cpx21@ash, cx23@fsn1 ",
    });

    // cpx21@hil is in the default catalog but not the configured one.
    expect((await provider.listMachineTypes()).map(({ id }) => id)).toEqual([
      "cpx21@ash",
      "cx23@fsn1",
    ]);
  });

  it("skips malformed HETZNER_MACHINE_TYPES entries with a structured warning", async () => {
    const warn = vi.fn();
    const allowlist = hetznerMachineTypeAllowlistFromEnv(
      "cpx21@ash,bogus!,cx-22@fsn1,cpx21,cpx31@,,",
      warn,
    );

    expect([...allowlist]).toEqual(["cpx21@ash"]);
    expect(warn.mock.calls.map(([warning]) => warning)).toEqual([
      "bogus!",
      "cx-22@fsn1",
      "cpx21",
      "cpx31@",
    ].map((entry) => ({
      event: "hetzner_machine_type_catalog_entry_rejected",
      entry,
      reason: 'expected "<server-type>@<location>" (for example "cpx21@hil")',
    })));

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        server_types: [
          {
            name: "cpx21",
            cores: 3,
            memory: 4,
            disk: 80,
            architecture: "x86",
            deprecation: null,
            locations: [
              { name: "hil", available: true, deprecation: null },
              { name: "ash", available: true, deprecation: null },
            ],
          },
        ],
        meta: { pagination: { next_page: null } },
      }),
    );
    const provider = new HetznerProvider("test-token", {
      machineTypeCatalog: "cpx21@ash,bogus!",
      warn,
    });

    // The malformed entry is dropped without failing the listing.
    expect((await provider.listMachineTypes()).map(({ id }) => id)).toEqual(["cpx21@ash"]);
  });

  it("maps numeric Hetzner type IDs back to names in webAppd provider errors", async () => {
    // Answer by URL, not by call order: the listing asks /server_types and
    // /pricing, so a counted sequence would hand the create reply to the
    // currency read.
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/pricing")) return Promise.resolve(hetznerPricing("USD"));
      if (url.includes("/server_types")) {
        return Promise.resolve(Response.json({
          server_types: [
            {
              id: 104,
              name: "cx22",
              cores: 2,
              memory: 4,
              disk: 40,
              architecture: "x86",
              deprecation: null,
              locations: [
                { id: 1, name: "fsn1", available: true, deprecation: null },
              ],
            },
          ],
          meta: { pagination: { next_page: null } },
        }));
      }
      return Promise.resolve(Response.json(
        { error: { code: "invalid_input", message: "server type 104 is deprecated" } },
        { status: 422 },
      ));
    });
    const provider = new HetznerProvider("test-token");
    await provider.listMachineTypes();

    await expect(
      provider.createVm({
        workspaceId: "workspace-id",
        machineId: "machine-id",
        machineTypeId: "cx22@fsn1",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        phoneHomeUrl: "https://cp.example/workspaces/workspace-id/phone-home/token",
        userData: "#cloud-config",
      }),
    ).rejects.toThrow("server type 104 (cx22) is deprecated");
  });

  it("resolves numeric Hetzner type IDs for direct creates without a warm cache", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "invalid_input", message: "server type 104 is deprecated" } },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          server_type: {
            id: 104,
            name: "cx22",
          },
        }),
      );
    const provider = new HetznerProvider("test-token");

    await expect(
      provider.createVm({
        workspaceId: "workspace-id",
        machineId: "machine-id",
        machineTypeId: "cx22@fsn1",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        phoneHomeUrl: "https://cp.example/workspaces/workspace-id/phone-home/token",
        userData: "#cloud-config",
      }),
    ).rejects.toThrow("server type 104 (cx22) is deprecated");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.hetzner.cloud/v1/server_types/104",
    );
  });

  it("does not guess a requested Hetzner type name for an unrelated numeric ID", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "invalid_input", message: "server type 105 is unavailable" } },
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const provider = new HetznerProvider("test-token");

    await expect(
      provider.createVm({
        workspaceId: "workspace-id",
        machineId: "machine-id",
        machineTypeId: "cx22@fsn1",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        phoneHomeUrl: "https://cp.example/workspaces/workspace-id/phone-home/token",
        userData: "#cloud-config",
      }),
    ).rejects.toThrow(/^server type 105 is unavailable$/u);
  });

  it("includes the provider rejection message in the workspace error view", async () => {
    const { app, providers } = harness();
    providers.onCreate = async () => {
      throw new Error("server type 104 is deprecated");
    };
    const cookie = await operatorSession(app);
    const created = await createWorkspace(app, cookie);

    const response = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });
    const body = await response.json<PollResponse>();

    expect(created.phase).toBe("error");
    expect(body.workspaces[0]?.error).toBe(
      "provider operation failed: server type 104 is deprecated",
    );
  });

  it("enforces the default 10-workspace per-organization concurrent quota", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    for (let index = 0; index < 10; index += 1) {
      expect((await createWorkspace(app, cookie)).phase).toBe("creating");
    }

    const rejected = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
      }),
    });

    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error:
        "organization workspace quota reached; destroy an existing workspace before creating another",
      retryAction: null,
    });
    expect(providers.createCalls).toBe(10);
  });

  it("honors org vm_limit and counts every non-destroyed lifecycle state", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const now = Date.now();
    // The unit is a MACHINE now: a workspace is configuration and costs
    // nothing, a VM costs money. Every non-destroyed state holds a slot.
    for (const [index, state] of ["provisioning", "running", "stopped", "destroying", "error"].entries()) {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO workspaces
           (id, owner_id, org_id, owner_membership_id, default_machine_type_id,
            auto_provision, revision, created_at, updated_at)
           VALUES (?1, 'operator', 'personal', 'personal', 'small', 1, 1, ?2, ?2)`,
        ).bind(`quota-${String(index)}`, now),
        env.DB.prepare(
          `INSERT INTO machines
           (id, workspace_id, membership_id, state, machine_type_id,
            compute_credential_source, created_at, updated_at)
           VALUES (?1, ?2, 'personal', ?3, 'small', 'deployment', ?4, ?4)`,
        ).bind(`quota-machine-${String(index)}`, `quota-${String(index)}`, state, now),
      ]);
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces
         (id, owner_id, org_id, owner_membership_id, default_machine_type_id,
          auto_provision, revision, deleted_at, created_at, updated_at)
         VALUES ('old-tombstone', 'operator', 'personal', 'personal', 'small', 1, 1, ?1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO machines
         (id, workspace_id, membership_id, state, machine_type_id,
          compute_credential_source, created_at, updated_at)
         VALUES ('old-tombstone-machine', 'old-tombstone', 'personal', 'destroyed',
                 'small', 'deployment', ?1, ?1)`,
      ).bind(now),
    ]);
    const request = () =>
      appRequest(
        app,
        "/workspaces",
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            machineTypeId: "small",
            sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
          }),
        },
      );

    await env.DB.prepare("UPDATE orgs SET vm_limit = 5 WHERE id = 'personal'").run();

    const rejected = await request();
    expect(rejected.status).toBe(409);
    expect(providers.createCalls).toBe(0);

    await env.DB
      .prepare("UPDATE machines SET state = 'destroyed' WHERE state = 'error'")
      .run();
    expect((await request()).status).toBe(201);
    expect(providers.createCalls).toBe(1);
  });

  it("atomically enforces concurrent quota requests without leaking a workspace row", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await env.DB.prepare("UPDATE orgs SET vm_limit = 1 WHERE id = 'personal'").run();
    const request = () =>
      appRequest(
        app,
        "/workspaces",
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify({
            machineTypeId: "small",
            sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
          }),
        },
      );

    const responses = await Promise.all([request(), request()]);

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(providers.createCalls).toBe(1);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM workspaces WHERE owner_id = 'operator'")
        .first<number>("count"),
    ).toBe(1);
  });

  it("rate limits workspace and invite creation per principal", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const limit = vi.fn(async () => ({ success: false }));
    const bindings = { REQUEST_RATE_LIMITER: { limit } };
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    const post = (path: string, body: object) => appRequest(
      app, path, { method: "POST", headers, body: JSON.stringify(body) }, bindings,
    );
    const workspace = await post("/workspaces", {
      machineTypeId: "small", sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
    });
    const invite = await post("/invites", { role: "member" });

    expect([workspace.status, invite.status]).toEqual([429, 429]);
    expect(limit).toHaveBeenNthCalledWith(1, { key: "create:operator" });
    expect(limit).toHaveBeenNthCalledWith(2, { key: "create:operator" });
    expect(providers.createCalls).toBe(0);
  });

  it("rejects UTF-8 userData over the provider limit before creating a VM", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const callerUserData = "🙂".repeat(8_000);

    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        sshPublicKey: "ssh-ed25519 AAAAC3Nzatest caller",
        userData: callerUserData,
      }),
    });

    expect(response.status).toBe(413);
    const body = await response.json<{ error: string; retryAction: null }>();
    expect(body.retryAction).toBeNull();
    expect(body.error).toMatch(
      /^userData exceeds the provider limit: caller UTF-8 bytes 32000 \+ generated bootstrap bytes \d+ = \d+ > 32768$/u,
    );
    expect(providers.createCalls).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<number>("count"),
    ).toBe(0);
    expect(new HetznerProvider("test-token").capabilities()).toEqual({
      volumes: true,
      attachesVolumesAtCreate: true,
      maxUserDataBytes: 32 * 1024,
      webAppTicketsSinceMs: BOX_IMAGE_TICKETS_SINCE_MS,
      webAppViewerGuardsSinceMs: BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
      webAppSharedSessionsSinceMs: BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,
    });
  });

  it("accepts exactly the request-specific Hetzner UTF-8 userData budget", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // The create names the box after the workspace, so the generated bytes
    // grow with the name. Pin the name, or a random one moves the budget.
    const name = "budget-probe";
    // No key: workspace creation has no sshPublicKey field any more, so the
    // keyless branch of the generated script is the one under budget here.
    const sampleUserData = buildUserData(
      undefined,
      `https://cp.example/workspaces/${"0".repeat(36)}/phone-home/${"a".repeat(43)}`,
      env.BOX_IMAGE_REF,
      "a",
      env.BOX_IMAGE_TAG,
      env.BOX_IMAGE_SHA256,
      undefined,
      { boxHostname: name },
    );
    const generatedBytes = new TextEncoder().encode(sampleUserData).byteLength - 1;
    const exactCallerBytes = 32 * 1024 - generatedBytes;
    expect(exactCallerBytes).toBeGreaterThan(0);

    const request = (userData: string) =>
      appRequest(app, "/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId: "small", name, userData }),
      });
    const accepted = await request("a".repeat(exactCallerBytes));

    expect(accepted.status).toBe(201);
    expect(providers.createCalls).toBe(1);
    const [createdUserData] = providers.userData.values();
    expect(new TextEncoder().encode(createdUserData).byteLength).toBe(32 * 1024);

    const rejected = await request("a".repeat(exactCallerBytes + 1));
    expect(rejected.status).toBe(413);
    expect(providers.createCalls).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM workspaces").first<number>("count"),
    ).toBe(1);
  });

  it("rejects a wrong phone_home token and rejects the capability's second use", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);

    const wrong = await app.request(
      `${callback}wrong`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(wrong.status).toBe(401);

    const first = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const second = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
  });

  it("records a bootstrap failure with the exact workspace error message", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);

    const failure = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          bootstrap_error: "docker pull exhausted retries",
        }),
      },
      { DB: env.DB },
    );
    expect(failure.status).toBe(204);

    const response = await appRequest(app, "/workspaces", {
      headers: { Cookie: cookie },
    });
    const body = await response.json<PollResponse>();
    expect(body.workspaces[0]).toMatchObject({
      id: workspace.id,
      phase: "error",
      error: "bootstrap failed: docker pull exhausted retries",
    });
  });

  it("consumes a valid bootstrap failure capability before later success or reuse", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);
    const failureRequest = () =>
      app.request(
        callback,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ bootstrap_error: "apt install failed" }),
        },
        { DB: env.DB },
      );

    expect((await failureRequest()).status).toBe(204);
    const laterSuccess = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const reusedFailure = await failureRequest();

    expect(laterSuccess.status).toBe(409);
    expect(reusedFailure.status).toBe(409);
    expect(
      await env.DB
        .prepare(
          `SELECT state, error, phone_home_hash, phone_home_used
           FROM machines WHERE workspace_id = ?1`,
        )
        .bind(workspace.id)
        .first(),
    ).toEqual({
      state: "error",
      error: "bootstrap failed: apt install failed",
      phone_home_hash: null,
      phone_home_used: 1,
    });
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM boxes WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<number>("count"),
    ).toBe(0);
  });

  it("sanitizes and bounds the stored bootstrap failure shown to operators", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);
    const prefix = "bootstrap failed: ";
    const sanitizedDetail = `disk full retry ${"x".repeat(2_000)}`;

    const failure = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          bootstrap_error: `disk\u0000full\r\nretry\t${"x".repeat(2_000)}`,
        }),
      },
      { DB: env.DB },
    );
    expect(failure.status).toBe(204);

    const response = await appRequest(app, "/workspaces", {
      headers: { Cookie: cookie },
    });
    const error = (await response.json<PollResponse>()).workspaces[0]?.error;
    expect(error).toBe(prefix + sanitizedDetail.slice(0, 1_024 - prefix.length));
    expect(error).toHaveLength(1_024);
    expect(error).not.toMatch(/[\u0000-\u001f\u007f]/u);
  });

  it("rejects a box A token acting as box B in the registry", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const boxA = await enrollBox(app, cookie);
    const boxB = await enrollBox(app, cookie);
    const response = await appRequest(app, `/boxes/${boxB.box_id}/broker`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${boxA.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        host: "broker-b.example",
        port: 22,
        sshHostPublicKey: "ssh-ed25519 AAAAbrokerb",
      }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects broker box A pulling broker box B's slice", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const boxA = await enrollBox(app, cookie);
    const boxB = await enrollBox(app, cookie);
    for (const [box, host] of [
      [boxA, "broker-a.example"],
      [boxB, "broker-b.example"],
    ] as const) {
      const enrollment = await appRequest(app, `/boxes/${box.box_id}/broker`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${box.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          host,
          port: 22,
          sshHostPublicKey: "ssh-ed25519 AAAAbroker",
        }),
      });
      expect(enrollment.status).toBe(204);
    }
    const response = await appRequest(app, `/boxes/${boxB.box_id}/feed`, {
      headers: { Authorization: `Bearer ${boxA.access_token}` },
    });
    expect(response.status).toBe(403);
  });

  /** A box writes its new pair to disk only after this endpoint has already
   * rotated. A box that dies in that window still holds the token it came
   * with, and before the grace window that box was stranded for good: one hash
   * per family, and re-enrolment needs a human at a device code. */
  it("redeems a rotated-away refresh token inside the grace window", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const box = await enrollBox(app, cookie);
    const refresh = () =>
      appRequest(app, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: box.refresh_token,
        }),
      });

    const first = await refresh();
    expect(first.status).toBe(200);
    const winner = await first.json<{ access_token: string; refresh_token: string }>();

    // The box never kept the winner's pair. It comes back with what it holds.
    const recovered = await refresh();
    expect(recovered.status).toBe(200);
    const rescued = await recovered.json<{ access_token: string; refresh_token: string }>();
    // A fresh pair, not the one the lost write was carrying: the control plane
    // stores hashes, so it cannot hand the old answer back.
    expect(rescued.refresh_token).not.toBe(winner.refresh_token);
    expect(rescued.access_token).not.toBe(winner.access_token);
  });

  it("rejects a refresh token once its grace window has passed", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const box = await enrollBox(app, cookie);
    const refresh = () =>
      appRequest(app, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: box.refresh_token,
        }),
      });

    expect((await refresh()).status).toBe(200);
    // The grace is the 15-minute access lifetime; one second past it, the
    // retired hash is no better than a guess.
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1_000);
    try {
      const rotatedAway = await refresh();
      expect(rotatedAway.status).toBe(400);
      expect(await rotatedAway.json()).toEqual({ error: "invalid_grant" });
    } finally {
      vi.useRealTimers();
    }
  });

  /** The grace slot is a way back for the box that lost a write, not a second
   * living token: redeeming it must not let a third party keep a spent token
   * alive by presenting it over and over. */
  it("does not extend the grace window when the retired hash is redeemed", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const box = await enrollBox(app, cookie);
    const refresh = () =>
      appRequest(app, "/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: box.refresh_token,
        }),
      });

    expect((await refresh()).status).toBe(200);
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    try {
      // Still inside the window that started at the FIRST rotation.
      expect((await refresh()).status).toBe(200);
      // The clock the grace runs on is that first rotation, not this
      // redemption, so it expires on schedule rather than being renewed.
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      expect((await refresh()).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps destroyed terminal and returns the same tombstone", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const first = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const tombstone = await first.json<WorkspaceResponse>();
    const second = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(await second.json()).toEqual(tombstone);
    expect(tombstone.workspace.phase).toBe("destroyed");
    expect(providers.destroyCalls).toBe(1);
  });

  it("runs create → phone_home → ready → destroy → tombstone with strictly increasing revisions", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const revisions: number[] = [];
    // The provider hooks are handed a MACHINE id, so the revision they sample
    // is read through the machine's workspace.
    const revisionForMachine = async (machineId: string): Promise<void> => {
      const revision = await env.DB
        .prepare(`SELECT w.revision FROM workspaces w
                  JOIN machines m ON m.workspace_id = w.id
                  WHERE m.id = ?1`)
        .bind(machineId)
        .first<number>("revision");
      if (revision !== null) revisions.push(revision);
    };
    providers.onCreate = revisionForMachine;
    providers.onDestroy = revisionForMachine;

    const volumeResponse = await appRequest(app, "/volumes", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "state", sizeGb: 20, location: "test" }),
    });
    const volume = await volumeResponse.json<{ volume: { id: string } }>();
    const creating = await createWorkspace(app, cookie, volume.volume.id);
    revisions.push(creating.revision);
    expect(creating.phase).toBe("creating");

    const callback = phoneHomeUrl(providers, creating.id);
    const phoneHome = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    expect(phoneHome.status).toBe(200);
    const credential = await phoneHome.json<{ access_token: string; refresh_token: string }>();
    expect(credential.access_token).not.toBe(credential.refresh_token);

    const poll = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });
    const ready = (await poll.json<PollResponse>()).workspaces[0];
    expect(ready?.phase).toBe("ready");
    if (ready === undefined) throw new Error("workspace missing from poll");
    revisions.push(ready.revision);

    const destroy = await appRequest(app, `/workspaces/${creating.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const tombstone = (await destroy.json<WorkspaceResponse>()).workspace;
    revisions.push(tombstone.revision);
    expect(tombstone.phase).toBe("destroyed");
    expect(tombstone.ssh).toBeNull();
    expect(tombstone.volumeId).toBe(volume.volume.id);
    // Strictly increasing, and every sample is one a poller could have seen.
    // The exact numbers are not a contract: a machine act bumps the workspace
    // it belongs to, and a workspace holds several machines now.
    expect(revisions.length).toBeGreaterThanOrEqual(4);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBeGreaterThanOrEqual(revisions.length - 1);
    expect(providers.detachCalls).toBe(1);
    expect(providers.volumes.get(volume.volume.id)?.status).toBe("available");
  });

  it("assigns workspace keys to the least-loaded broker and serves ETag/304", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const broker = await enrollBox(app, cookie);
    expect(
      (
        await appRequest(app, `/boxes/${broker.box_id}/broker`, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${broker.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host: "broker.example",
            port: 22,
            sshHostPublicKey: "ssh-ed25519 AAAAbroker",
          }),
        })
      ).status,
    ).toBe(204);

    const workspace = await createWorkspace(app, cookie);
    const callback = phoneHomeUrl(providers, workspace.id);
    const ready = await app.request(
      callback,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostPublicKeys: ["ssh-ed25519 AAAAhost"] }),
      },
      { DB: env.DB },
    );
    const box = await ready.json<{ box_id: string; access_token: string }>();
    const registration = await appRequest(app, `/boxes/${box.box_id}/keys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${box.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        keys: [
          { pubkey: "ssh-ed25519 AAAAmint", op: "mint" },
          { pubkey: "ssh-ed25519 AAAAdeposit", op: "deposit" },
        ],
      }),
    });
    expect(registration.status).toBe(200);
    expect(await registration.json<RegisterKeysResponse>()).toEqual({
      memberUnixName: OPERATOR_BROKER_NAME,
      broker: {
        host: "broker.example",
        port: 22,
        sshHostPublicKey: "ssh-ed25519 AAAAbroker",
      },
    });

    const feed = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
      headers: { Authorization: `Bearer ${broker.access_token}` },
    });
    expect(feed.status).toBe(200);
    const etag = feed.headers.get("etag");
    const body = await feed.json<FeedResponse>();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({
      unixName: OPERATOR_BROKER_NAME,
      harnesses: ["claude", "codex"],
    });
    expect(body.members[0]?.keys).toEqual(
      expect.arrayContaining([
        { pubkey: "ssh-ed25519 AAAAmint", op: "mint" },
        { pubkey: "ssh-ed25519 AAAAdeposit", op: "deposit" },
      ]),
    );
    if (etag === null) throw new Error("feed ETag missing");
    const notModified = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
      headers: {
        Authorization: `Bearer ${broker.access_token}`,
        "If-None-Match": etag,
      },
    });
    expect(notModified.status).toBe(304);

    const removed = await appRequest(app, `/boxes/${broker.box_id}/broker`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${broker.access_token}` },
    });
    expect(removed.status).toBe(204);
    const assignment = await env.DB
      .prepare("SELECT broker_box_id FROM boxes WHERE id = ?1")
      .bind(box.box_id)
      .first<string>("broker_box_id");
    expect(assignment).toBeNull();
  });

  it("derives one broker unix name per member and never reuses the box login", async () => {
    const { app, providers } = harness();
    const operator = await operatorSession(app);
    const broker = await enrollBox(app, operator);
    await enrollBroker(app, broker, "broker.example");

    const mine = await workspaceBox(app, providers, operator);
    const theirs = await workspaceBox(app, providers, await userSession("stranger"));
    const [minename, theirname] = await Promise.all(
      [mine, theirs].map(async (box, index) => {
        const response = await registerKeys(app, box, String(index));
        expect(response.status).toBe(200);
        return (await response.json<RegisterKeysResponse>()).memberUnixName;
      }),
    );

    // The isolation boundary: two members, two accounts, two homes. A shared
    // name would put both credentials in one directory on the broker box.
    expect(minename).toBe(OPERATOR_BROKER_NAME);
    expect(minename).not.toBe(theirname);
    expect(minename).toMatch(BROKER_NAME_PATTERN);
    expect(theirname).toMatch(BROKER_NAME_PATTERN);
    // And it is NOT the workspace-box login. `principals.unix_name` stays the
    // shared `blitz` on purpose — one workspace box belongs to one member, so
    // a shared name there costs nothing, and changing it would rewrite every
    // box's home path for no gain.
    const stored = await env.DB
      .prepare("SELECT unix_name FROM principals WHERE id = 'operator'")
      .first<string>("unix_name");
    expect(stored).toBe("blitz");
    expect(minename).not.toBe(stored);

    // The feed must answer with the SAME names, or the box is handed a login
    // the broker never creates.
    const feed = await appRequest(app, `/boxes/${broker.box_id}/feed`, {
      headers: { Authorization: `Bearer ${broker.access_token}` },
    });
    const body = await feed.json<FeedResponse>();
    expect(body.members.map((member) => member.unixName).sort()).toEqual(
      [minename, theirname].sort(),
    );
  });

  it("keeps every workspace a member owns on the same broker box", async () => {
    const { app, providers } = harness();
    const operator = await operatorSession(app);
    const first = await enrollBox(app, operator);
    await enrollBroker(app, first, "broker-one.example");

    const one = await workspaceBox(app, providers, operator);
    expect((await registerKeys(app, one, "1")).status).toBe(200);

    // A second, completely empty broker now exists. Load balancing would send
    // the member's next workspace there — and strand it, because their
    // credential lives on the first box.
    const second = await enrollBox(app, operator);
    await enrollBroker(app, second, "broker-two.example");

    const two = await workspaceBox(app, providers, operator);
    const response = await registerKeys(app, two, "2");
    expect(response.status).toBe(200);
    expect((await response.json<RegisterKeysResponse>()).broker.host).toBe(
      "broker-one.example",
    );
  });

  it("destroying the last workspace keeps the member in the broker feed", async () => {
    const { app, providers } = harness();
    const operator = await operatorSession(app);
    const broker = await enrollBox(app, operator);
    await enrollBroker(app, broker, "broker.example");

    const only = await workspaceBox(app, providers, operator);
    expect((await registerKeys(app, only, "1")).status).toBe(200);

    const destroy = await appRequest(app, `/workspaces/${only.workspaceId}`, {
      method: "DELETE",
      headers: { Cookie: operator },
    });
    expect(destroy.status).toBe(200);
    expect((await destroy.json<WorkspaceResponse>()).workspace.phase).toBe("destroyed");

    // The member has no `boxes` row left anywhere — destroy hard-deletes it.
    // Absence from this feed is the broker's DEPROVISION signal
    // (packages/broker/internal/broker/reconcile.go sweeps every managed
    // account that is neither wanted nor preserved), and the account it would
    // delete owns the only copy of this member's vendor refresh token. So the
    // member must still be here, with an empty key list: keep the account,
    // serve it no keys.
    const feed = await brokerFeed(app, broker);
    expect(feed.members).toHaveLength(1);
    expect(feed.members[0]).toEqual({
      unixName: OPERATOR_BROKER_NAME,
      harnesses: ["claude", "codex"],
      keys: [],
    });
  });

  it("a second workspace re-attaches to the same broker and the same unix name", async () => {
    const { app, providers } = harness();
    const operator = await operatorSession(app);
    const broker = await enrollBox(app, operator);
    await enrollBroker(app, broker, "broker.example");

    const only = await workspaceBox(app, providers, operator);
    const before = await registerKeys(app, only, "1");
    expect(before.status).toBe(200);
    const first = await before.json<RegisterKeysResponse>();

    expect(
      (
        await appRequest(app, `/workspaces/${only.workspaceId}`, {
          method: "DELETE",
          headers: { Cookie: operator },
        })
      ).status,
    ).toBe(200);

    // A second, emptier broker. Load balancing would send the next workspace
    // there, because counting memberships the member's own box now looks like
    // the busy one.
    const rival = await enrollBox(app, operator);
    await enrollBroker(app, rival, "broker-two.example");

    // Roaming across an empty gap. The member owns no box at all at this
    // point, so nothing about the OLD workspace can carry the placement — only
    // the membership row can. It has to hand back the same home on the same
    // box, or the new workspace logs into an account that holds no credential.
    const again = await workspaceBox(app, providers, operator);
    const after = await registerKeys(app, again, "2");
    expect(after.status).toBe(200);
    const second = await after.json<RegisterKeysResponse>();
    expect(second.memberUnixName).toBe(first.memberUnixName);
    expect(second.broker.host).toBe(first.broker.host);

    // Same account, mintable again. Exactly two keys, because the destroyed
    // workspace's pair went with its `boxes` row: surviving the sweep must not
    // cost the feed its revocation path.
    const feed = await brokerFeed(app, broker);
    expect(feed.members).toHaveLength(1);
    expect(feed.members[0]?.unixName).toBe(first.memberUnixName);
    expect(feed.members[0]?.keys).toEqual([
      { pubkey: "ssh-ed25519 AAAAdeposit2", op: "deposit" },
      { pubkey: "ssh-ed25519 AAAAmint2", op: "mint" },
    ]);
  });

  it("refuses a new member with no_broker_capacity once member_cap is reached", async () => {
    const { app, providers } = harness();
    const operator = await operatorSession(app);
    const broker = await enrollBox(app, operator);
    await enrollBroker(app, broker, "broker.example");
    await env.DB
      .prepare("UPDATE broker_boxes SET member_cap = 1 WHERE box_id = ?1")
      .bind(broker.box_id)
      .run();

    const mine = await workspaceBox(app, providers, operator);
    expect((await registerKeys(app, mine, "1")).status).toBe(200);

    // The cap counts identities, not boxes: a second workspace for the SAME
    // member adds no credential home and must still be admitted.
    const alsoMine = await workspaceBox(app, providers, operator);
    expect((await registerKeys(app, alsoMine, "2")).status).toBe(200);

    // A different member is a different home, and the box is full.
    const theirs = await workspaceBox(app, providers, await userSession("stranger"));
    const refused = await registerKeys(app, theirs, "3");
    expect(refused.status).toBe(409);
    expect(await refused.json<{ error: string }>()).toMatchObject({
      error: "no_broker_capacity",
    });
  });

  it("answers no_broker_capacity when no broker box is enrolled at all", async () => {
    const { app, providers } = harness();
    const box = await workspaceBox(app, providers, await operatorSession(app));
    const response = await registerKeys(app, box);
    expect(response.status).toBe(409);
    expect(await response.json<{ error: string }>()).toMatchObject({
      error: "no_broker_capacity",
    });
  });

  it("sweeps stale creation to error and completes orphaned destroy work", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await env.DB
      .prepare("UPDATE machines SET updated_at = 0 WHERE workspace_id = ?1")
      .bind(workspace.id)
      .run();
    const runtime = testRuntime(providers);
    expect(await runInvariantSweep(runtime, 2 * 60 * 60 * 1000)).toBe(1);
    const errored = await env.DB
      .prepare("SELECT state, error FROM machines WHERE workspace_id = ?1")
      .bind(workspace.id)
      .first<{ state: string; error: string }>();
    expect(errored).toEqual({ state: "error", error: "machine creation timed out" });

    await env.DB
      .prepare("UPDATE machines SET state = 'destroying' WHERE workspace_id = ?1")
      .bind(workspace.id)
      .run();
    expect(await runOrphanSweep(runtime)).toBe(1);
    const destroyed = await env.DB
      .prepare("SELECT state, vm_id FROM machines WHERE workspace_id = ?1")
      .bind(workspace.id)
      .first<{ state: string; vm_id: string | null }>();
    expect(destroyed).toEqual({ state: "destroyed", vm_id: null });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces
         (id, owner_id, default_machine_type_id, auto_provision, revision,
          created_at, updated_at)
         VALUES ('scheduled-stale', 'operator', 'small', 1, 1, 0, 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO machines
         (id, workspace_id, membership_id, state, machine_type_id,
          compute_credential_source, created_at, updated_at)
         VALUES ('scheduled-stale-machine', 'scheduled-stale', 'personal',
                 'provisioning', 'small', 'deployment', 0, 0)`,
      ),
    ]);
    const executionContext = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ scheduledTime: Date.now(), cron: "0 * * * *" }),
      env as never,
      executionContext,
    );
    await waitOnExecutionContext(executionContext);
    expect(
      await env.DB
        .prepare("SELECT state FROM machines WHERE workspace_id = 'scheduled-stale'")
        .first<string>("state"),
    ).toBe("error");

    let scheduled: Promise<unknown> | undefined;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failingRuntime = {
      ...runtime,
      db: {
        rawSQL() {
          return {
            async run(): Promise<never> {
              throw new Error("expected lazy sweep failure");
            },
          };
        },
        rawSQLTransaction() {
          return { async run(): Promise<never> { throw new Error("unexpected"); } };
        },
      },
      waitUntil(promise: Promise<unknown>) {
        scheduled = promise;
      },
    };
    const nextLazyWindow = Date.now() + LAZY_SWEEP_INTERVAL_MS;
    vi.spyOn(Date, "now").mockReturnValue(nextLazyWindow);
    expect(() => maybeScheduleLazySweep(failingRuntime, "/workspaces")).not.toThrow();
    await scheduled;
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining("lazy control-plane sweep failed"),
    );
  });

  it("logs and skips an orphan row whose VM ID has no owning provider", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await env.DB
      .prepare("UPDATE machines SET state = 'destroying', vm_id = 'unowned' WHERE workspace_id = ?1")
      .bind(workspace.id)
      .run();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await runOrphanSweep(testRuntime(providers))).toBe(0);
    expect(providers.destroyCalls).toBe(0);
    expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
      message: "orphan sweep skipped VM with no owning provider",
      machineId: await machineIdFor(workspace.id),
      workspaceId: workspace.id,
      vmId: "unowned",
    }));
    expect(
      await env.DB.prepare("SELECT state FROM machines WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<string>("state"),
    ).toBe("destroying");
  });
});
