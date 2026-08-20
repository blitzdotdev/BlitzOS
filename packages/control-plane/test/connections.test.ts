import type {
  CredentialLeaseView,
  ListCatalogResponse,
  ListProviderHealthResponse,
  ListUserGrantsResponse,
  MintResult,
  WorkspaceTemplateView,
  WorkspaceView,
} from "@blitzos/schema";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runProviderCanary } from "../core/index.js";
import worker from "../src/worker.js";
import { CANARY_GRANT_LABEL } from "../core/connections/canary.js";
import { BOX_HOME } from "../core/connections/catalog/surfaces.js";
import {
  appRequest,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  sameOrgSession,
  testConnectSecrets,
  testRuntime,
  type BoxCredential,
} from "./helpers.js";

const LINEAR_KEY = "lin_api_test-only-personal-key";

type Harness = ReturnType<typeof harness>;

async function connectLinear(
  app: Harness["app"],
  cookie: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return appRequest(app, "/connections/grants/linear", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      manifestId: "linear",
      token: LINEAR_KEY,
      scopes: ["read", "write"],
      ...overrides,
    }),
  });
}

/** Drives the real /connect round trip against a recorded token response, so
 * the suite gets an oauth-kind grant without a live provider. */
async function connectLinearOAuth(
  app: Harness["app"],
  cookie: string,
  expiresInSeconds: number,
): Promise<void> {
  testConnectSecrets.set("LINEAR_CLIENT_ID", "client-id-value");
  testConnectSecrets.set("LINEAR_CLIENT_SECRET", "client-secret-value");
  const started = await appRequest(app, "/connect/linear/start", {
    headers: { Cookie: cookie },
  });
  expect(started.status).toBe(302);
  const state = new URL(started.headers.get("location") ?? "")
    .searchParams.get("state") ?? "";
  const stateCookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => Response.json({
      access_token: "linear-access-1",
      refresh_token: "linear-refresh-1",
      expires_in: expiresInSeconds,
    }),
  );
  const callback = await appRequest(
    app,
    `/connect/linear/callback?code=auth-code&state=${state}`,
    { headers: { Cookie: `${cookie}; ${stateCookie}` } },
  );
  expect(callback.status).toBe(302);
  exchange.mockRestore();
}

async function readyWorkspace(
  app: Harness["app"],
  providers: Harness["providers"],
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<{ workspace: WorkspaceView; box: BoxCredential }> {
  const created = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ machineTypeId: "small", ...body }),
  });
  expect(created.status).toBe(201);
  const { workspace } = await created.json<{ workspace: WorkspaceView }>();
  const callback = new URL(phoneHomeUrl(providers, workspace.id));
  const enrolled = await appRequest(app, callback.pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pub_key_ed25519: "ssh-ed25519 AAAAC3Nzatest host" }),
  });
  expect(enrolled.status).toBe(200);
  return { workspace, box: await enrolled.json<BoxCredential>() };
}

