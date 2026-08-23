import type {
  ConnectionView,
  CredentialLeaseView,
  ListCatalogResponse,
  ListGithubRepositoriesResponse,
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
import { runLeaseSweep, runProviderCanary } from "../core/index.js";
import worker from "../src/worker.js";
import { CANARY_GRANT_LABEL } from "../core/connections/canary.js";
import {
  CONNECT_OAUTH_COOKIE,
  createConnectOAuthState,
  verifyConnectOAuthStateCookie,
} from "../core/oauth-state.js";
import { BOX_HOME } from "../core/connections/catalog/workspace-delivery.js";
import {
  importGithubAppPrivateKey,
  normalizeGithubAppPrivateKey,
} from "../core/connections/minters/app-jwt/github-app.js";
import {
  appRequest,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  sameOrgSession,
  testConnectSecrets,
  testRuntime,
  userSession,
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
  // The callback is a cross-site navigation: the SameSite=Strict session
  // cookie is absent in a real browser, so the request carries only the
  // Lax state cookie. Sending the session here would mask the exact bug
  // this flow shipped with.
  const callback = await appRequest(
    app,
    `/connect/linear/callback?code=auth-code&state=${state}`,
    { headers: { Cookie: stateCookie } },
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
      "discord",
      "youtrack",
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
      // Every scope the provider's catalog knows about. A pasted key carries
      // whatever reach its owner gave it and nothing here can narrow that, so
      // the grant records the vocabulary rather than pretending to a choice.
      // The vocabulary is only what a caller can still name: the three
      // narrower Linear scopes went with the checkbox UI that selected them.
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

  it("keeps the frozen box mint wire on an inject-custody grant", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // github is the cp-custody pasted key: the credential itself lands in the
    // box, so the mint body is the inject shape.
    const granted = await appRequest(app, "/connections/grants/github", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifestId: "github",
        token: "github_pat_test-only-key",
      }),
    });
    expect(granted.status).toBe(204);
    const { box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, { integration: "github" });
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

  /** The scope checkboxes are gone and so is the narrowing behind them: a
   * pasted key carries the reach its owner created it with, the OAuth path
   * never sent per-grant scopes, and only an org-app mint could narrow at all
   * (API-only). What the grant records is the provider's vocabulary; what the
   * lease records is the connection's declared default. */
  it("records the connection's declared scopes on the lease and in the skill", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    // A body that still names scopes is accepted and ignored: the grant is not
    // where reach is decided any more.
    expect((await connectLinear(app, cookie, { scopes: ["read"] })).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, { integration: "linear" });
    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    const skill = filePlacement(result, LINEAR_SKILL_PATH) ?? "";
    expect(skill).toContain("Scopes recorded for this connection: read, write.");
    // The copy describes the token's own ceiling instead of implying a narrowing.
    expect(skill).toContain("nothing here narrows that");

    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<{ leases: CredentialLeaseView[] }>();
    expect(rows[0]?.scopes).toEqual(["read", "write"]);
  });

  /** The mint-time consent gate is a pass-through now. It used to compare a
   * box's requested scopes against a per-grant list the checkboxes wrote, and
   * refuse the difference — a gate over a choice the person could not really
   * make, since no provider lets us narrow a key after the fact. The workspace
   * ceiling is the gate that still means something. */
  it("hands a box the scopes it names, with no per-grant consent gate", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie, { scopes: ["read"] })).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);

    const response = await mint(app, box.access_token, {
      integration: "linear",
      scopes: ["read", "write"],
    });
    expect(response.status).toBe(200);

    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<{ leases: CredentialLeaseView[] }>();
    expect(rows[0]?.scopes).toEqual(["read", "write"]);

    // Nothing was refused, so nothing is in the denial log.
    const events = await appRequest(app, `/workspaces/${workspace.id}/credential-events`, {
      headers: { Cookie: cookie },
    });
    const { events: logged } = await events.json<{ events: { event: string }[] }>();
    expect(logged.map(({ event }) => event)).not.toContain("denied");
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

  /** Every `blitz-cred sync` minted another lease and retired nothing, so a
   * workspace accumulated one active row per sync and the older proxy token
   * stayed live for its whole TTL. One connection holds one live lease. */
  it("supersedes the prior lease when the same connection mints again", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);

    expect((await mint(app, box.access_token, { integration: "linear" })).status).toBe(200);
    const first = await env.DB.prepare(
      "SELECT id FROM credential_leases WHERE workspace_id = ?1",
    ).bind(workspace.id).first<{ id: string }>();
    expect((await mint(app, box.access_token, { integration: "linear" })).status).toBe(200);

    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<{ leases: CredentialLeaseView[] }>();
    expect(rows.length).toBe(2);
    expect(rows.filter(({ state }) => state === "active").length).toBe(1);
    expect(rows.find(({ id }) => id === first?.id)?.state).toBe("revoked");
    // A proxy lease's token is its access: superseding has to kill the value,
    // not just the row's label.
    const superseded = await env.DB.prepare(
      "SELECT token_hash FROM credential_leases WHERE id = ?1",
    ).bind(first?.id).first<{ token_hash: string | null }>();
    expect(superseded?.token_hash).toBeNull();
  });

  /** The sync-all loop mints every connection in one pass. Superseding is
   * scoped to the pair being minted, so linear's new lease must not retire the
   * one github is holding. */
  it("supersedes only the connection being minted during a sync", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const github = await appRequest(app, "/connections/grants/github", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifestId: "github",
        token: "github_pat_test-only-key",
      }),
    });
    expect(github.status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie);

    expect((await mint(app, box.access_token, {})).status).toBe(200);
    expect((await mint(app, box.access_token, {})).status).toBe(200);

    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await leases.json<{ leases: CredentialLeaseView[] }>();
    const live = rows.filter(({ state }) => state === "active");
    expect(live.map(({ connection }) => connection).sort()).toEqual(["github", "linear"]);
    expect(rows.length).toBe(4);
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
  ): Promise<WorkspaceTemplateView> {
    const created = await appRequest(app, "/workspace-templates", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "frontend",
        machineTypeId: "small",
        folderIds: [],
        connections: [{ provider: "linear" }],
      }),
    });
    expect(created.status).toBe(201);
    const { template: view } = await created.json<{ template: WorkspaceTemplateView }>();
    return view;
  }

  /** Creation never blocks on connections: a stipulated provider with no
   * grant behind it still creates, reads as needs-you in the panel (no live
   * lease), and lights up when the grant lands. The old 409 gate is gone. */
  it("carries provider names on the template and creates without the grant", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const view = await template(app, cookie);
    expect(view.connections).toEqual([{ provider: "linear" }]);

    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: view.id }),
    });
    expect(created.status).toBe(201);
    const { workspace } = await created.json<{ workspace: WorkspaceView }>();
    const row = await env.DB.prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id).first<{ manifest: string | null }>();
    // Enablement is the ceiling primitive: the template's provider is listed,
    // so a later grant reaches this workspace and no other — and the view
    // names it, which is what the panel's needs-you row draws from.
    expect(JSON.parse(row?.manifest ?? "null")).toEqual({ integrations: { linear: {} } });
    expect(workspace.connections).toEqual(["linear"]);

    // No grant, no lease: the workspace exists with no live lease for the provider.
    const bare = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: none } = await bare.json<{ leases: CredentialLeaseView[] }>();
    expect(none).toEqual([]);

    // Connecting afterwards mints on the next create; the first workspace
    // stays reachable the whole time.
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const second = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: view.id }),
    });
    expect(second.status).toBe(201);
    const { workspace: leaseLive } = await second.json<{ workspace: WorkspaceView }>();
    const minted = await appRequest(app, `/workspaces/${leaseLive.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases } = await minted.json<{ leases: CredentialLeaseView[] }>();
    expect(leases.map(({ connection, state }) => [connection, state]))
      .toEqual([["linear", "active"]]);
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

  /** A create that names connections promises a workspace that has them, so
   * the lease exists before any box does — the live lease row IS the state, and
   * the box's first sync supersedes it with an identical one rather than being
   * the thing that creates it. */
  it("mints the named connections at create and supersedes them on the first sync", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, cookie, {
      connections: ["linear"],
    });

    const atCreate = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: created } = await atCreate.json<{ leases: CredentialLeaseView[] }>();
    expect(created.map(({ connection, state, boxId }) => [connection, state, boxId]))
      .toEqual([["linear", "active", null]]);

    expect((await mint(app, box.access_token, {})).status).toBe(200);
    const afterSync = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases: rows } = await afterSync.json<{ leases: CredentialLeaseView[] }>();
    expect(rows.filter(({ state }) => state === "active")
      .map(({ connection, boxId }) => [connection, boxId]))
      .toEqual([["linear", box.box_id]]);
    expect(rows.filter(({ state }) => state === "revoked")
      .map(({ connection }) => connection)).toEqual(["linear"]);
  });

  /** A provider the creator never authorized is not an error at create; the
   * grid simply shows it with no live lease. */
  it("skips a named connection the creator never authorized", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const { workspace } = await readyWorkspace(app, providers, cookie, {
      connections: ["linear"],
    });
    const listed = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    await expect(listed.json()).resolves.toEqual({ leases: [] });
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

  /** The catch branch used to subtract the cron tick's start instead of the
   * probe's, so a failure inherited every earlier provider's probe time and
   * the table reported a vendor that was never slow. */
  it("times a failed probe from the probe, not from the tick", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie, { label: CANARY_GRANT_LABEL })).status).toBe(204);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("connection reset");
    });

    // A tick that started ten minutes ago: the probe itself still took ~0ms.
    await runProviderCanary(testRuntime(providers), Date.now() - 10 * 60 * 1_000);

    const health = await appRequest(app, "/connections/health", {
      headers: { Cookie: cookie },
    });
    const { providers: reported } = await health.json<ListProviderHealthResponse>();
    const linear = reported.find(({ provider }) => provider === "linear");
    expect(linear?.state).toBe("unhealthy");
    expect(linear?.detail).toBe("probe request failed");
    expect(linear?.latencyMs).toBeLessThan(60_000);
    // A provider that was never probed reports no latency rather than zero.
    expect(reported.find(({ provider }) => provider === "github")?.latencyMs).toBeNull();
  });

  /** One authenticated third-party call per canary provider per tick. On the
   * five-minute backstop that is 288 a day against the vendor's rate limit,
   * for a signal the hourly tick already carries. */
  it("probes on the hourly tick alone", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie, { label: CANARY_GRANT_LABEL })).status).toBe(204);
    const probed: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      probed.push(String(input));
      return Response.json({ data: { viewer: { id: "viewer", name: "Canary" } } });
    });
    const tick = async (cron: string): Promise<void> => {
      const executionContext = createExecutionContext();
      await worker.scheduled(
        createScheduledController({ scheduledTime: Date.now(), cron }),
        env as never,
        executionContext,
      );
      await waitOnExecutionContext(executionContext);
    };

    await tick("*/5 * * * *");
    expect(probed).toEqual([]);
    await tick("0 3 * * *");
    expect(probed).toEqual([]);
    await tick("0 * * * *");
    expect(probed).toEqual(["https://api.linear.app/graphql"]);
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

/** Connecting is giving a workspace a lease, and this is the route a person
 * uses to do it. The frozen box route above is untouched by any of it. */
describe("connections: connecting from the webApp", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connectHere(
    app: Harness["app"],
    cookie: string,
    workspaceId: string,
    name = "linear",
  ): Promise<Response> {
    return appRequest(
      app,
      `/workspaces/${workspaceId}/connections/${name}/lease`,
      { method: "POST", headers: { Cookie: cookie } },
    );
  }

  it("mints a lease from the caller's grant and hands the row back", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace } = await readyWorkspace(app, providers, cookie);

    const response = await connectHere(app, cookie, workspace.id);
    expect(response.status).toBe(200);
    const { lease } = await response.json<{ lease: CredentialLeaseView }>();
    expect(lease).toMatchObject({
      workspaceId: workspace.id,
      connection: "linear",
      state: "active",
      // No box asked for this one, and audit says so rather than inventing one.
      boxId: null,
    });

    const listed = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases } = await listed.json<{ leases: CredentialLeaseView[] }>();
    expect(leases.map(({ id, state }) => [id, state])).toEqual([[lease.id, "active"]]);
  });

  it("refuses a member who cannot control the workspace", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    expect((await connectLinear(app, owner)).status).toBe(204);
    const { workspace } = await readyWorkspace(app, providers, owner, {
      orgShareRole: "editor",
    });
    const editor = await sameOrgSession("editor-one");

    expect((await connectHere(app, editor.cookie, workspace.id)).status).toBe(403);
  });

  it("stays inside the workspace ceiling", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    // A ceiling naming no connections allows none of them.
    const { workspace } = await readyWorkspace(app, providers, cookie, {
      manifest: { integrations: {} },
    });

    const response = await connectHere(app, cookie, workspace.id);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("exceeds the workspace manifest"),
    });
    // A person's own refusal is an answer, not an entry in their own inbox.
    const inbox = await appRequest(app, "/requests", { headers: { Cookie: cookie } });
    await expect(inbox.json()).resolves.toEqual({ requests: [] });
  });

  it("cuts the lease at the connection's declared scopes", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace } = await readyWorkspace(app, providers, cookie);

    const response = await connectHere(app, cookie, workspace.id);
    expect(response.status).toBe(200);
    const { lease } = await response.json<{ lease: CredentialLeaseView }>();
    expect(lease.scopes).toEqual(["read", "write"]);
  });

  it("answers a provider the account never authorized", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace } = await readyWorkspace(app, providers, cookie);

    expect((await connectHere(app, cookie, workspace.id, "github")).status).toBe(404);
  });

  it("supersedes, so connecting twice leaves one live lease", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await connectLinear(app, cookie)).status).toBe(204);
    const { workspace } = await readyWorkspace(app, providers, cookie);

    expect((await connectHere(app, cookie, workspace.id)).status).toBe(200);
    const second = await connectHere(app, cookie, workspace.id);
    expect(second.status).toBe(200);
    const { lease } = await second.json<{ lease: CredentialLeaseView }>();

    const listed = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases } = await listed.json<{ leases: CredentialLeaseView[] }>();
    expect(leases.filter(({ state }) => state === "active").map(({ id }) => id))
      .toEqual([lease.id]);
    expect(leases.filter(({ state }) => state === "revoked")).toHaveLength(1);
  });

  it("connects the workspace an OAuth round trip started from", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const { workspace } = await readyWorkspace(app, providers, cookie);
    testConnectSecrets.set("LINEAR_CLIENT_ID", "client-id-value");
    testConnectSecrets.set("LINEAR_CLIENT_SECRET", "client-secret-value");

    const started = await appRequest(
      app,
      `/connect/linear/start?workspaceId=${workspace.id}`,
      { headers: { Cookie: cookie } },
    );
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get("location") ?? "")
      .searchParams.get("state") ?? "";
    const stateCookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const exchange = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => Response.json({
        access_token: "linear-access-1",
        refresh_token: "linear-refresh-1",
        expires_in: 3_600,
      }),
    );
    const callback = await appRequest(
      app,
      `/connect/linear/callback?code=auth-code&state=${state}`,
      { headers: { Cookie: stateCookie } },
    );
    exchange.mockRestore();
    expect(callback.status).toBe(302);
    // Back where connecting started, not in settings.
    expect(new URL(callback.headers.get("location") ?? "").pathname)
      .toBe(`/workspaces/${workspace.id}`);

    const listed = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const { leases } = await listed.json<{ leases: CredentialLeaseView[] }>();
    expect(leases.map(({ connection, state: leaseState }) => [connection, leaseState]))
      .toEqual([["linear", "active"]]);
  });

  it("leaves a settings round trip in settings, with no lease anywhere", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const { workspace } = await readyWorkspace(app, providers, cookie);
    await connectLinearOAuth(app, cookie, 3_600);

    const listed = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    await expect(listed.json()).resolves.toEqual({ leases: [] });
  });

  it("refuses to sign a workspace the caller cannot control into the state", async () => {
    const { app, providers } = harness();
    const owner = await operatorSession(app);
    const { workspace } = await readyWorkspace(app, providers, owner, {
      orgShareRole: "editor",
    });
    const editor = await sameOrgSession("editor-one");
    testConnectSecrets.set("LINEAR_CLIENT_ID", "client-id-value");
    testConnectSecrets.set("LINEAR_CLIENT_SECRET", "client-secret-value");

    const started = await appRequest(
      app,
      `/connect/linear/start?workspaceId=${workspace.id}`,
      { headers: { Cookie: editor.cookie } },
    );
    expect(started.status).toBe(403);
  });
});

/** The connect half of the signed-state helper had no unit coverage of its
 * own: every guarantee below was only ever exercised through the happy-path
 * route. They are the reason the state is signed at all. */
describe("connect oauth state", () => {
  const SECRET = "state-secret";
  const CREATED_AT = 1_000;
  const EXPIRES_AT = CREATED_AT + 10 * 60 * 1_000;

  async function signedCookie(provider: string): Promise<{
    cookie: string;
    state: string;
    codeVerifier: string;
  }> {
    const created = await createConnectOAuthState(SECRET, provider, "user-1", "membership-1", null, CREATED_AT);
    const pair = (created.cookie.split(";")[0] ?? "");
    expect(pair.startsWith(`${CONNECT_OAUTH_COOKIE}=`)).toBe(true);
    expect(created.cookie).toContain("Path=/connect");
    expect(created.cookie).toContain("HttpOnly");
    return {
      cookie: decodeURIComponent(pair.slice(`${CONNECT_OAUTH_COOKIE}=`.length)),
      state: created.state,
      codeVerifier: created.codeVerifier,
    };
  }

  it("binds the provider, the verifier, and the deadline into the signature", async () => {
    const { cookie, state, codeVerifier } = await signedCookie("linear");

    await expect(
      verifyConnectOAuthStateCookie(cookie, state, "linear", SECRET, EXPIRES_AT - 1),
    ).resolves.toMatchObject({
      provider: "linear",
      codeVerifier,
      userId: "user-1",
      membershipId: "membership-1",
    });

    // Replayed against a second provider's token endpoint.
    await expect(
      verifyConnectOAuthStateCookie(cookie, state, "github", SECRET, CREATED_AT + 1),
    ).resolves.toBeNull();
    // Attacker-chosen state, tampered cookie, wrong signing key, expired.
    await expect(
      verifyConnectOAuthStateCookie(cookie, "wrong-state", "linear", SECRET, CREATED_AT + 1),
    ).resolves.toBeNull();
    await expect(
      verifyConnectOAuthStateCookie(`${cookie}x`, state, "linear", SECRET, CREATED_AT + 1),
    ).resolves.toBeNull();
    await expect(
      verifyConnectOAuthStateCookie(cookie, state, "linear", "other-secret", CREATED_AT + 1),
    ).resolves.toBeNull();
    await expect(
      verifyConnectOAuthStateCookie(cookie, state, "linear", SECRET, EXPIRES_AT),
    ).resolves.toBeNull();
  });

  it("keeps the login cookie and the connect cookie apart", async () => {
    const connect = await createConnectOAuthState(SECRET, "linear", "user-1", null, null, CREATED_AT);
    expect(connect.cookie).toContain(`${CONNECT_OAUTH_COOKIE}=`);
    expect(connect.cookie).not.toContain("blitz_google_oauth=");
    expect(connect.cookie).not.toContain("Path=/auth/google");
  });
});

const ROOT = "test-only-static-root-value";
const GITHUB_TOKEN = "test-only-github-installation-token";

function encodePem(label: string, value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
}

function derElement(
  value: Uint8Array,
  offset: number,
): { tag: number; contentStart: number; contentEnd: number; next: number } {
  const tag = value[offset];
  const lengthByte = value[offset + 1];
  if (tag === undefined || lengthByte === undefined) throw new Error("invalid DER");
  let length = lengthByte;
  let contentStart = offset + 2;
  if ((lengthByte & 0x80) !== 0) {
    const lengthBytes = lengthByte & 0x7f;
    if (lengthBytes === 0) throw new Error("invalid DER");
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      const byte = value[contentStart + index];
      if (byte === undefined) throw new Error("invalid DER");
      length = length * 256 + byte;
    }
    contentStart += lengthBytes;
  }
  const contentEnd = contentStart + length;
  if (contentEnd > value.byteLength) throw new Error("invalid DER");
  return { tag, contentStart, contentEnd, next: contentEnd };
}

function pkcs1FromPkcs8(value: Uint8Array): Uint8Array {
  const outer = derElement(value, 0);
  const version = derElement(value, outer.contentStart);
  const algorithm = derElement(value, version.next);
  const privateKey = derElement(value, algorithm.next);
  if (
    outer.tag !== 0x30 ||
    version.tag !== 0x02 ||
    algorithm.tag !== 0x30 ||
    privateKey.tag !== 0x04
  ) {
    throw new Error("unexpected PKCS#8 structure");
  }
  return value.slice(privateKey.contentStart, privateKey.contentEnd);
}

function decodeBase64Url(value: string): Uint8Array {
  const encoded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

/** The DER inside a PEM, whatever its armor label. */
function pemDer(value: string): Uint8Array {
  const body = value
    .replace(/-----(?:BEGIN|END) [A-Z ]*PRIVATE KEY-----/gu, "")
    .replace(/\s/gu, "");
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

async function githubKeyPair(): Promise<{
  privatePem: string;
  pkcs1Pem: string;
  publicKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateKey = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    privatePem: encodePem("PRIVATE KEY", privateKey),
    pkcs1Pem: encodePem("RSA PRIVATE KEY", pkcs1FromPkcs8(privateKey)),
    publicKey: pair.publicKey,
  };
}

async function createReadyWorkspace(
  app: ReturnType<typeof harness>["app"],
  providers: ReturnType<typeof harness>["providers"],
  cookie: string,
  integrations: Record<string, Record<string, unknown>> | null = null,
): Promise<{ workspace: WorkspaceView; box: BoxCredential }> {
  const created = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      machineTypeId: "small",
      sshPublicKey: "ssh-ed25519 AAAAC3Nzatest credentials",
      ...(integrations === null ? {} : { manifest: { integrations } }),
    }),
  });
  expect(created.status).toBe(201);
  const { workspace } = await created.json<{ workspace: WorkspaceView }>();
  const callback = new URL(phoneHomeUrl(providers, workspace.id));
  const enrolled = await appRequest(app, callback.pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hostPublicKeys: ["ssh-ed25519 AAAAC3Nzatest host"],
    }),
  });
  expect(enrolled.status).toBe(200);
  return { workspace, box: await enrolled.json<BoxCredential>() };
}

async function putStaticConnection(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name: string,
  options: {
    root?: string;
    scopes?: string[];
    placements?: Record<string, unknown>[];
    owners?: string[];
  } = {},
): Promise<void> {
  const response = await appRequest(app, `/connections/${name}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "hetzner",
      kind: "static",
      custody: "cp",
      root: options.root ?? ROOT,
      config: {
        default_scopes: options.scopes ?? [],
        placements: options.placements ?? [
          { kind: "env", name: "HCLOUD_TOKEN" },
        ],
      },
      ...(options.owners === undefined
        ? {}
        : { usable_by: { owners: options.owners } }),
    }),
  });
  expect(response.status).toBe(204);
}

