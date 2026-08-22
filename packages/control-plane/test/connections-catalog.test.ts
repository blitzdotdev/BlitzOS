import { describe, expect, it } from "vitest";
import { evaluateProbe } from "../core/connections/canary.js";
import {
  CATALOG,
  catalogView,
  GENERIC_MANIFEST_ID,
  providerManifest,
} from "../core/connections/catalog/index.js";
import { genericManifest } from "../core/connections/catalog/generic.js";
import {
  BOX_HOME,
  compileSurfaces,
  skillPath,
  tombstoneSurfaces,
} from "../core/connections/catalog/surfaces.js";
import type {
  ExchangeFixture,
  OAuthProviderManifest,
  ProviderManifest,
  StaticProviderManifest,
  SurfaceInput,
} from "../core/connections/catalog/types.js";
import {
  exchangeForm,
  parseExchangeResponse,
} from "../core/connections/minters/oauth.js";
import type { MintResult, Placement } from "../core/connections/types.js";

/** The repository's env contract. Worker vars carry no value there — only a
 * documented name and what it is for — and a connect binding missing from it
 * is a provider an operator cannot switch on because nothing named it. */
const ENV_DEFAULTS = import.meta.glob<string>("../../../env.defaults", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** The shipped box's Go decoder uses DisallowUnknownFields on both the mint
 * result and every placement, and validates names against this pattern. These
 * constants are the wire, restated here so a catalog entry that would 500 a
 * running box fails in CI instead. */
const FROZEN_MINT_KEYS = ["expiresAt", "integration", "mode", "placements"];
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const PLACEMENT_KEYS = {
  env: ["kind", "name", "value"],
  "unset-env": ["kind", "name"],
  file: ["kind", "path", "value"],
} as const;

function surfaceInput(
  manifest: ProviderManifest,
  overrides: Partial<SurfaceInput> = {},
): SurfaceInput {
  return {
    connection: manifest.id,
    scopes: [...manifest.defaultScopes],
    mode: manifest.custody === "proxy" ? "proxy" : "inject",
    token: "test-only-lease-token",
    proxyUrl: "https://cp.example/proxy/lease-one",
    tokenHeader: manifest.tokenHeader,
    overrides: null,
    ...overrides,
  };
}

function assertPlacementsRideTheFrozenWire(
  placements: Placement[],
  label: string,
): void {
  expect(placements.length, `${label} produces placements`).toBeGreaterThan(0);
  for (const placement of placements) {
    const keys = Object.keys(placement).sort();
    if (placement.kind === "file") {
      expect(keys.filter((key) => key !== "mode"), label)
        .toEqual([...PLACEMENT_KEYS.file].sort());
      expect(placement.path.startsWith("/"), `${label} file path is absolute`).toBe(true);
      expect(placement.path).not.toContain("\u0000");
      expect(placement.mode ?? 0).toBeLessThanOrEqual(0o777);
      continue;
    }
    expect(keys, label).toEqual([...PLACEMENT_KEYS[placement.kind]].sort());
    expect(placement.name, `${label} environment name`).toMatch(ENVIRONMENT_NAME);
    if (placement.kind === "env") expect(placement.value).not.toContain("\u0000");
  }
}

function replayExchange(
  manifest: OAuthProviderManifest,
  fixture: ExchangeFixture,
): void {
  const recorded = new Map(fixture.request.map(({ name, value }) => [name, value]));
  const form = exchangeForm({
    manifest,
    clientId: recorded.get("client_id") ?? "",
    clientSecret: recorded.get("client_secret") ?? "",
    redirectUri: recorded.get("redirect_uri") ?? null,
    grantType: fixture.grantType,
    code: recorded.get("code") ?? null,
    codeVerifier: recorded.get("code_verifier") ?? null,
    refreshToken: recorded.get("refresh_token") ?? null,
  });
  expect([...form.keys()].sort(), `${manifest.id}/${fixture.name} request fields`)
    .toEqual([...recorded.keys()].sort());
  for (const [name, value] of recorded) {
    expect(form.get(name), `${manifest.id}/${fixture.name} sends ${name}`).toBe(value);
  }
  const parse = () => parseExchangeResponse(manifest, fixture.response);
  if (fixture.expect === null) {
    expect(parse, `${manifest.id}/${fixture.name} must reject`).toThrow();
    return;
  }
  expect(parse()).toEqual(fixture.expect);
}

describe("provider catalog conformance", () => {
  it("keeps one entry per id and a generic entry for custom connections", () => {
    const ids = CATALOG.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("generic");
    for (const id of ids) expect(providerManifest(id)?.id).toBe(id);
    expect(providerManifest("no-such-provider")).toBeNull();
  });

  /** Only the generic entry makes the person name a variable and a base URL,
   * and that is a fact about which catalog entry it is. Inferring it from a
   * missing authorize endpoint would put the vendor form in front of the next
   * pasted-key provider that knows its own vendor perfectly well. */
  it("asks for vendor config by catalog identity, not by a missing authorize URL", () => {
    for (const manifest of CATALOG) {
      expect(
        catalogView(manifest, () => undefined).needsVendorConfig,
        `${manifest.id} needsVendorConfig`,
      ).toBe(manifest.id === GENERIC_MANIFEST_ID);
    }
    const pastedKeyVendor = {
      ...genericManifest,
      id: "acme",
    } satisfies StaticProviderManifest;
    expect(pastedKeyVendor.auth).toBeNull();
    expect(catalogView(pastedKeyVendor, () => undefined).needsVendorConfig).toBe(false);
  });

  it("documents every connect client binding in env.defaults", () => {
    const source = Object.values(ENV_DEFAULTS)[0];
    if (source === undefined) throw new Error("env.defaults was not readable");
    // Worker vars are documentation-only lines: "# NAME (kind): what it is".
    const documented = new Set(
      [...source.matchAll(/^# ([A-Z][A-Z0-9_]*) \(/gmu)].map(([, name]) => name),
    );
    expect(documented, "env.defaults parsed").toContain("CRED_MASTER_KEY");
    for (const manifest of CATALOG) {
      const auth = manifest.auth;
      if (auth === null) continue;
      expect(documented, `${manifest.id} client id`).toContain(auth.clientIdVar);
      expect(documented, `${manifest.id} client secret`).toContain(auth.clientSecretVar);
    }
  });

  it("reports OAuth as unconfigured until both client bindings exist", () => {
    const withAuth = CATALOG.find((manifest) => manifest.auth !== null);
    if (withAuth === undefined || withAuth.auth === null) {
      throw new Error("catalog has no OAuth provider");
    }
    const auth = withAuth.auth;
    const unset = catalogView(withAuth, () => undefined);
    expect(unset.oauthAvailable).toBe(true);
    expect(unset.oauthConfigured).toBe(false);
    const halfSet = catalogView(withAuth, (name) =>
      name === auth.clientIdVar ? "client-id" : undefined);
    expect(halfSet.oauthConfigured).toBe(false);
    const configured = catalogView(withAuth, () => "value");
    expect(configured.oauthConfigured).toBe(true);
    // A view is what the picker gets; no binding value may reach it.
    expect(JSON.stringify(configured)).not.toContain("value");
  });

  for (const manifest of CATALOG) {
    describe(manifest.id, () => {
      it("declares a manifest the connect flow can act on", () => {
        expect(manifest.id).toMatch(/^[a-z0-9][a-z0-9-]*$/u);
        expect(manifest.title.length).toBeGreaterThan(0);
        expect(manifest.summary.length).toBeGreaterThan(0);
        expect(new URL(manifest.docsUrl).protocol).toBe("https:");
        expect(new URL(manifest.baseUrl).protocol).toBe("https:");
        expect(["cp", "broker", "proxy"]).toContain(manifest.custody);
        expect(["strict", "graceful", "none"]).toContain(manifest.rotation);
        // A header shape that cannot be set would fail only at proxy time.
        expect(() => {
          new Headers().set(
            manifest.tokenHeader.name,
            `${manifest.tokenHeader.prefix}token`,
          );
        }).not.toThrow();
        const scopeIds = manifest.scopes.map(({ id }) => id);
        expect(new Set(scopeIds).size).toBe(scopeIds.length);
        for (const scope of manifest.defaultScopes) {
          if (scopeIds.length === 0) continue;
          expect(scopeIds, `${manifest.id} default scope ${scope}`).toContain(scope);
        }
        for (const scope of manifest.scopes) {
          expect(scope.detail.length, `${scope.id} states what it allows`).toBeGreaterThan(20);
        }
        const auth = manifest.auth;
        if (auth !== null) {
          expect(new URL(auth.authorizeUrl).protocol).toBe("https:");
          expect(new URL(auth.tokenUrl).protocol).toBe("https:");
          expect(auth.clientIdVar).toMatch(ENVIRONMENT_NAME);
          expect(auth.clientSecretVar).toMatch(ENVIRONMENT_NAME);
          expect(auth.redirectPath).toBe(`/connect/${manifest.id}/callback`);
          expect(auth.accessTtlMs).toBeGreaterThan(0);
          expect(manifest.fixtures.length, "recorded exchanges are mandatory").toBeGreaterThan(0);
        } else {
          expect(manifest.fixtures).toEqual([]);
        }
        if (manifest.personalToken !== null) {
          expect(() => {
            new Headers().set(
              manifest.personalToken?.header.name ?? "",
              `${manifest.personalToken?.header.prefix ?? ""}token`,
            );
          }).not.toThrow();
          if (manifest.personalToken.baseUrlLabel !== null) {
            // The pasted instance URL is consumed by the proxy resolver;
            // inject custody would collect a URL nothing ever reads.
            expect(manifest.custody).toBe("proxy");
          }
        }
      });

      it("declares surfaces the box can accept", () => {
        const tokenSurfaces = manifest.surfaces.env.filter(({ fill }) => fill === "token");
        expect(tokenSurfaces.length, "exactly one variable carries the token").toBeGreaterThan(0);
        for (const surface of manifest.surfaces.env) {
          expect(surface.name).toMatch(ENVIRONMENT_NAME);
        }
        expect(manifest.surfaces.skill.path).toContain("<provider>");
        expect(manifest.surfaces.skill.path.startsWith("/")).toBe(false);
        expect(skillPath(manifest, "instance")).toBe(
          `${BOX_HOME}/${manifest.surfaces.skill.path.replace("<provider>", "instance")}`,
        );
      });

      /** The admin form submits `PUT /connections/:id` from this view alone,
       * so a manifest that declares one must be one that PUT can actually
       * serve: kind "static" for a pasted root, kind "app-jwt" for the
       * GitHub App shape. */
      it("declares a servable admin form or none", () => {
        const form = manifest.adminForm;
        const view = catalogView(manifest, () => undefined).adminForm;
        if (form === null) {
          expect(view).toBeNull();
          return;
        }
        expect(form.rootLabel.length).toBeGreaterThan(0);
        expect(form.rootHelp.length, "help says where the admin creates it")
          .toBeGreaterThan(20);
        if (form.app === null) {
          // A static root is pasted, not authorized, so it cannot share a
          // manifest with an OAuth flow that would fight it at mint.
          expect(manifest.auth, "a static admin root is pasted, not authorized").toBeNull();
          expect(["cp", "proxy"]).toContain(manifest.custody);
          expect(form.baseUrlLabel !== null, "base URL field exactly for proxy custody")
            .toBe(manifest.custody === "proxy");
        } else {
          // The app-jwt shape: the org credential is the mint fallback, so it
          // is the one admin form allowed beside member OAuth. The PUT route
          // serves app-jwt only under cp custody, and the ids ride the
          // config, so the form never collects an instance URL.
          expect(manifest.custody).toBe("cp");
          expect(form.baseUrlLabel).toBeNull();
          expect(form.app.appIdLabel.length).toBeGreaterThan(0);
          expect(form.app.installationIdLabel.length).toBeGreaterThan(0);
        }
        if (view === null) throw new Error("admin form view is missing");
        expect(view.rootLabel).toBe(form.rootLabel);
        expect(view.rootHelp).toBe(form.rootHelp);
        expect(view.app).toEqual(form.app);
        expect(view.placements).toEqual(
          manifest.surfaces.env.map(({ name, fill }) => ({ kind: "env", name, fill })),
        );
        expect(view.proxy === null).toBe(manifest.custody !== "proxy");
        if (view.proxy !== null) {
          expect(view.proxy.baseUrlLabel).toBe(form.baseUrlLabel);
          expect(view.proxy.tokenHeader).toBe(manifest.tokenHeader.name);
          expect(view.proxy.tokenPrefix).toBe(manifest.tokenHeader.prefix);
        }
      });

      it("renders a skill that tells an agent how to authenticate", () => {
        const rendered = manifest.surfaces.skill.render({
          connection: "acme",
          scopes: manifest.defaultScopes,
          mode: "proxy",
          tokenEnv: "ACME_TOKEN",
          baseUrlEnv: "ACME_BASE_URL",
          baseUrl: "https://cp.example/proxy/lease-one",
          tokenHeader: manifest.tokenHeader,
        });
        expect(rendered.startsWith("---\nname: acme\n")).toBe(true);
        expect(rendered).toContain("description:");
        expect(rendered).toContain("$ACME_TOKEN");
        expect(rendered).not.toContain("<provider>");
        expect(rendered).not.toContain("undefined");
      });

      it("compiles placements inside the frozen box wire", () => {
        const placements = compileSurfaces(manifest, surfaceInput(manifest));
        assertPlacementsRideTheFrozenWire(placements, `${manifest.id} mint`);
        const skill = placements.find((placement) => placement.kind === "file");
        expect(skill?.kind === "file" && skill.value.length > 0).toBe(true);

        const result: MintResult = {
          integration: manifest.id,
          mode: manifest.custody === "proxy" ? "proxy" : "inject",
          placements,
          expiresAt: 1_700_000_000_000,
        };
        expect(Object.keys(JSON.parse(JSON.stringify(result))).sort())
          .toEqual(FROZEN_MINT_KEYS);

        const tombstone = tombstoneSurfaces(
          manifest,
          manifest.id,
          manifest.surfaces.env.map(({ name }) => name),
        );
        assertPlacementsRideTheFrozenWire(tombstone, `${manifest.id} tombstone`);
        const emptied = tombstone.find((placement) => placement.kind === "file");
        expect(emptied?.kind === "file" && emptied.value).toBe("");
      });

      it("honours per-grant overrides only for the generic entry", () => {
        const overrides = {
          envName: "ACME_KEY",
          baseUrlEnvName: "ACME_BASE_URL",
          baseUrl: "https://api.acme.example",
        };
        const placements = compileSurfaces(
          manifest,
          surfaceInput(manifest, { overrides, mode: "inject" }),
        );
        const names = placements
          .filter((placement) => placement.kind === "env")
          .map((placement) => (placement.kind === "env" ? placement.name : ""));
        expect(names).toEqual(["ACME_KEY", "ACME_BASE_URL"]);
        assertPlacementsRideTheFrozenWire(placements, `${manifest.id} override`);
      });

      it("replays every recorded exchange", () => {
        if (manifest.auth === null) {
          expect(manifest.fixtures).toEqual([]);
          return;
        }
        for (const fixture of manifest.fixtures) replayExchange(manifest, fixture);
      });

      it("replays every recorded probe answer", () => {
        const request = manifest.probe.request({
          token: "test-only-probe-token",
          baseUrl: manifest.baseUrl,
          header: manifest.tokenHeader,
        });
        expect(["GET", "POST"]).toContain(request.method);
        expect(new URL(request.url).protocol).toBe("https:");
        const authorization = request.headers.find(
          (header) => header.name === manifest.tokenHeader.name,
        );
        expect(authorization?.value).toContain("test-only-probe-token");
        if (request.method === "GET") expect(request.body).toBeNull();

        for (const fixture of manifest.probeFixtures) {
          const outcome = evaluateProbe(manifest, fixture.status, fixture.response);
          expect(outcome.healthy, `${manifest.id}/${fixture.name}`).toBe(fixture.healthy);
          // A recorded failure must never echo the provider's own body.
          if (!fixture.healthy && outcome.detail !== null) {
            expect(fixture.response).not.toContain(outcome.detail);
          }
        }
      });
    });
  }
});