async function mint(
  app: Harness["app"],
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return appRequest(app, "/workspaces/self/credentials", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function environmentValue(result: MintResult, name: string): string | null {
  const placement = result.placements.find(
    (candidate) => candidate.kind === "env" && candidate.name === name,
  );
  return placement?.kind === "env" ? placement.value : null;
}

function filePlacement(result: MintResult, path: string): string | null {
  const placement = result.placements.find(
    (candidate) => candidate.kind === "file" && candidate.path === path,
  );
  return placement?.kind === "file" ? placement.value : null;
}

const LINEAR_SKILL_PATH = `${BOX_HOME}/.claude/skills/linear/SKILL.md`;

describe("connections: per-user grants", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves the catalog without leaking a configured client secret", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    testConnectSecrets.set("LINEAR_CLIENT_ID", "client-id-value");
    testConnectSecrets.set("LINEAR_CLIENT_SECRET", "client-secret-value");

    const response = await appRequest(app, "/connections/catalog", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain("client-secret-value");
    expect(raw).not.toContain("client-id-value");
    const { providers } = JSON.parse(raw) as ListCatalogResponse;
    expect(providers.map(({ id }) => id)).toEqual([
      "github",
      "google-workspace",
      "linear",
      "generic",
    ]);
    const linear = providers.find(({ id }) => id === "linear");
    expect(linear?.oauthConfigured).toBe(true);
    expect(linear?.personalTokenLabel).toBe("Personal API key");
    expect(providers.find(({ id }) => id === "github")?.oauthConfigured).toBe(false);
  });

  it("connects a personal key, declares the provider, and never returns it", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);

    expect((await connectLinear(app, cookie, { label: "work" })).status).toBe(204);

    const listed = await appRequest(app, "/connections/grants", {
      headers: { Cookie: cookie },
    });
    const body = await listed.text();
    expect(body).not.toContain(LINEAR_KEY);
    const { grants } = JSON.parse(body) as ListUserGrantsResponse;
    expect(grants).toEqual([{
      provider: "linear",
      manifestId: "linear",
      kind: "pat",
      label: "work",
      scopes: ["read", "write"],
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
      accessExpiresAt: null,
    }]);

    // Connecting declares the provider so leases, audit, and the ceiling all
    // have a connection row to key on. The row holds no secret.
    const connections = await appRequest(app, "/connections", { headers: { Cookie: cookie } });
    await expect(connections.json()).resolves.toMatchObject({
      connections: [{ name: "linear", provider: "linear", kind: "oauth", custody: "proxy" }],
    });
    const stored = await env.DB.prepare(
      "SELECT root_ciphertext FROM connections WHERE scoped_name = 'linear'",
    ).first<{ root_ciphertext: string | null }>();
    expect(stored?.root_ciphertext).toBeNull();
  });

  it("rejects a personal key for a provider that issues none", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/connections/grants/google-workspace", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ manifestId: "google-workspace", token: "nope" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("connect it with OAuth"),
    });
  });

  it("mints from the grant with the skill and the proxy lease token", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, { integration: "linear" });
    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    expect(result.integration).toBe("linear");
    expect(result.mode).toBe("proxy");

    // Proxy custody: the box gets a lease token, never the personal key.
    const leaseToken = environmentValue(result, "LINEAR_API_KEY");
    expect(leaseToken).not.toBe(LINEAR_KEY);
    expect(JSON.stringify(result)).not.toContain(LINEAR_KEY);
    expect(environmentValue(result, "LINEAR_API_URL")).toMatch(/\/proxy\/[0-9a-f-]+$/u);

    const skill = filePlacement(result, LINEAR_SKILL_PATH);
    expect(skill).toContain("name: linear");
    expect(skill).toContain("$LINEAR_API_KEY");
    expect(skill).toContain("read, write");
  });

  /** FROZEN box wire: the Go broker baked into the shipped box image decodes
   * POST /workspaces/self/credentials with DisallowUnknownFields. A grant-backed
   * mint is the default path now, so it is the one that has to be pinned: the
   * grant minter carries `grantedScopes` for the lease, and letting that reach
   * the response fails the box's decode and aborts the whole credential sync. */
  it("keeps the frozen box mint wire on a grant-backed mint", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, { integration: "linear" });
    expect(response.status).toBe(200);
    const raw: unknown = JSON.parse(await response.text());
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("mint response was not a JSON object");
    }
    expect(Object.keys(raw).sort()).toEqual([
      "expiresAt",
      "integration",
      "mode",
      "placements",
    ]);

    // The sync-style call is what blitz-cred actually sends; every element of
    // the array carries the same four keys and nothing else.
    const sync = await mint(app, box.access_token, {});
    expect(sync.status).toBe(200);
    const results: unknown = JSON.parse(await sync.text());
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error("sync response was not a non-empty JSON array");
    }
    for (const result of results) {
      expect(Object.keys(result as object).sort()).toEqual([
        "expiresAt",
        "integration",
        "mode",
        "placements",
      ]);
    }

    // Consented scopes are still recorded — on the lease, where the box wire
    // cannot see them.
    const lease = await env.DB.prepare(
      "SELECT scopes FROM credential_leases ORDER BY issued_at DESC, id LIMIT 1",
    ).first<{ scopes: string }>();
    expect(JSON.parse(lease?.scopes ?? "null")).toEqual(["read", "write"]);
  });

  it("keeps the frozen box mint wire on an inject-custody generic grant", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const connected = await appRequest(app, "/connections/grants/acme", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifestId: "generic",
        token: "acme-test-only-key",
        vendor: { envName: "ACME_API_KEY" },
      }),
    });
    expect(connected.status).toBe(204);
    const { box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, { integration: "acme" });
    expect(response.status).toBe(200);
    const raw: unknown = JSON.parse(await response.text());
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("mint response was not a JSON object");
    }
    expect((raw as MintResult).mode).toBe("inject");
    expect(Object.keys(raw).sort()).toEqual([
      "expiresAt",
      "integration",
      "mode",
      "placements",
    ]);
  });

  it("narrows a default-scoped mint down to what the owner consented to", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // The catalog default is read,write; this owner consented to read alone.
    expect((await connectLinear(app, cookie, { scopes: ["read"] })).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, { integration: "linear" });
    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    // The skill tells the agent what it may do, so it may not claim `write`.
    const skill = filePlacement(result, LINEAR_SKILL_PATH) ?? "";
    expect(skill).toContain("Granted scopes: read.");
    expect(skill).not.toContain("read, write");

    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<{ leases: CredentialLeaseView[] }>();
    expect(rows[0]?.scopes).toEqual(["read"]);
  });

  /** The workspace ceiling is not a consent boundary: enablement writes
   * `{linear:{}}`, which names no scopes and therefore allows all of them. Only
   * the grant knows what the owner agreed to. */
  it("denies a box that asks past the scopes the owner consented to", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie, { scopes: ["read"] })).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, {
      integration: "linear",
      scopes: ["read", "write"],
    });
    expect(response.status).toBe(403);
    const body = await response.json<{ error: string; request_id: string }>();
    expect(body.error).toContain("write");
    expect(body.request_id).toMatch(/^[0-9a-f-]+$/u);

    // No lease was cut, and the denial is auditable with its reason.
    const lease = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM credential_leases WHERE workspace_id = ?1",
    ).bind(workspace.id).first<{ total: number }>();
    expect(lease?.total).toBe(0);
    const events = await appRequest(app, `/workspaces/${workspace.id}/credential-events`, {
      headers: { Cookie: cookie },
    });
    await expect(events.json()).resolves.toMatchObject({
      events: [{ event: "denied", detail: { reason: "outside owner consent" } }],
    });

    // Asking only for what was consented still works.
    const allowed = await mint(app, box.access_token, {
      integration: "linear",
      scopes: ["read"],
    });
    expect(allowed.status).toBe(200);
  });

  it("resolves the workspace owner's grant for an editor's box", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    expect((await connectLinear(app, owner)).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, owner, {
      orgShareRole: "editor",
    });
    // A second member with no grant of their own shares the workspace.
    const editor = await sameOrgSession("editor-one");
    expect(editor.cookie.length).toBeGreaterThan(0);

    const response = await mint(app, box.access_token, { integration: "linear" });
    expect(response.status).toBe(200);

    const lease = await env.DB.prepare(
      "SELECT user_id, grant_id FROM credential_leases WHERE workspace_id = ?1",
    ).bind(workspace.id).first<{ user_id: string; grant_id: string | null }>();
    expect(lease?.user_id).toBe("operator");
    expect(lease?.grant_id).not.toBeNull();
  });

  it("answers a connection with no owner grant as the connect inbox", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const { box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, { integration: "linear" });
    // 404 is the status the shipped box turns into "not configured", and it is
    // the only failure shape that carries a request id back.
    expect(response.status).toBe(404);
    const body = await response.json<{ error: string; request_id: string }>();
    expect(body.request_id).toMatch(/^[0-9a-f-]+$/u);

    const inbox = await appRequest(app, "/requests?state=pending", {
      headers: { Cookie: cookie },
    });
    await expect(inbox.json()).resolves.toMatchObject({
      requests: [{ connection_name: "linear" }],
    });
  });

  /** storeGrant's whole premise is that the replaced grant is dead. An
   * inject-mode lease carries the credential itself, so a lease left active
   * against a re-pasted key is a box holding a value the vendor already
   * invalidated — and a lease panel saying it is fine. */
  it("kills the leases the replaced grant backed when a key is re-pasted", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);
    expect((await mint(app, box.access_token, { integration: "linear" })).status).toBe(200);
    const before = await env.DB.prepare(
      "SELECT id, grant_id FROM credential_leases WHERE workspace_id = ?1",
    ).bind(workspace.id).first<{ id: string; grant_id: string | null }>();
    expect(before?.grant_id).not.toBeNull();

    // Re-pasting a rotated key replaces the grant rather than editing it.
    expect((await connectLinear(app, cookie, { token: "lin_api_rotated-key" })).status).toBe(204);

    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<{ leases: CredentialLeaseView[] }>();
    expect(rows.map(({ id, state }) => [id, state])).toEqual([[before?.id, "revoked"]]);
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM credential_leases WHERE id = ?1",
    ).bind(before?.id).first<{ token_hash: string | null }>();
    expect(stored?.token_hash).toBeNull();
  });

  it("revokes leases with the grant and empties the surfaces on the next sync", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);
    expect((await mint(app, box.access_token, { integration: "linear" })).status).toBe(200);

    const revoked = await appRequest(app, "/connections/grants/linear", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(204);

    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<{ leases: CredentialLeaseView[] }>();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(({ state }) => state === "revoked")).toBe(true);

    // Phase A has no remove-file placement, so the sync overwrites the skill
    // empty and unsets the names instead of leaving a credential-shaped lie.
    const sync = await mint(app, box.access_token, {});
    const results = await sync.json<MintResult[]>();
    const tombstone = results.find(({ integration }) => integration === "linear");
    expect(tombstone?.mode).toBe("inject");
    expect(filePlacement(tombstone ?? { placements: [] } as unknown as MintResult, LINEAR_SKILL_PATH)).toBe("");
    expect(tombstone?.placements).toContainEqual({ kind: "unset-env", name: "LINEAR_API_KEY" });
    expect(tombstone?.placements).toContainEqual({ kind: "unset-env", name: "LINEAR_API_URL" });
  });

  it("proxies a grant-backed lease with the personal key's raw header", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { box } = await readyWorkspace(app, providers, cookie);
    const result = await (await mint(app, box.access_token, { integration: "linear" }))
      .json<MintResult>();
    const leaseToken = environmentValue(result, "LINEAR_API_KEY") ?? "";
    const proxyUrl = environmentValue(result, "LINEAR_API_URL") ?? "";

    let forwarded = "";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe("https://api.linear.app/graphql");
        forwarded = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ data: { viewer: { id: "viewer" } } });
      },
    );

    const proxied = await appRequest(app, `${new URL(proxyUrl).pathname}/graphql`, {
      method: "POST",
      headers: {
        // The box presents the lease token in the connection's declared shape.
        Authorization: `Bearer ${leaseToken}`,
        "Content-Type": "application/json",
      },
      body: '{"query":"{ viewer { id } }"}',
    });
    expect(proxied.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    // A Linear personal key takes a raw Authorization value, no Bearer: the
    // header shape is the grant's, not the box's.
    expect(forwarded).toBe(LINEAR_KEY);
  });
});

