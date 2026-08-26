import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { CloudflareTunnels } from "../core/compute/cloudflare-tunnels.js";
import { hashSecret } from "../core/crypto.js";
import type { JsonValue } from "../core/http.js";
import { WorkspaceTunnels } from "../core/workspace-tunnels.js";
import type { WorkspaceView } from "../core/wire.js";
import {
  appRequest,
  appWithVmProviders,
  FakeProviders,
  operatorSession,
  sameOrgSession,
} from "./helpers.js";

interface MintedToken {
  id: string;
  label: string;
  token: string;
  expiresAt: number;
}

interface TokenRow {
  token_hash: string;
  last_used_at: number | null;
  revoked_at: number | null;
}

/** A control plane whose workspaces have a tunnel, so the webApp proxy has
 * somewhere to forward to and the box surfaces are actually reachable. */
function tunnelledApp(proxied: string[]) {
  const cfFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if ((init?.method ?? "GET") === "DELETE") {
      return Response.json({ success: false, errors: [] }, { status: 404 });
    }
    if (url.pathname.endsWith("/cfd_tunnel")) {
      return Response.json({ success: true, result: { id: "tun-1" } });
    }
    if (url.pathname.includes("/configurations")) return Response.json({ success: true, result: {} });
    if (url.pathname.includes("/dns_records")) {
      return Response.json({ success: true, result: { id: "dns-1" } });
    }
    if (url.pathname.endsWith("/token")) {
      return Response.json({ success: true, result: "TUNNEL-RUN-TOKEN" });
    }
    return Response.json({ success: false, errors: [] }, { status: 500 });
  };
  const workspaceTunnels = new WorkspaceTunnels(
    new CloudflareTunnels({
      accountId: "test-account",
      zoneId: "test-zone-id",
      apiToken: "test-api-token",
      fetcher: cfFetcher,
    }),
    "webapp.test",
    "test-webapp-root-secret",
    async (input) => {
      proxied.push(new URL(String(input)).pathname);
      return Response.json({ ok: true });
    },
  );
  const providers = new FakeProviders();
  return appWithVmProviders([providers], providers, workspaceTunnels);
}

type TestApp = ReturnType<typeof tunnelledApp>;

async function mint(app: TestApp, cookie: string, body: JsonValue = { label: "incident" }) {
  return appRequest(app, "/operator-tokens", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tokenRow(id: string): Promise<TokenRow> {
  const row = await env.DB.prepare(
    "SELECT token_hash, last_used_at, revoked_at FROM operator_tokens WHERE id = ?1",
  ).bind(id).first<TokenRow>();
  if (row === null) throw new Error(`operator token ${id} not found`);
  return row;
}

async function workspaceFor(app: TestApp, cookie: string): Promise<WorkspaceView> {
  const created = await appRequest(app, "/workspaces", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ machineTypeId: "small" }),
  });
  expect(created.status).toBe(201);
  return (await created.json<{ workspace: WorkspaceView }>()).workspace;
}

