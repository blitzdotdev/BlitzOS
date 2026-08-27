import { describe, expect, it } from "vitest";
import { evaluateProbe } from "../core/connections/canary.js";
import {
  CATALOG,
  catalogView,
  manifestBaseUrl,
  MissingBaseUrlError,
  providerManifest,
  providerRedirectPath,
} from "../core/connections/catalog/index.js";
import type {
  OAuthProviderManifest,
  ProviderManifest,
} from "../core/connections/catalog/types.js";
import type { ExchangeFixture } from "./connections-fixtures/index.js";
import { EXCHANGE_FIXTURES, PROBE_FIXTURES } from "./connections-fixtures/index.js";
import {
  exchangeForm,
  parseExchangeResponse,
} from "../core/connections/minters/oauth.js";


/** The repository's env contract. Worker vars carry no value there — only a
 * documented name and what it is for — and a connect binding missing from it
 * is a provider an operator cannot switch on because nothing named it. */
const ENV_DEFAULTS = import.meta.glob<string>("../../../env.defaults", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** Every catalog module as the worker bundler sees it: raw source. */
const CATALOG_SOURCES = import.meta.glob<string>("../core/connections/catalog/*.ts", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** The box's Go decoder validates every environment name against this
 * pattern before it prints one, so a catalog entry that would fail a live
 * `blitz-cred env` fails in CI instead. */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

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
  it("keeps one entry per id", () => {
    const ids = CATALOG.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(providerManifest(id)?.id).toBe(id);
    expect(providerManifest("no-such-provider")).toBeNull();
    // The catalog answers to the names in it and to nothing else. `generic`
    // was the one entry that took any name a person typed; ad-hoc secrets are
    // a workspace file now, not a connection.
    expect(providerManifest("generic")).toBeNull();
  });

  /** The recorded answers live in test data, not on the manifests, so the
   * shipped worker no longer carries them. This pin is what keeps that move
   * from quietly costing coverage: a provider added without fixtures fails
   * here instead of shipping unproven. */
  it("records fixtures for every catalog entry, in test data only", () => {
    for (const manifest of CATALOG) {
      expect(PROBE_FIXTURES[manifest.id], `${manifest.id} probe fixtures`)
        .toBeDefined();
      const exchanges = EXCHANGE_FIXTURES[manifest.id];
      if (manifest.auth === null) {
        expect(exchanges, `${manifest.id} records no exchange`).toBeUndefined();
      } else {
        expect(exchanges?.length ?? 0, `${manifest.id} recorded exchanges`)
          .toBeGreaterThan(0);
      }
    }
    const catalogIds = new Set(CATALOG.map(({ id }) => id));
    for (const id of [...Object.keys(PROBE_FIXTURES), ...Object.keys(EXCHANGE_FIXTURES)]) {
      expect(catalogIds, `${id} fixtures name a live catalog entry`).toContain(id);
    }
  });

  /** The shipped worker bundles every file under `core/`. A recorded vendor
   * body that finds its way back onto a manifest would deploy to production,
   * which is the bug this whole move exists to close. */
  it("keeps recorded vendor bodies out of the shipped catalog", () => {
    const recorded = [
      ...Object.values(PROBE_FIXTURES).flat().map(({ response }) => response),
      ...Object.values(EXCHANGE_FIXTURES).flat().map(({ response }) => response),
    ];
    expect(recorded.length, "fixtures were loaded").toBeGreaterThan(0);
    for (const [file, source] of Object.entries(CATALOG_SOURCES)) {
      for (const body of recorded) {
        expect(source, `${file} ships a recorded vendor body`).not.toContain(body);
      }
      expect(source, `${file} declares fixtures`).not.toContain("probeFixtures");
    }
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
        // A vendor root is either a real https URL or an honest null. Null is
        // the instance-hosted case, and `manifestBaseUrl` is the only way to
        // read it — it throws rather than hand back a placeholder host.
        if (manifest.baseUrl === null) {
          expect(manifest.personalToken?.baseUrlLabel ?? null, `${manifest.id} collects an instance URL`)
            .not.toBeNull();
          expect(() => manifestBaseUrl(manifest, "test")).toThrow(MissingBaseUrlError);
        } else {
          expect(new URL(manifest.baseUrl).protocol).toBe("https:");
          expect(manifestBaseUrl(manifest, "test")).toBe(manifest.baseUrl);
        }
        expect(["cp", "proxy"]).toContain(manifest.custody);
        // A header shape that cannot be set would fail only at proxy time.
        expect(() => {
          new Headers().set(
            manifest.tokenHeader.name,
            `${manifest.tokenHeader.prefix}token`,
          );
        }).not.toThrow();
        // The scope vocabulary carries only what something still reads. Where
        // a manifest declares one, `defaultScopes` selects from it and nothing
        // else may sit in it: an entry no caller can name is dead text that
        // reads as a promise. An empty list is the honest answer for a
        // provider whose reach is decided somewhere other than a scope string.
        const scopeIds = manifest.scopes.map(({ id }) => id);
        expect(new Set(scopeIds).size).toBe(scopeIds.length);
        if (scopeIds.length > 0) {
          expect([...scopeIds].sort()).toEqual([...manifest.defaultScopes].sort());
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
          expect(providerRedirectPath(manifest)).toBe(`/connect/${manifest.id}/callback`);
          expect(auth.accessTtlMs).toBeGreaterThan(0);
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

      /** `blitz-cred env` prints these names, and its first line names the
       * header to send with the first one. A provider with no token variable
       * would print a header line for a name that carries no credential. */
      it("declares environment names the box can print", () => {
        const [first] = manifest.delivery.env;
        expect(first?.fill, "the first variable carries the token").toBe("token");
        for (const delivery of manifest.delivery.env) {
          expect(delivery.name).toMatch(ENVIRONMENT_NAME);
        }
        expect(manifest.tokenHeader.name).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/u);
      });

      /** The admin form submits `PUT /connections/:id` from this view alone,
       * so a manifest that declares one must be one that PUT can actually
       * serve: kind "static" for a pasted root, which is the only
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
        // A static root is pasted, not authorized, so it cannot share a
        // manifest with an OAuth flow that would make mint selection
        // ambiguous. Personal-token fallbacks do not use this admin form.
        expect(manifest.auth, "a static admin root is pasted, not authorized").toBeNull();
        // The admin form has never reached a proxy-custody provider, and the
        // form no longer carries a field for one. A manifest that wants both
        // needs the instance-URL input built, not a dead branch waiting.
        expect(manifest.custody, "admin forms are cp custody only").toBe("cp");
        if (view === null) throw new Error("admin form view is missing");
        expect(view.rootLabel).toBe(form.rootLabel);
        expect(view.rootHelp).toBe(form.rootHelp);
        expect(view.app).toEqual(form.app);
        expect(view.placements).toEqual(
          manifest.delivery.env.map(({ name, fill }) => ({ kind: "env", name, fill })),
        );
      });

      it("replays every recorded exchange", () => {
        const auth = manifest.auth;
        if (auth === null) {
          expect(EXCHANGE_FIXTURES[manifest.id]).toBeUndefined();
          return;
        }
        const fixtures = EXCHANGE_FIXTURES[manifest.id] ?? [];
        expect(fixtures.length, "recorded exchanges are mandatory").toBeGreaterThan(0);
        for (const fixture of fixtures) replayExchange({ ...manifest, auth }, fixture);
      });

      it("replays every recorded probe answer", () => {
        // An instance-hosted vendor has no catalog root, so the probe is
        // exercised against the URL a grant would carry.
        const request = manifest.probe.request({
          token: "test-only-probe-token",
          baseUrl: manifest.baseUrl ?? "https://youtrack.acme.example",
          header: manifest.tokenHeader,
        });
        expect(["GET", "POST"]).toContain(request.method);
        expect(new URL(request.url).protocol).toBe("https:");
        const authorization = request.headers.find(
          (header) => header.name === manifest.tokenHeader.name,
        );
        expect(authorization?.value).toContain("test-only-probe-token");
        if (request.method === "GET") expect(request.body).toBeNull();

        const fixtures = PROBE_FIXTURES[manifest.id] ?? [];
        expect(fixtures.length, "recorded probe answers are mandatory").toBeGreaterThan(0);
        for (const fixture of fixtures) {
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