describe("connections: templates and enablement", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  async function template(
    app: Harness["app"],
    cookie: string,
    required: boolean,
  ): Promise<WorkspaceTemplateView> {
    const created = await appRequest(app, "/workspace-templates", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "frontend",
        machineTypeId: "small",
        folderIds: [],
        connections: [{ provider: "linear", required }],
      }),
    });
    expect(created.status).toBe(201);
    const { template: view } = await created.json<{ template: WorkspaceTemplateView }>();
    return view;
  }

  it("carries provider names on the template and blocks a required one", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const view = await template(app, cookie, true);
    expect(view.connections).toEqual([{ provider: "linear", required: true }]);

    const blocked = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: view.id }),
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: expect.stringContaining("connect linear"),
    });

    expect((await connectLinear(app, cookie)).status).toBe(204);
    const allowed = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: view.id }),
    });
    expect(allowed.status).toBe(201);
    const { workspace } = await allowed.json<{ workspace: WorkspaceView }>();
    const row = await env.DB.prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id).first<{ manifest: string | null }>();
    // Enablement is the ceiling primitive: the template's provider is listed,
    // so the grant reaches this workspace and no other.
    expect(JSON.parse(row?.manifest ?? "null")).toEqual({ integrations: { linear: {} } });
  });

  it("keeps an explicit ceiling authoritative over the provision list", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        connections: ["linear"],
        manifest: { integrations: {} },
      }),
    });
    expect(created.status).toBe(201);
    const { workspace } = await created.json<{ workspace: WorkspaceView }>();
    const row = await env.DB.prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id).first<{ manifest: string | null }>();
    expect(JSON.parse(row?.manifest ?? "null")).toEqual({ integrations: {} });
  });

  /** Delivery is the box's own sync, not a control-plane push: the phone-home
   * response has no way to carry placements, so a mint at the ready transition
   * only ever wrote lease rows for tokens nobody was handed. */
  it("mints nothing at the ready transition and everything on the first sync", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie, {
      connections: ["linear"],
    });

    const atReady = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    await expect(atReady.json()).resolves.toEqual({ leases: [] });

    expect((await mint(app, box.access_token, {})).status).toBe(200);
    const afterSync = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await afterSync.json<{ leases: CredentialLeaseView[] }>();
    expect(rows.map(({ connection, state }) => [connection, state]))
      .toEqual([["linear", "active"]]);
  });
});