async function putProxyConnection(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name: string,
  options: {
    baseUrl?: string;
    tokenHeader?: string;
    tokenPrefix?: string;
  } = {},
): Promise<void> {
  const response = await appRequest(app, `/connections/${name}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "static-vendor",
      kind: "static",
      root: ROOT,
      config: {
        placements: [
          { kind: "env", name: "VENDOR_LEASE_TOKEN" },
          { kind: "env", name: "VENDOR_BASE_URL", fill: "proxy-url" },
        ],
        proxy: {
          base_url: options.baseUrl ?? "https://vendor.example/api",
          ...(options.tokenHeader === undefined
            ? {}
            : { token_header: options.tokenHeader }),
          ...(options.tokenPrefix === undefined
            ? {}
            : { token_prefix: options.tokenPrefix }),
        },
      },
    }),
  });
  expect(response.status).toBe(204);
}

function proxyHandle(result: MintResult): {
  leaseId: string;
  proxyUrl: string;
  token: string;
} {
  const tokenPlacement = result.placements.find(
    (placement) =>
      placement.kind === "env" && placement.name === "VENDOR_LEASE_TOKEN",
  );
  const urlPlacement = result.placements.find(
    (placement) =>
      placement.kind === "env" && placement.name === "VENDOR_BASE_URL",
  );
  if (
    tokenPlacement?.kind !== "env" ||
    urlPlacement?.kind !== "env"
  ) {
    throw new Error("proxy placements are missing");
  }
  const leaseId = new URL(urlPlacement.value).pathname.split("/").at(-1);
  if (leaseId === undefined || leaseId.length === 0) {
    throw new Error("proxy lease id is missing");
  }
  return {
    leaseId,
    proxyUrl: urlPlacement.value,
    token: tokenPlacement.value,
  };
}

async function putGithubConnection(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  root: string,
): Promise<Response> {
  return appRequest(app, "/connections/github", {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "github",
      kind: "app-jwt",
      custody: "cp",
      root,
      config: {
        app_id: "123456",
        installation_id: "987654",
        repositories: ["requested-repo"],
        permissions: { contents: "write" },
      },
    }),
  });
}

async function mintFor(
  app: ReturnType<typeof harness>["app"],
  workspaceId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return appRequest(app, `/workspaces/${workspaceId}/credentials`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("connections: org-root rows, proxy transport, and the request inbox", () => {
  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signs a bounded RS256 app JWT and records GitHub's granted scope truth", async () => {
    const { privatePem, publicKey } = await githubKeyPair();
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await putGithubConnection(app, cookie, privatePem)).status).toBe(204);
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      github: { scopes: ["requested:scope"] },
    });
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    let authorization = "";
    let requestBody = "";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe(
          "https://api.github.com/app/installations/987654/access_tokens",
        );
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("accept")).toBe("application/vnd.github+json");
        authorization = headers.get("authorization") ?? "";
        requestBody = String(init?.body);
        return Response.json({
          token: GITHUB_TOKEN,
          expires_at: expiresAt,
          repositories: [{ name: "granted-repo" }],
          permissions: { contents: "read", issues: "write" },
        });
      },
    );
    const startedAt = Math.floor(Date.now() / 1000);

    const response = await mintFor(app, workspace.id, box.access_token, {
      integration: "github",
      scopes: ["requested:scope"],
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(requestBody)).toEqual({
      repositories: ["requested-repo"],
      permissions: { contents: "write" },
    });
    const result = await response.json<MintResult>();
    expect(result).toEqual({
      integration: "github",
      mode: "inject",
      placements: [
        { kind: "env", name: "GH_TOKEN", value: GITHUB_TOKEN },
        { kind: "env", name: "GITHUB_TOKEN", value: GITHUB_TOKEN },
      ],
      expiresAt: Date.parse(expiresAt),
    });
    // GitHub's granted-scope truth is lease bookkeeping, not box wire: the
    // shipped broker decodes with DisallowUnknownFields and a fifth key
    // fails the decode. It is asserted on the lease row below.
    expect(Object.keys(result).sort()).toEqual([
      "expiresAt",
      "integration",
      "mode",
      "placements",
    ]);

    const jwt = authorization.replace(/^Bearer\s+/u, "");
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined
    ) {
      throw new Error("github app JWT was malformed");
    }
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedHeader)))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(encodedPayload)),
    ) as { iat: number; exp: number; iss: string };
    const finishedAt = Math.floor(Date.now() / 1000);
    expect(payload.iss).toBe("123456");
    expect(payload.iat).toBeGreaterThanOrEqual(startedAt - 61);
    expect(payload.iat).toBeLessThanOrEqual(finishedAt - 60);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(10 * 60);
    expect(payload.exp).toBeGreaterThan(finishedAt);
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        decodeBase64Url(encodedSignature),
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      ),
    ).toBe(true);
    const lease = await env.DB
      .prepare("SELECT scopes FROM credential_leases WHERE workspace_id = ?1")
      .bind(workspace.id)
      .first<{ scopes: string }>();
    expect(JSON.parse(lease?.scopes ?? "null")).toEqual([
      "repo:granted-repo",
      "contents:read",
      "issues:write",
    ]);
  });

  it("accepts GitHub's PKCS#1 download and seals a key the minter signs with", async () => {
    const { pkcs1Pem, publicKey } = await githubKeyPair();
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await putGithubConnection(app, cookie, pkcs1Pem)).status).toBe(204);
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      github: {},
    });
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    let authorization = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ token: GITHUB_TOKEN, expires_at: expiresAt });
    });

    const response = await mintFor(app, workspace.id, box.access_token, {
      integration: "github",
    });

    expect(response.status).toBe(200);
    // The signature proves the wrap: the mint imported the sealed root as
    // PKCS#8 and signed with the same key GitHub handed out as PKCS#1.
    const [header, payload, signature] = authorization
      .replace(/^Bearer\s+/u, "")
      .split(".");
    if (header === undefined || payload === undefined || signature === undefined) {
      throw new Error("github app JWT was malformed");
    }
    expect(
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        decodeBase64Url(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(true);
  });

  it("re-armors PKCS#1 into the exact PKCS#8 bytes WebCrypto exported", async () => {
    const { privatePem, pkcs1Pem, publicKey } = await githubKeyPair();

    const normalized = normalizeGithubAppPrivateKey(pkcs1Pem);

    expect(normalized.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(pemDer(normalized)).toEqual(pemDer(privatePem));
    // A PKCS#8 root passes through untouched: sealed bytes never churn.
    expect(normalizeGithubAppPrivateKey(privatePem)).toBe(privatePem);
    // And the wrapped key signs through the real importer.
    const data = new TextEncoder().encode("wrap-round-trip");
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      await importGithubAppPrivateKey(normalized),
      data,
    );
    expect(
      await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signature, data),
    ).toBe(true);
  });

  it("rejects encrypted keys and garbage without storing a row", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const invalid = {
      error: "private key must be an RSA private key PEM (the .pem file GitHub generates)",
      retryAction: null,
    };
    const encrypted = {
      error: "the private key is encrypted; upload the unencrypted .pem file GitHub generated",
      retryAction: null,
    };

    const garbage = await putGithubConnection(app, cookie, "not-a-key");
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toEqual(invalid);

    // PKCS#1 armor around bytes that are no RSA key: the wrap succeeds
    // structurally and the importer is the one that says no.
    const armoredGarbage = await putGithubConnection(
      app,
      cookie,
      "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----",
    );
    expect(armoredGarbage.status).toBe(400);
    expect(await armoredGarbage.json()).toEqual(invalid);

    const encryptedPkcs8 = await putGithubConnection(
      app,
      cookie,
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
    );
    expect(encryptedPkcs8.status).toBe(400);
    expect(await encryptedPkcs8.json()).toEqual(encrypted);

    const encryptedPkcs1 = await putGithubConnection(
      app,
      cookie,
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----",
    );
    expect(encryptedPkcs1.status).toBe(400);
    expect(await encryptedPkcs1.json()).toEqual(encrypted);

    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM connections")
        .first<number>("count"),
    ).toBe(0);
  });

  it("maps a GitHub 401 to a value-free 502 and creates no lease", async () => {
    const { privatePem } = await githubKeyPair();
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    expect((await putGithubConnection(app, cookie, privatePem)).status).toBe(204);
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      github: {},
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { token: "must-not-escape-vendor-error-body" },
        { status: 401 },
      ),
    );

    const response = await mintFor(app, workspace.id, box.access_token, {
      integration: "github",
    });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({
      error: "github rejected the app JWT (key or clock)",
      retryAction: null,
    });
    expect(JSON.stringify(body)).not.toContain("must-not-escape-vendor-error-body");
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_leases")
        .first<number>("count"),
    ).toBe(0);
  });

  it("answers 409 connect github for the repo listing until an app root is configured", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);

    const response = await appRequest(app, "/connections/github/repositories", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "connect github",
      retryAction: null,
    });
  });

  it("pages the installation repo listing with small pages and aggregates names only", async () => {
    const { privatePem } = await githubKeyPair();
    const { app } = harness();
    const cookie = await operatorSession(app);
    expect((await putGithubConnection(app, cookie, privatePem)).status).toBe(204);
    const member = await sameOrgSession("browser");

    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/access_tokens")) {
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toMatch(/^Bearer /u);
        // The listing token carries the same restrictions the mint path
        // sends, so the picker shows exactly what a clone token can reach.
        expect(JSON.parse(String(init?.body))).toEqual({
          repositories: ["requested-repo"],
          permissions: { contents: "write" },
        });
        return Response.json({
          token: GITHUB_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/installation/repositories");
      expect(parsed.searchParams.get("per_page")).toBe("8");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${GITHUB_TOKEN}`);
      const page = Number(parsed.searchParams.get("page"));
      const count = page === 1 ? 8 : 3;
      return Response.json({
        total_count: 11,
        repositories: Array.from({ length: count }, (_, index) => ({
          id: index,
          full_name: `acme/repo-${String(page)}-${String(index)}`,
          private: index % 2 === 0,
          description: "unrelated fields must not leak through",
        })),
      });
    });

    // Reading the list is an active-member act, not an admin one.
    const response = await appRequest(app, "/connections/github/repositories", {
      headers: { Cookie: member.cookie },
    });

    expect(response.status).toBe(200);
    const { repositories } = await response.json<ListGithubRepositoriesResponse>();
    expect(repositories).toHaveLength(11);
    expect(repositories[0]).toEqual({ fullName: "acme/repo-1-0", private: true });
    expect(repositories.at(-1)).toEqual({ fullName: "acme/repo-2-2", private: true });
    // One token mint, then exactly two pages: the short second page ends it.
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(repositories)).not.toContain("unrelated fields");
  });

  it("caps the repo listing at 200 entries instead of paging forever", async () => {
    const { privatePem } = await githubKeyPair();
    const { app } = harness();
    const cookie = await operatorSession(app);
    expect((await putGithubConnection(app, cookie, privatePem)).status).toBe(204);

    let pageRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/access_tokens")) {
        return Response.json({
          token: GITHUB_TOKEN,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      pageRequests += 1;
      return Response.json({
        total_count: 10_000,
        repositories: Array.from({ length: 8 }, (_, index) => ({
          full_name: `acme/repo-${String(pageRequests)}-${String(index)}`,
          private: false,
        })),
      });
    });

    const response = await appRequest(app, "/connections/github/repositories", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    const { repositories } = await response.json<ListGithubRepositoriesResponse>();
    expect(repositories).toHaveLength(200);
    expect(pageRequests).toBe(25);
  });

  it("stores a static connection and fills inject placement templates at mint", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      scopes: ["servers:read"],
      placements: [
        { kind: "env", name: "HCLOUD_TOKEN" },
        { kind: "file", path: "/run/credentials/hcloud", mode: 0o600 },
        { kind: "file", path: "/run/credentials/default" },
        { kind: "unset-env", name: "OLD_HCLOUD_TOKEN" },
      ],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: ["servers:read"] },
    });

    const response = await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });

    expect(response.status).toBe(200);
    const result = await response.json<MintResult>();
    expect(result.mode).toBe("inject");
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(result.placements).toEqual([
      { kind: "env", name: "HCLOUD_TOKEN", value: ROOT },
      {
        kind: "file",
        path: "/run/credentials/hcloud",
        mode: 0o600,
        value: ROOT,
      },
      { kind: "file", path: "/run/credentials/default", value: ROOT },
      { kind: "unset-env", name: "OLD_HCLOUD_TOKEN" },
    ]);
    const explicitMode = result.placements[1];
    expect(Object.keys(explicitMode ?? {})).toEqual(["kind", "path", "value", "mode"]);
    expect(explicitMode && "mode" in explicitMode).toBe(true);
    expect(JSON.stringify(explicitMode)).toBe(
      `{"kind":"file","path":"/run/credentials/hcloud","value":"${ROOT}","mode":384}`,
    );
    const omittedMode = result.placements[2];
    expect(Object.keys(omittedMode ?? {})).toEqual(["kind", "path", "value"]);
    expect(omittedMode && "mode" in omittedMode).toBe(false);
    expect(JSON.stringify(omittedMode)).toBe(
      `{"kind":"file","path":"/run/credentials/default","value":"${ROOT}"}`,
    );
    const stored = await env.DB
      .prepare("SELECT config, root_ciphertext FROM connections WHERE scoped_name = ?1")
      .bind("hetzner-prod")
      .first<{ config: string; root_ciphertext: string }>();
    expect(stored?.root_ciphertext).not.toBe(ROOT);
    expect(stored?.config).not.toContain(ROOT);
    expect(
      await env.DB
        .prepare("SELECT user_id FROM credential_leases WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<string>("user_id"),
    ).toBe("operator");
    const mintEvent = await env.DB
      .prepare("SELECT detail FROM credential_events WHERE event = 'minted' ORDER BY id DESC LIMIT 1")
      .first<string>("detail");
    expect(JSON.parse(mintEvent ?? "null")).toMatchObject({
      workspace_id: workspace.id,
      acting_principal: { userId: "operator", membershipId: "personal" },
    });
  });

  it("mints a default-custody proxy token and streams a header-swapped call", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "static-proxy");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "static-proxy": {},
    });

    const minted = await mintFor(app, workspace.id, box.access_token, {
      integration: "static-proxy",
    });

    expect(minted.status).toBe(200);
    const result = await minted.json<MintResult>();
    const handle = proxyHandle(result);
    expect(result).toMatchObject({ integration: "static-proxy", mode: "proxy" });
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    expect(handle.proxyUrl).toBe(`https://cp.example/proxy/${handle.leaseId}`);
    expect(handle.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const storedLease = await env.DB
      .prepare(
        `SELECT lease.token_hash, connection.custody
         FROM credential_leases lease
         JOIN connections connection ON connection.id = lease.connection_id
         WHERE lease.id = ?1`,
      )
      .bind(handle.leaseId)
      .first<{ token_hash: string; custody: string }>();
    expect(storedLease?.custody).toBe("proxy");
    expect(storedLease?.token_hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(storedLease?.token_hash).not.toContain(handle.token);

    let upstreamBody = "";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe(
          "https://vendor.example/api/v1/messages?stream=true&limit=2",
        );
        expect(init?.method).toBe("POST");
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${ROOT}`);
        expect(headers.get("authorization")).not.toContain(handle.token);
        upstreamBody = await new Response(init?.body).text();
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("vendor-"));
              controller.enqueue(encoder.encode("stream"));
              controller.close();
            },
          }),
          {
            status: 201,
            headers: { "x-vendor-response": "streamed" },
          },
        );
      },
    );

    const proxied = await appRequest(
      app,
      `/proxy/${handle.leaseId}/v1/messages?stream=true&limit=2`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          "Content-Type": "application/octet-stream",
        },
        body: "request-stream",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(upstreamBody).toBe("request-stream");
    expect(proxied.status).toBe(201);
    expect(proxied.headers.get("x-vendor-response")).toBe("streamed");
    expect(await proxied.text()).toBe("vendor-stream");
  });

  it("uses a configured x-api-key header with an empty prefix in both directions", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "x-key-proxy", {
      baseUrl: "https://keys.example",
      tokenHeader: "x-api-key",
      tokenPrefix: "",
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "x-key-proxy": {},
    });
    const minted = await mintFor(app, workspace.id, box.access_token, {
      integration: "x-key-proxy",
    });
    const handle = proxyHandle(await minted.json<MintResult>());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe("https://keys.example/v2/check?raw=1");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe(ROOT);
        expect(headers.get("authorization")).toBeNull();
        return new Response("x-key-ok");
      },
    );

    const response = await appRequest(
      app,
      `/proxy/${handle.leaseId}/v2/check?raw=1`,
      { headers: { "x-api-key": handle.token } },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("x-key-ok");
  });

  it("never accepts a proxy lease token from the URL path or query", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "url-reject-proxy");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "url-reject-proxy": {},
    });
    const minted = await mintFor(app, workspace.id, box.access_token, {
      integration: "url-reject-proxy",
    });
    const handle = proxyHandle(await minted.json<MintResult>());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("must not be reached"),
    );

    const pathToken = await appRequest(
      app,
      `/proxy/${handle.leaseId}/${handle.token}/v1?also=${handle.token}`,
      { headers: { Authorization: `Bearer ${handle.token}` } },
    );
    const queryToken = await appRequest(
      app,
      `/proxy/${handle.leaseId}/v1?token=${handle.token}`,
      { headers: { Authorization: `Bearer ${handle.token}` } },
    );

    expect(pathToken.status).toBe(401);
    expect(queryToken.status).toBe(401);
    // The refusal names itself. Every one of these used to be a byte-identical
    // empty 401, so an agent that put the token in the query string read the
    // same nothing as an agent holding an expired lease.
    expect(pathToken.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expect(pathToken.json()).resolves.toMatchObject({
      error: { code: "token_in_url" },
    });
    await expect(queryToken.json()).resolves.toMatchObject({
      error: { code: "token_in_url" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tells missing, unknown, mistyped, and mis-pathed apart", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "named-401-proxy");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "named-401-proxy": {},
    });
    const minted = await mintFor(app, workspace.id, box.access_token, {
      integration: "named-401-proxy",
    });
    const handle = proxyHandle(await minted.json<MintResult>());
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("must not be reached"),
    );

    const code = async (response: Response): Promise<string> => {
      const body = await response.json<{ error: { code: string } }>();
      return body.error.code;
    };

    const missing = await appRequest(app, `/proxy/${handle.leaseId}/v1`);
    expect(missing.status).toBe(401);
    expect(await code(missing)).toBe("missing_bearer");

    const unknown = await appRequest(app, "/proxy/00000000-0000-4000-8000-000000000000/v1", {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(await code(unknown)).toBe("unknown_lease");

    const wrongToken = await appRequest(app, `/proxy/${handle.leaseId}/v1`, {
      headers: { Authorization: `Bearer ${"z".repeat(43)}` },
    });
    expect(await code(wrongToken)).toBe("bad_token");

    // A lease id the router decodes to a real row but whose raw path the
    // upstream builder cannot line up: percent-encoding the first character
    // is the only way the two disagree, and it is exactly the case the path
    // guard exists for.
    const encodedId = `%${handle.leaseId.charCodeAt(0).toString(16)}${handle.leaseId.slice(1)}`;
    const badPath = await appRequest(app, `/proxy/${encodedId}/v1`, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(await code(badPath)).toBe("bad_proxy_path");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names a revoked lease and an expired one differently in the 401 body", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putProxyConnection(app, cookie, "dead-proxy");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "dead-proxy": {},
    });
    const firstMint = await mintFor(app, workspace.id, box.access_token, {
      integration: "dead-proxy",
    });
    const revoked = proxyHandle(await firstMint.json<MintResult>());
    expect(
      (
        await appRequest(app, `/leases/${revoked.leaseId}`, {
          method: "DELETE",
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases WHERE id = ?1")
        .bind(revoked.leaseId)
        .first(),
    ).toEqual({ state: "revoked", token_hash: null });

    const secondMint = await mintFor(app, workspace.id, box.access_token, {
      integration: "dead-proxy",
    });
    const expired = proxyHandle(await secondMint.json<MintResult>());
    await env.DB
      .prepare("UPDATE credential_leases SET expires_at = ?1 WHERE id = ?2")
      .bind(Date.now() - 1, expired.leaseId)
      .run();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("must not be reached"),
    );

    const revokedResponse = await appRequest(
      app,
      `/proxy/${revoked.leaseId}/v1`,
      { headers: { Authorization: `Bearer ${revoked.token}` } },
    );
    const expiredResponse = await appRequest(
      app,
      `/proxy/${expired.leaseId}/v1`,
      { headers: { Authorization: `Bearer ${expired.token}` } },
    );

    expect(revokedResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
    expect(revokedResponse.headers.get("WWW-Authenticate")).toBe("Bearer");
    await expect(revokedResponse.json()).resolves.toMatchObject({
      error: { code: "lease_revoked" },
    });
    // The expired body names the one command that repairs it, because the
    // agent that reads it is the one that has to act.
    const expiredBody = await expiredResponse.json<{ error: { code: string; message: string } }>();
    expect(expiredBody.error.code).toBe("lease_expired");
    expect(expiredBody.error.message).toContain("blitz-cred sync");
    // Still value-free: no token, no upstream secret, no vendor detail.
    expect(JSON.stringify(expiredBody)).not.toContain(expired.token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies a mint outside the manifest and allow-list and writes a value-free event", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      scopes: ["servers:read"],
      owners: ["operator"],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: ["servers:read"] },
    });

    const response = await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:write"],
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "credential mint exceeds the workspace manifest or integration allow-list",
      request_id: expect.any(String),
    });
    const event = await env.DB
      .prepare(
        "SELECT lease_id, event, detail FROM credential_events ORDER BY id DESC LIMIT 1",
      )
      .first<{ lease_id: string | null; event: string; detail: string }>();
    expect(event?.lease_id).toBeNull();
    expect(event?.event).toBe("denied");
    expect(event?.detail).not.toContain(ROOT);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_leases")
        .first<number>("count"),
    ).toBe(0);
  });

  it("deduplicates denied mints, lists the request shape, and approves an actual retry", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      scopes: ["servers:read"],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: [] },
    });

    const firstDenied = await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:read"],
    });
    const secondDenied = await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:read"],
    });
    const firstBody = await firstDenied.json<{ request_id: string }>();
    const secondBody = await secondDenied.json<{ request_id: string }>();

    expect(firstDenied.status).toBe(403);
    expect(secondDenied.status).toBe(403);
    expect(secondBody.request_id).toBe(firstBody.request_id);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_requests")
        .first<number>("count"),
    ).toBe(1);

    const listed = await appRequest(app, "/requests", {
      headers: { Cookie: cookie },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      requests: [
        {
          id: firstBody.request_id,
          workspace_id: workspace.id,
          connection_name: "hetzner-prod",
          requested_scopes: ["servers:read"],
          requester: { boxId: box.box_id, userId: "operator" },
          created_at: expect.any(Number),
        },
      ],
    });

    const approved = await appRequest(
      app,
      `/requests/${firstBody.request_id}/approve`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    expect(approved.status).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, resolved_by FROM credential_requests WHERE id = ?1")
        .bind(firstBody.request_id)
        .first(),
    ).toEqual({ state: "approved", resolved_by: "operator" });
    const storedManifest = await env.DB
      .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<string>("manifest");
    expect(JSON.parse(storedManifest ?? "null")).toEqual({
      integrations: { "hetzner-prod": { scopes: ["servers:read"] } },
    });
    const event = await env.DB
      .prepare(
        "SELECT lease_id, event, detail FROM credential_events WHERE event = 'approved'",
      )
      .first<{ lease_id: string | null; event: string; detail: string }>();
    expect(event).toMatchObject({ lease_id: null, event: "approved" });
    expect(JSON.parse(event?.detail ?? "null")).toEqual({
      integration: "hetzner-prod",
      scopes: ["servers:read"],
      workspace_id: workspace.id,
      resolved_by: "operator",
      acting_principal: { userId: "operator", membershipId: "personal" },
    });

    const retried = await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:read"],
    });
    expect(retried.status).toBe(200);
    expect(await retried.json<MintResult>()).toMatchObject({
      integration: "hetzner-prod",
      mode: "inject",
      placements: [{ kind: "env", name: "HCLOUD_TOKEN", value: ROOT }],
    });
  });

  it("denies a pending request without widening the workspace manifest", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": { scopes: [] },
    });
    const deniedMint = await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:write"],
    });
    const { request_id: requestId } = await deniedMint.json<{ request_id: string }>();
    const before = await env.DB
      .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspace.id)
      .first<string>("manifest");

    const denied = await appRequest(app, `/requests/${requestId}/deny`, {
      method: "POST",
      headers: { Cookie: cookie },
    });

    expect(denied.status).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, resolved_by FROM credential_requests WHERE id = ?1")
        .bind(requestId)
        .first(),
    ).toEqual({ state: "denied", resolved_by: "operator" });
    expect(
      await env.DB
        .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
        .bind(workspace.id)
        .first<string>("manifest"),
    ).toBe(before);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_events WHERE event = 'approved'")
        .first<number>("count"),
    ).toBe(0);
    const events = await appRequest(app, `/workspaces/${workspace.id}/credential-events`, {
      headers: { Cookie: cookie },
    });
    expect(events.status).toBe(200);
    await expect(events.json()).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          leaseId: null,
          event: "denied",
          detail: expect.objectContaining({
            workspace_id: workspace.id,
            resolution: "denied",
            acting_principal: { userId: "operator", membershipId: "personal" },
          }),
        }),
      ]),
    });
    expect(
      (await mintFor(app, workspace.id, box.access_token, {
        integration: "hetzner-prod",
        scopes: ["servers:write"],
      })).status,
    ).toBe(403);
  });

  it("does not let a non-owner approve another workspace's request", async () => {
    const { app, providers } = harness();
    const operatorCookie = await operatorSession(app);
    const ownerCookie = await userSession("workspace-owner");
    const strangerCookie = await userSession("stranger");
    await putStaticConnection(app, operatorCookie, "hetzner-prod", {
      owners: ["workspace-owner"],
    });
    const { workspace, box } = await createReadyWorkspace(
      app,
      providers,
      ownerCookie,
      { "hetzner-prod": { scopes: [] } },
    );
    const deniedMint = await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
      scopes: ["servers:write"],
    });
    const { request_id: requestId } = await deniedMint.json<{ request_id: string }>();

    const response = await appRequest(app, `/requests/${requestId}/approve`, {
      method: "POST",
      headers: { Cookie: strangerCookie },
    });

    expect(response.status).toBe(404);
    expect(
      await env.DB
        .prepare("SELECT state FROM credential_requests WHERE id = ?1")
        .bind(requestId)
        .first<string>("state"),
    ).toBe("pending");
    const strangerFeed = await appRequest(app, "/requests?state=pending", {
      headers: { Cookie: strangerCookie },
    });
    expect(await strangerFeed.json()).toEqual({ requests: [] });
  });

  it("files and deduplicates requests for explicitly named missing connections", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {});

    const first = await mintFor(app, workspace.id, box.access_token, {
      integration: "future-provider",
      scopes: ["repo:read"],
    });
    const second = await mintFor(app, workspace.id, box.access_token, {
      integration: "future-provider",
      scopes: ["repo:read"],
    });
    const firstBody = await first.json<{ error: string; request_id: string }>();
    const secondBody = await second.json<{ error: string; request_id: string }>();

    expect(first.status).toBe(404);
    expect(firstBody).toEqual({
      error: "integration not found",
      request_id: expect.any(String),
    });
    expect(secondBody.request_id).toBe(firstBody.request_id);
    expect(
      await env.DB
        .prepare(
          `SELECT connection_name, requested_scopes, state
           FROM credential_requests WHERE id = ?1`,
        )
        .bind(firstBody.request_id)
        .first(),
    ).toEqual({
      connection_name: "future-provider",
      requested_scopes: '["repo:read"]',
      state: "pending",
    });
  });

  it("revokes a lease by clearing its token hash in the same state update", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    expect(
      (await mintFor(app, workspace.id, box.access_token, {
        integration: "hetzner-prod",
      })).status,
    ).toBe(200);
    const lease = await env.DB
      .prepare("SELECT id FROM credential_leases LIMIT 1")
      .first<{ id: string }>();
    if (lease === null) throw new Error("mint did not create a lease");
    await env.DB
      .prepare("UPDATE credential_leases SET token_hash = 'test-proxy-hash' WHERE id = ?1")
      .bind(lease.id)
      .run();

    const response = await appRequest(app, `/leases/${lease.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(204);
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases WHERE id = ?1")
        .bind(lease.id)
        .first(),
    ).toEqual({ state: "revoked", token_hash: null });
  });

  it("destroys a workspace with an active lease while preserving revoked audit", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    expect(
      (await mintFor(app, workspace.id, box.access_token, {
        integration: "hetzner-prod",
      })).status,
    ).toBe(200);

    const response = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM boxes WHERE workspace_id = ?1")
        .bind(workspace.id)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM box_token_families WHERE box_id = ?1")
        .bind(box.box_id)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB
        .prepare(
          "SELECT box_id, state FROM credential_leases WHERE workspace_id = ?1",
        )
        .bind(workspace.id)
        .first(),
    ).toEqual({ box_id: null, state: "revoked" });
  });

  it("expires overdue active leases without deleting their audit rows", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });
    await env.DB
      .prepare(
        "UPDATE credential_leases SET expires_at = 10, token_hash = 'overdue-token-hash'",
      )
      .run();

    expect(await runLeaseSweep(testRuntime(providers), 11)).toBe(1);
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases")
        .first(),
    ).toEqual({ state: "expired", token_hash: null });
    expect(
      await env.DB
        .prepare("SELECT COUNT(*) AS count FROM credential_leases")
        .first<number>("count"),
    ).toBe(1);
  });

  it("returns an array when a sync-style request mints every allowed connection", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod", {
      placements: [{ kind: "env", name: "HCLOUD_TOKEN" }],
    });
    await putStaticConnection(app, cookie, "resend-prod", {
      root: "test-only-resend-root",
      placements: [{ kind: "env", name: "RESEND_API_KEY" }],
    });
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": {},
      "resend-prod": {},
    });

    void workspace;
    const response = await mintFor(app, "self", box.access_token, {});

    expect(response.status).toBe(200);
    const result = await response.json<MintResult[]>();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result.map(({ integration, placements }) => [integration, placements[0]])).toEqual([
      ["hetzner-prod", { kind: "env", name: "HCLOUD_TOKEN", value: ROOT }],
      ["resend-prod", { kind: "env", name: "RESEND_API_KEY", value: "test-only-resend-root" }],
    ]);
  });

  it("lists connection status without config, plaintext values, or ciphertext", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");

    const response = await appRequest(app, "/connections", {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ connections: ConnectionView[] }>();
    expect(body).toEqual({
      connections: [
        {
          name: "hetzner-prod",
          provider: "hetzner",
          kind: "static",
          custody: "cp",
          status: "active",
          createdBy: "operator",
          proxyBaseUrl: null,
          // A boolean about the sealed root, never the root itself.
          orgCredential: true,
        },
      ],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(ROOT);
    expect(serialized).not.toContain("root_ciphertext");
    expect(serialized).not.toContain("config");
    expect(serialized).not.toContain('"value"');
  });

  it("deletes a connection as a soft kill switch and revokes its active leases", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });

    const response = await appRequest(app, "/connections/hetzner-prod", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(204);
    expect(
      await env.DB
        .prepare(
          "SELECT revoked_at IS NOT NULL AS revoked, root_ciphertext FROM connections WHERE scoped_name = ?1",
        )
        .bind("hetzner-prod")
        .first(),
    ).toEqual({ revoked: 1, root_ciphertext: null });
    expect(
      await env.DB
        .prepare("SELECT state, token_hash FROM credential_leases")
        .first(),
    ).toEqual({ state: "revoked", token_hash: null });
  });

  it("lists minted leases through the session-authenticated audit route", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { workspace, box } = await createReadyWorkspace(app, providers, cookie);
    await mintFor(app, workspace.id, box.access_token, {
      integration: "hetzner-prod",
    });

    const response = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: cookie },
    });
    const body = await response.json<{ leases: CredentialLeaseView[] }>();

    expect(response.status).toBe(200);
    expect(body.leases).toHaveLength(1);
    expect(body.leases[0]).toMatchObject({
      workspaceId: workspace.id,
      boxId: box.box_id,
      connection: "hetzner-prod",
      state: "active",
      mode: "inject",
    });
    expect(JSON.stringify(body)).not.toContain(ROOT);
  });

  /** FROZEN box wire: the Go broker baked into the shipped box image decodes
   * POST /workspaces/self/credentials with DisallowUnknownFields. This pins
   * the request body key "integration" and the exact response key set
   * integration/mode/placements/expiresAt so the connection rename can never
   * leak into the box-facing route. */
  it("keeps the frozen box mint wire: body key integration, exact response keys", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    await putStaticConnection(app, cookie, "hetzner-prod");
    const { box } = await createReadyWorkspace(app, providers, cookie, {
      "hetzner-prod": {},
    });

    const response = await mintFor(app, "self", box.access_token, {
      integration: "hetzner-prod",
    });

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
    expect((raw as MintResult).integration).toBe("hetzner-prod");
    const placement = (raw as MintResult).placements[0];
    expect(placement).toEqual({ kind: "env", name: "HCLOUD_TOKEN", value: ROOT });
    expect(Object.keys(placement ?? {})).toEqual(["kind", "name", "value"]);
  });

  it("keeps /integrations as an alias of the canonical /connections routes", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);

    const put = await appRequest(app, "/integrations/alias-token", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "hetzner",
        kind: "static",
        custody: "cp",
        root: ROOT,
        config: { placements: [{ kind: "env", name: "HCLOUD_TOKEN" }] },
      }),
    });
    expect(put.status).toBe(204);

    const aliasList = await appRequest(app, "/integrations", {
      headers: { Cookie: cookie },
    });
    const canonicalList = await appRequest(app, "/connections", {
      headers: { Cookie: cookie },
    });
    expect(aliasList.status).toBe(200);
    const canonicalBody = await canonicalList.json();
    await expect(aliasList.json()).resolves.toEqual(canonicalBody);
    expect(canonicalBody).toMatchObject({
      connections: [{ name: "alias-token", status: "active" }],
    });

    const remove = await appRequest(app, "/integrations/alias-token", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(remove.status).toBe(204);
  });
});

