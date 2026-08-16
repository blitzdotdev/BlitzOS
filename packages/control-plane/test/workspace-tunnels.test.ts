import { describe, expect, it } from "vitest";
import { rows } from "../core/db.js";
import { CloudflareTunnels } from "../core/providers/cloudflare-tunnels.js";
import { WorkspaceTunnels } from "../core/workspace-tunnels.js";
import type { WorkspaceRow } from "../core/workspaces.js";
import type { WorkspaceView } from "../core/wire.js";
import {
  appRequest,
  appWithVmProviders,
  FakeProviders,
  operatorSession,
  testRuntime,
} from "./helpers.js";

describe("workspace tunnels", () => {
  it("provisions, proxies, and cleans up a cloud workspace tunnel end to end", async () => {
    const cfCalls: string[] = [];
    const cfFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      cfCalls.push(`${method} ${url.pathname}`);
      if (method === "DELETE") return Response.json({ success: false, errors: [] }, { status: 404 });
      if (url.pathname.endsWith("/cfd_tunnel")) return Response.json({ success: true, result: { id: "tun-1" } });
      if (url.pathname.includes("/configurations")) return Response.json({ success: true, result: {} });
      if (url.pathname.includes("/dns_records")) return Response.json({ success: true, result: { id: "dns-1" } });
      if (url.pathname.endsWith("/token")) return Response.json({ success: true, result: "TUNNEL-RUN-TOKEN" });
      return Response.json({ success: false, errors: [] }, { status: 500 });
    };
    const proxied: { request?: Request } = {};
    const workspaceTunnels = new WorkspaceTunnels(
      new CloudflareTunnels({ accountId: "test-account", zoneId: "test-zone-id", apiToken: "test-api-token", fetcher: cfFetcher }),
      "webapp.test",
      "test-webApp-secret",
      async (input, init) => {
        proxied.request = new Request(String(input), init);
        return Response.json({ ok: true });
      },
    );
    const providers = new FakeProviders();
    const app = appWithVmProviders([providers], providers, workspaceTunnels);
    const cookie = await operatorSession(app);

    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small" }),
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;

    expect(cfCalls).toEqual([
      "POST /client/v4/accounts/test-account/cfd_tunnel",
      "PUT /client/v4/accounts/test-account/cfd_tunnel/tun-1/configurations",
      "POST /client/v4/zones/test-zone-id/dns_records",
      "GET /client/v4/accounts/test-account/cfd_tunnel/tun-1/token",
    ]);
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain("TUNNEL-RUN-TOKEN");
    expect(userData.indexOf("/var/lib/blitz/webapp-token"))
      .toBeLessThan(userData.indexOf("/var/lib/blitz/tunnel-token"));

    const ports = await appRequest(app, `/workspaces/${workspace.id}/webapp/7444/session?x=1`, {
      headers: { Cookie: cookie },
    });
    expect(ports.status).toBe(200);
    expect(proxied.request?.url).toBe(`https://ws-${workspace.id}.webapp.test/acp/session?x=1`);
    expect(proxied.request?.headers.get("X-Blitz-WebApp-Token"))
      .toBe(await workspaceTunnels.webAppTokenFor(workspace.id));
    expect(proxied.request?.headers.get("Cookie")).toBeNull();

    const destroyed = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect((await destroyed.json<{ workspace: WorkspaceView }>()).workspace.phase).toBe("destroyed");
    const row = (await rows<WorkspaceRow>(testRuntime(providers, workspaceTunnels).db, {
      q: "SELECT * FROM workspaces WHERE id = ?1",
      v: [workspace.id],
    }))[0];
    expect(row?.tunnel_id).toBeNull();
    expect(row?.dns_record_id).toBeNull();
  });

  it("stays inert without configuration", async () => {
    const providers = new FakeProviders();
    const app = appWithVmProviders([providers], providers);
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small" }),
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    expect(providers.userData.get(workspace.id) ?? "").not.toContain("/var/lib/blitz/tunnel-token");
  });
});