describe("operator tokens", () => {
  it("mints only for a platform operator and stores only the hash", async () => {
    const app = tunnelledApp([]);
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("plain-member");

    expect((await mint(app, member.cookie)).status).toBe(403);
    expect((await appRequest(app, "/operator-tokens", { method: "POST" })).status).toBe(401);

    const response = await mint(app, cookie, { label: "incident", expiresInDays: 2 });
    expect(response.status).toBe(201);
    const minted = await response.json<MintedToken>();
    expect(minted.label).toBe("incident");
    expect(minted.token.length).toBeGreaterThan(20);
    expect(minted.expiresAt).toBeGreaterThan(Date.now());

    const row = await tokenRow(minted.id);
    expect(row.token_hash).toBe(await hashSecret(minted.token));
    expect(row.token_hash).not.toBe(minted.token);
    expect(row.last_used_at).toBeNull();
  });

  it("refuses a mint the caller cannot honour", async () => {
    const app = tunnelledApp([]);
    const cookie = await operatorSession(app);
    expect((await mint(app, cookie, { label: "" })).status).toBe(400);
    expect((await mint(app, cookie, { label: "too long", expiresInDays: 31 })).status).toBe(400);
    expect((await mint(app, cookie, { label: "fractional", expiresInDays: 1.5 })).status).toBe(400);
    expect((await mint(app, cookie, "not an object")).status).toBe(400);
  });

  it("reads the workspace list, one workspace, and the box files port", async () => {
    const proxied: string[] = [];
    const app = tunnelledApp(proxied);
    const cookie = await operatorSession(app);
    const workspace = await workspaceFor(app, cookie);
    const minted = await (await mint(app, cookie)).json<MintedToken>();
    const headers = { Authorization: `Bearer ${minted.token}` };

    const list = await appRequest(app, "/workspaces", { headers });
    expect(list.status).toBe(200);
    expect((await list.json<{ workspaces: WorkspaceView[] }>()).workspaces
      .map((entry) => entry.id)).toEqual([workspace.id]);

    const one = await appRequest(app, `/workspaces/${workspace.id}`, { headers });
    expect(one.status).toBe(200);

    const surface = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, {
      headers,
    });
    expect(surface.status).toBe(200);
    expect(proxied).toEqual(["/ports"]);

    expect((await tokenRow(minted.id)).last_used_at).not.toBeNull();
  });

  it("refuses a mutation carrying a valid operator token", async () => {
    const app = tunnelledApp([]);
    const cookie = await operatorSession(app);
    const workspace = await workspaceFor(app, cookie);
    const minted = await (await mint(app, cookie)).json<MintedToken>();
    const headers = { Authorization: `Bearer ${minted.token}` };

    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small" }),
    });
    expect(created.status).toBe(403);
    expect(await created.json()).toEqual({
      error: "an operator token may only read workspaces",
      retryAction: null,
    });

    const destroyed = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers,
    });
    expect(destroyed.status).toBe(403);

    // A refused request is not a use of the credential.
    expect((await tokenRow(minted.id)).last_used_at).toBeNull();
  });

  it("refuses the agent port so an operator token cannot drive an agent", async () => {
    const proxied: string[] = [];
    const app = tunnelledApp(proxied);
    const cookie = await operatorSession(app);
    const workspace = await workspaceFor(app, cookie);
    const minted = await (await mint(app, cookie)).json<MintedToken>();
    const headers = { Authorization: `Bearer ${minted.token}` };

    // A GET the box surface list would otherwise allow: the operator token is
    // refused on port 7444 before the proxy is reached.
    const agent = await appRequest(app, `/workspaces/${workspace.id}/webapp/7444`, { headers });
    expect(agent.status).toBe(403);
    expect(proxied).toEqual([]);

    const mutatedSurface = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, {
      method: "POST",
      headers,
    });
    expect(mutatedSurface.status).toBe(403);
    expect(proxied).toEqual([]);
  });

  it("refuses a read outside the three paths it was minted for", async () => {
    const app = tunnelledApp([]);
    const cookie = await operatorSession(app);
    const workspace = await workspaceFor(app, cookie);
    const minted = await (await mint(app, cookie)).json<MintedToken>();
    const headers = { Authorization: `Bearer ${minted.token}` };

    // Both are GETs the session cookie may make. The scope is an allowlist,
    // so a route the token was not minted for stays unreachable.
    expect((await appRequest(app, "/me", { headers })).status).toBe(403);
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, { headers })).status)
      .toBe(403);
  });

  it("stops working once revoked, and revoking is platform-operator only", async () => {
    const app = tunnelledApp([]);
    const cookie = await operatorSession(app);
    const member = await sameOrgSession("revoking-member");
    const minted = await (await mint(app, cookie)).json<MintedToken>();
    const headers = { Authorization: `Bearer ${minted.token}` };
    expect((await appRequest(app, "/workspaces", { headers })).status).toBe(200);

    const refused = await appRequest(app, `/operator-tokens/${minted.id}`, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    });
    expect(refused.status).toBe(403);

    // The token cannot revoke itself either: revoking is a mutation.
    expect((await appRequest(app, `/operator-tokens/${minted.id}`, { method: "DELETE", headers }))
      .status).toBe(403);

    const revoked = await appRequest(app, `/operator-tokens/${minted.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(revoked.status).toBe(204);
    expect((await tokenRow(minted.id)).revoked_at).not.toBeNull();
    expect((await appRequest(app, "/workspaces", { headers })).status).toBe(401);

    const again = await appRequest(app, `/operator-tokens/${minted.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(again.status).toBe(404);
  });

  it("refuses an expired token and an unknown bearer", async () => {
    const app = tunnelledApp([]);
    const cookie = await operatorSession(app);
    const minted = await (await mint(app, cookie)).json<MintedToken>();
    const headers = { Authorization: `Bearer ${minted.token}` };

    expect((await appRequest(app, "/workspaces", {
      headers: { Authorization: "Bearer not-a-real-token" },
    })).status).toBe(401);

    await env.DB.prepare("UPDATE operator_tokens SET expires_at = ?2 WHERE id = ?1")
      .bind(minted.id, Date.now() - 1_000).run();
    expect((await appRequest(app, "/workspaces", { headers })).status).toBe(401);
  });

  it("stops working when the membership it was minted with is disabled", async () => {
    const app = tunnelledApp([]);
    const cookie = await operatorSession(app);
    const minted = await (await mint(app, cookie)).json<MintedToken>();
    const headers = { Authorization: `Bearer ${minted.token}` };
    expect((await appRequest(app, "/workspaces", { headers })).status).toBe(200);

    await env.DB.prepare("UPDATE memberships SET status = 'disabled' WHERE id = 'personal'").run();
    expect((await appRequest(app, "/workspaces", { headers })).status).toBe(401);
  });
});