describe("connections: connect flow and canary", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the bindings an operator must set when a provider is unconfigured", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/connect/linear/start", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("LINEAR_CLIENT_ID"),
    });
  });

  it("redirects to the provider with manifest parameters and a bound state", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    testConnectSecrets.set("LINEAR_CLIENT_ID", "client-id-value");
    testConnectSecrets.set("LINEAR_CLIENT_SECRET", "client-secret-value");

    const response = await appRequest(app, "/connect/linear/start", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://linear.app/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("client-id-value");
    expect(location.searchParams.get("response_type")).toBe("code");
    // Linear joins scopes with commas; the delimiter is a manifest fact.
    expect(location.searchParams.get("scope")).toBe("read,write");
    expect(location.searchParams.get("actor")).toBe("user");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri"))
      .toBe("https://cp.example/connect/linear/callback");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("blitz_connect_oauth=");
    expect(setCookie).toContain("Path=/connect");
    expect(setCookie).toContain("HttpOnly");
    // The client secret is never part of an authorize redirect.
    expect(location.search).not.toContain("client-secret-value");
  });

  it("refuses a callback whose state cookie is missing", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    testConnectSecrets.set("LINEAR_CLIENT_ID", "client-id-value");
    testConnectSecrets.set("LINEAR_CLIENT_SECRET", "client-secret-value");
    const response = await appRequest(app, "/connect/linear/callback?code=abc&state=xyz", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(400);
  });

  /** The refresh writes a new `access_expires_at`, but the caller is holding
   * the row it read before that write. Cutting the lease from the stale row
   * gives it an expiry already in the past, and mintFromGrant answers 409 —
   * for that mint and every mint after it, forever. */
  it("mints again after the access token expires and the refresh rotates it", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await connectLinearOAuth(app, cookie, 3_600);
    const { box } = await readyWorkspace(app, providers, cookie);
    expect((await mint(app, box.access_token, { integration: "linear" })).status).toBe(200);

    // Wind the stored token past its expiry, the way an hour of wall clock
    // does in production.
    await env.DB.prepare(
      "UPDATE user_oauth_grants SET access_expires_at = ?1 WHERE provider = 'linear'",
    ).bind(Date.now() - 1_000).run();

    const grantTypes: (string | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      grantTypes.push(new URLSearchParams(String(init?.body)).get("grant_type"));
      return Response.json({
        access_token: "linear-access-2",
        refresh_token: "linear-refresh-2",
        expires_in: 3_600,
      });
    });

    const refreshed = await mint(app, box.access_token, { integration: "linear" });
    expect(refreshed.status).toBe(200);
    expect(grantTypes).toEqual(["refresh_token"]);
    const result = await refreshed.json<MintResult>();
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    // The lease carries the rotated expiry, not the one the pre-refresh row
    // still remembers.
    const lease = await env.DB.prepare(
      "SELECT expires_at, state FROM credential_leases ORDER BY issued_at DESC, id LIMIT 1",
    ).first<{ expires_at: number; state: string }>();
    expect(lease?.state).toBe("active");
    expect(lease?.expires_at).toBeGreaterThan(Date.now());

    // And the mint after it is an ordinary fresh-token mint, not a second 409.
    expect((await mint(app, box.access_token, { integration: "linear" })).status).toBe(200);
    expect(grantTypes).toEqual(["refresh_token"]);
  });

  /** principals.ts guards decodeURIComponent because a cookie is attacker-
   * controlled text; the local copy this route carried did not, so one bare
   * "%" threw a URIError out of a route with no handler for it. */
  it("answers 400, not 500, for a malformed connect state cookie", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    testConnectSecrets.set("LINEAR_CLIENT_ID", "client-id-value");
    testConnectSecrets.set("LINEAR_CLIENT_SECRET", "client-secret-value");

    const response = await appRequest(app, "/connect/linear/callback?code=abc&state=xyz", {
      headers: { Cookie: `${cookie}; blitz_connect_oauth=%` },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("connect state"),
    });
  });

  it("probes a canary grant, records health, and serves it to the panel", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie, { label: CANARY_GRANT_LABEL })).status).toBe(204);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe("https://api.linear.app/graphql");
        // The canary presents the grant's own header shape.
        expect(new Headers(init?.headers).get("authorization")).toBe(LINEAR_KEY);
        return Response.json({ data: { viewer: { id: "viewer", name: "Canary" } } });
      },
    );

    expect(await runProviderCanary(testRuntime(providers))).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();

    const health = await appRequest(app, "/connections/health", {
      headers: { Cookie: cookie },
    });
    const { providers: reported } = await health.json<ListProviderHealthResponse>();
    expect(reported.find(({ provider }) => provider === "linear")).toMatchObject({
      state: "healthy",
      detail: null,
    });
    // Providers with no canary grant are honestly unchecked, not healthy.
    expect(reported.find(({ provider }) => provider === "github")).toMatchObject({
      state: "unchecked",
      checkedAt: null,
    });
  });

  it("records an unhealthy provider without echoing the response body", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie, { label: CANARY_GRANT_LABEL })).status).toBe(204);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => Response.json(
        { errors: [{ message: "Authentication required, not authenticated" }] },
      ),
    );

    await runProviderCanary(testRuntime(providers));

    const health = await appRequest(app, "/connections/health", {
      headers: { Cookie: cookie },
    });
    const raw = await health.text();
    expect(raw).not.toContain("Authentication required");
    const { providers: reported } = JSON.parse(raw) as ListProviderHealthResponse;
    expect(reported.find(({ provider }) => provider === "linear")).toMatchObject({
      state: "unhealthy",
      detail: "missing data.viewer.id",
    });
  });
});