/** The template path for the two new providers. Discord is admin-configured:
 * one bot token stored by an admin reaches every workspace with no per-user
 * step, like the github app root. YouTrack is per-member PAT (product ruling:
 * "youtrack is just PAT"): each member pastes their own permanent token,
 * proxied so it never lands on a box disk, with the instance URL inherited
 * from the org connection row once anyone has named it. */
describe("connections: admin-configured providers through templates", () => {
  const YOUTRACK_PAT = "perm:test-only-youtrack-permanent-token";
  const YOUTRACK_BASE = "https://acme.youtrack.example";
  const DISCORD_ROOT = "test-only-discord-bot-token";

  beforeEach(async () => {
    await resetDatabase();
    testConnectSecrets.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function pasteYoutrack(
    app: Harness["app"],
    cookie: string,
    token: string,
    baseUrl?: string,
  ): Promise<Response> {
    return appRequest(app, "/connections/grants/youtrack", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        manifestId: "youtrack",
        token,
        ...(baseUrl === undefined ? {} : { vendor: { baseUrl } }),
      }),
    });
  }

  async function putDiscordConnection(
    app: Harness["app"],
    cookie: string,
  ): Promise<void> {
    const response = await appRequest(app, "/connections/discord", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "discord",
        kind: "static",
        custody: "cp",
        root: DISCORD_ROOT,
        config: { placements: [{ kind: "env", name: "DISCORD_BOT_TOKEN" }] },
      }),
    });
    expect(response.status).toBe(204);
  }

  async function templateNaming(
    app: Harness["app"],
    cookie: string,
    connections: { provider: string }[],
  ): Promise<WorkspaceTemplateView> {
    const created = await appRequest(app, "/workspace-templates", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ops",
        machineTypeId: "small",
        folderIds: [],
        connections,
      }),
    });
    expect(created.status).toBe(201);
    const { template } = await created.json<{ template: WorkspaceTemplateView }>();
    return template;
  }

  async function workspaceCeiling(workspaceId: string): Promise<unknown> {
    const row = await env.DB
      .prepare("SELECT manifest FROM workspaces WHERE id = ?1")
      .bind(workspaceId)
      .first<{ manifest: string | null }>();
    return JSON.parse(row?.manifest ?? "null");
  }

  it("serves youtrack as a per-member paste and discord as admin-configured", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const listed = await appRequest(app, "/connections/catalog", {
      headers: { Cookie: cookie },
    });
    expect(listed.status).toBe(200);
    const { providers } = await listed.json<ListCatalogResponse>();

    const youtrack = providers.find(({ id }) => id === "youtrack");
    expect(youtrack).toMatchObject({
      custody: "proxy",
      oauthAvailable: false,
      personalTokenLabel: "Permanent token",
      // The paste form's extra field: instance-hosted vendors name their URL.
      personalTokenBaseUrlLabel: "Instance URL",
      adminForm: null,
    });
    const discord = providers.find(({ id }) => id === "discord");
    expect(discord).toMatchObject({
      custody: "cp",
      oauthAvailable: false,
      personalTokenLabel: null,
      personalTokenBaseUrlLabel: null,
      adminForm: {
        rootLabel: "Bot token",
        // The <PROVIDER>_TOKEN alias rides beside the vendor's own name: an
        // agent guessing a variable guesses that shape first, and guessing
        // wrong reads as "not connected".
        placements: [
          { kind: "env", name: "DISCORD_BOT_TOKEN", fill: "token" },
          { kind: "env", name: "DISCORD_TOKEN", fill: "token" },
        ],
      },
    });

    // Discord stays admin-only: the grants route refuses a pasted key, so no
    // member can end up holding a parallel bot credential.
    const pasted = await appRequest(app, "/connections/grants/discord", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ manifestId: "discord", token: "test-only-pasted" }),
    });
    expect(pasted.status).toBe(400);
    await expect(pasted.json()).resolves.toMatchObject({
      error: expect.stringContaining("issues no personal token"),
    });

    // A youtrack paste is accepted — but only once it can resolve somewhere:
    // with no org row yet, the instance URL must ride along.
    const urlless = await pasteYoutrack(app, cookie, YOUTRACK_PAT);
    expect(urlless.status).toBe(400);
    await expect(urlless.json()).resolves.toMatchObject({
      error: expect.stringContaining("instance URL"),
    });
    expect((await pasteYoutrack(app, cookie, YOUTRACK_PAT, YOUTRACK_BASE)).status).toBe(204);

    // The declared row now shows the org's instance URL — the value later
    // members' paste forms prefill and lock — and nothing else of the config.
    const rows = await appRequest(app, "/connections", { headers: { Cookie: cookie } });
    const { connections } = await rows.json<{ connections: ConnectionView[] }>();
    expect(connections).toEqual([{
      name: "youtrack",
      provider: "youtrack",
      kind: "static",
      custody: "proxy",
      status: "active",
      createdBy: "operator",
      proxyBaseUrl: YOUTRACK_BASE,
      // A member-declared row carries no root: it is a declaration, not an
      // org credential, and the admin surfaces must not read it as one.
      orgCredential: false,
    }]);
  });

  it("github: the app root satisfies a template connection and mints the git-helper shape", async () => {
    const { privatePem } = await githubKeyPair();
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    expect((await putGithubConnection(app, admin, privatePem)).status).toBe(204);
    const template = await templateNaming(app, admin, [
      { provider: "github" },
    ]);

    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        expect(String(input)).toBe(
          "https://api.github.com/app/installations/987654/access_tokens",
        );
        return Response.json({ token: GITHUB_TOKEN, expires_at: expiresAt });
      },
    );

    // The creator is a plain member with no grant of any kind: the admin's
    // app root is what makes the lease go live.
    const member = await sameOrgSession("github-template-member");
    const { workspace, box } = await readyWorkspace(app, providers, member.cookie, {
      templateId: template.id,
    });
    expect(await workspaceCeiling(workspace.id)).toEqual({
      integrations: { github: {} },
    });

    // The create minted the lease before any box existed; the live lease row
    // is the state the panel shows.
    const atCreate = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: member.cookie },
    });
    const { leases: created } = await atCreate.json<{ leases: CredentialLeaseView[] }>();
    expect(created.map(({ connection, state, boxId }) => [connection, state, boxId]))
      .toEqual([["github", "active", null]]);

    // The same mint blitz-cred git-helper performs: {integration: "github"},
    // answered with an env placement named GH_TOKEN — the exact name the
    // helper turns into git's username/password pair.
    const minted = await mint(app, box.access_token, { integration: "github" });
    expect(minted.status).toBe(200);
    const result = await minted.json<MintResult>();
    expect(result).toEqual({
      integration: "github",
      mode: "inject",
      placements: [
        { kind: "env", name: "GH_TOKEN", value: GITHUB_TOKEN },
        { kind: "env", name: "GITHUB_TOKEN", value: GITHUB_TOKEN },
      ],
      expiresAt: Date.parse(expiresAt),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("youtrack: a member's pasted token satisfies the template and rides the proxy as them", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const template = await templateNaming(app, admin, [
      { provider: "youtrack" },
    ]);

    // Pasting the token — with the instance URL, being the org's first — is
    // the one member step; it also declares the org connection row.
    const member = await sameOrgSession("youtrack-pat-member");
    expect((await pasteYoutrack(app, member.cookie, YOUTRACK_PAT, YOUTRACK_BASE)).status)
      .toBe(204);
    const { workspace, box } = await readyWorkspace(app, providers, member.cookie, {
      templateId: template.id,
    });
    expect(await workspaceCeiling(workspace.id)).toEqual({
      integrations: { youtrack: {} },
    });

    const synced = await mint(app, box.access_token, {});
    expect(synced.status).toBe(200);
    const results = await synced.json<MintResult[]>();
    expect(results.map(({ integration, mode }) => [integration, mode]))
      .toEqual([["youtrack", "proxy"]]);
    const result = results[0];
    if (result === undefined) throw new Error("youtrack mint result is missing");

    // The box holds a lease token and the proxy URL, never the permanent
    // token: that pair is the whole delivery.
    const leaseToken = environmentValue(result, "YOUTRACK_TOKEN");
    const proxyUrl = environmentValue(result, "YOUTRACK_BASE_URL");
    expect(leaseToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(leaseToken).not.toBe(YOUTRACK_PAT);
    const leaseId = new URL(proxyUrl ?? "").pathname.split("/").at(-1) ?? "";
    expect(proxyUrl).toBe(`https://cp.example/proxy/${leaseId}`);
    expect(JSON.stringify(results)).not.toContain(YOUTRACK_PAT);

    // A call through the pair reaches the instance carrying the MEMBER's own
    // token: every YouTrack action attributes to the person, not to an org
    // service account.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        expect(String(input)).toBe(
          `${YOUTRACK_BASE}/api/issues?fields=idReadable`,
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${YOUTRACK_PAT}`);
        return Response.json([{ idReadable: "OPS-1" }]);
      },
    );
    const proxied = await appRequest(
      app,
      `/proxy/${leaseId}/api/issues?fields=idReadable`,
      { headers: { Authorization: `Bearer ${leaseToken ?? ""}` } },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(proxied.status).toBe(200);
    await expect(proxied.json()).resolves.toEqual([{ idReadable: "OPS-1" }]);

    // No admin-root fallback exists: a second member without a grant still
    // creates — creation never blocks — but nothing mints until they paste
    // their own token. The panel shows youtrack as needs-you meanwhile.
    const stranger = await sameOrgSession("youtrack-strangers");
    const bare = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: stranger.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: template.id }),
    });
    expect(bare.status).toBe(201);
    const { workspace: unbacked } = await bare.json<{ workspace: WorkspaceView }>();
    expect(unbacked.connections).toEqual(["youtrack"]);
    const empty = await appRequest(app, `/workspaces/${unbacked.id}/leases`, {
      headers: { Cookie: stranger.cookie },
    });
    const { leases: nothing } = await empty.json<{ leases: CredentialLeaseView[] }>();
    expect(nothing).toEqual([]);
  });

  /** The proxy-chain regression: a grant that names no URL must resolve
   * through the org row's instance URL, never the catalog placeholder. */
  it("youtrack: a later member inherits the org row's instance URL through the proxy", async () => {
    const { app, providers } = harness();
    const first = await operatorSession(app);
    expect((await pasteYoutrack(app, first, "perm:first-members-token", YOUTRACK_BASE)).status)
      .toBe(204);

    // The second member pastes only their token: the row already knows the
    // instance, so the URL is not asked for again.
    const second = await sameOrgSession("youtrack-second-member");
    const SECOND_PAT = "perm:second-members-token";
    expect((await pasteYoutrack(app, second.cookie, SECOND_PAT)).status).toBe(204);

    const { box } = await readyWorkspace(app, providers, second.cookie, {
      connections: ["youtrack"],
    });
    const synced = await mint(app, box.access_token, { integration: "youtrack" });
    expect(synced.status).toBe(200);
    const result = await synced.json<MintResult>();
    const leaseToken = environmentValue(result, "YOUTRACK_TOKEN");
    const proxyUrl = environmentValue(result, "YOUTRACK_BASE_URL");
    const leaseId = new URL(proxyUrl ?? "").pathname.split("/").at(-1) ?? "";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input, init) => {
        // The row's URL, not https://youtrack.invalid — and the second
        // member's own token, not the first member's.
        expect(String(input)).toBe(`${YOUTRACK_BASE}/api/users/me?fields=id,login`);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${SECOND_PAT}`);
        return Response.json({ id: "1-2", login: "second" });
      },
    );
    const proxied = await appRequest(
      app,
      `/proxy/${leaseId}/api/users/me?fields=id,login`,
      { headers: { Authorization: `Bearer ${leaseToken ?? ""}` } },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(proxied.status).toBe(200);
    await expect(proxied.json()).resolves.toEqual({ id: "1-2", login: "second" });
  });

  it("discord: the admin cp root reaches a template workspace as the bot token itself", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    await putDiscordConnection(app, admin);
    const template = await templateNaming(app, admin, [
      { provider: "discord" },
    ]);

    const member = await sameOrgSession("discord-template-member");
    const { workspace, box } = await readyWorkspace(app, providers, member.cookie, {
      templateId: template.id,
    });
    expect(await workspaceCeiling(workspace.id)).toEqual({
      integrations: { discord: {} },
    });
    const atCreate = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: member.cookie },
    });
    const { leases: created } = await atCreate.json<{ leases: CredentialLeaseView[] }>();
    expect(created.map(({ connection, state, boxId }) => [connection, state, boxId]))
      .toEqual([["discord", "active", null]]);

    const minted = await mint(app, box.access_token, { integration: "discord" });
    expect(minted.status).toBe(200);
    const result = await minted.json<MintResult>();
    expect(result).toMatchObject({
      integration: "discord",
      mode: "inject",
      placements: [
        { kind: "env", name: "DISCORD_BOT_TOKEN", value: DISCORD_ROOT },
      ],
    });
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
    // The frozen box wire: exactly the four keys the shipped broker decodes.
    expect(Object.keys(result).sort()).toEqual([
      "expiresAt",
      "integration",
      "mode",
      "placements",
    ]);

    // Enablement is a ceiling, not a broadcast: a workspace whose explicit
    // manifest names nothing gets nothing on a sync-all.
    const { box: fencedBox } = await createReadyWorkspace(app, providers, admin, {});
    const fencedSync = await mint(app, fencedBox.access_token, {});
    expect(fencedSync.status).toBe(200);
    await expect(fencedSync.json()).resolves.toEqual([]);
  });

  it("creates an unbacked stipulated provider as needs-you, never as a 409", async () => {
    const { app } = harness();
    const admin = await operatorSession(app);
    const template = await templateNaming(app, admin, [
      { provider: "youtrack" },
    ]);
    const member = await sameOrgSession("blocked-template-member");
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: template.id }),
    });
    // Creation never blocks on connections: no admin root and no grant means
    // the provider reads as needs-you in the panel, and the first in-box mint
    // files the connect request. The ceiling still names it.
    expect(created.status).toBe(201);
    const { workspace } = await created.json<{ workspace: WorkspaceView }>();
    expect(workspace.connections).toEqual(["youtrack"]);
    const leases = await appRequest(app, `/workspaces/${workspace.id}/leases`, {
      headers: { Cookie: member.cookie },
    });
    await expect(leases.json<{ leases: CredentialLeaseView[] }>())
      .resolves.toEqual({ leases: [] });
  });
});
