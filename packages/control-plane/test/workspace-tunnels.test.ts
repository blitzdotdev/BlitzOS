import { describe, expect, it } from "vitest";
import { rows } from "../core/db.js";
import { CloudflareTunnels } from "../core/compute/cloudflare-tunnels.js";
import { WorkspaceTunnels } from "../core/workspace-tunnels.js";
import { WorkspaceWebAppAuth } from "../core/webapp-tickets.js";
import type { MachineRow } from "../core/workspace-records.js";
import type { WorkspaceView } from "../core/wire.js";
import {
  appRequest,
  appWithVmProviders,
  FakeProviders,
  machineIdFor,
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
      "test-webapp-root-secret",
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
      body: JSON.stringify({ defaultMachineTypeId: "small" }),
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    // The tunnel is per MACHINE: a workspace holds one VM per member, and two
    // of them cannot answer on one hostname.
    const machineId = await machineIdFor(workspace.id);

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

    // The tokens-ready handshake, in the one place all three sides appear.
    // On a re-provision the volume already carries a tunnel token naming a
    // tunnel this create has just replaced, so cloudflared may not read the
    // files until THIS instance has rewritten them. The bootstrap script drops
    // the marker after mounting the volume and before the box container starts;
    // the token part writes it last, once both credentials are in place.
    const clearsMarker = userData.indexOf("rm -f /var/lib/blitz/tokens-ready");
    const startsContainer = userData.indexOf("docker run --detach");
    const writesMarker = userData.lastIndexOf("/var/lib/blitz/tokens-ready");
    expect(clearsMarker).toBeGreaterThan(-1);
    expect(startsContainer).toBeGreaterThan(-1);
    expect(clearsMarker).toBeLessThan(startsContainer);
    expect(userData.indexOf("/var/lib/blitz/tunnel-token")).toBeLessThan(writesMarker);

    const stopped = await appRequest(app, `/machines/${machineId}/stop`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(stopped.status).toBe(200);
    const started = await appRequest(app, `/machines/${machineId}/start`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(started.status).toBe(200);
    const restartedUserData = providers.userData.get(machineId) ?? "";
    expect(restartedUserData).toContain("TUNNEL-RUN-TOKEN");
    expect(restartedUserData).toContain("/var/lib/blitz/webapp-token");
    expect(restartedUserData).toContain("mv /var/lib/blitz/tokens-ready.tmp");

    const recreated = await appRequest(app, `/machines/${machineId}/recreate`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(recreated.status).toBe(200);
    const recreatedUserData = providers.userData.get(machineId) ?? "";
    expect(recreatedUserData).toContain("TUNNEL-RUN-TOKEN");
    expect(recreatedUserData).toContain("/var/lib/blitz/webapp-token");
    expect(recreatedUserData).toContain("mv /var/lib/blitz/tokens-ready.tmp");
    expect(cfCalls.filter((call) => call.endsWith("/tun-1/token"))).toHaveLength(3);
    expect(cfCalls.filter((call) => call.endsWith("/cfd_tunnel"))).toHaveLength(1);

    // 7445 is the only proxied port, and its path passes through unchanged.
    const ports = await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports?x=1`, {
      headers: { Cookie: cookie },
    });
    expect(ports.status).toBe(200);
    expect(proxied.request?.url).toBe(`https://ws-${machineId}.webapp.test/ports?x=1`);
    const credential = proxied.request?.headers.get("X-Blitz-WebApp-Token") ?? "";
    await expect(new WorkspaceWebAppAuth("test-webapp-root-secret").verify(
      credential,
      workspace.id,
    )).resolves.toMatchObject({
      kind: "ticket",
      claims: { role: "owner", userId: "operator", membershipId: "personal" },
    });
    expect(proxied.request?.headers.get("Cookie")).toBeNull();

    const destroyed = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect((await destroyed.json<{ workspace: WorkspaceView }>()).workspace.phase).toBe("destroyed");
    const row = (await rows<MachineRow>(testRuntime(providers, workspaceTunnels).db, {
      q: "SELECT * FROM machines WHERE workspace_id = ?1",
      v: [workspace.id],
    }))[0];
    expect(row?.tunnel_id).toBeNull();
    expect(row?.dns_record_id).toBeNull();
  });

  it("leaves a retained-tunnel reprovision retryable when its token fetch fails", async () => {
    let tokenRequests = 0;
    const cfFetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/cfd_tunnel")) {
        return Response.json({ success: true, result: { id: "tun-1" } });
      }
      if (url.pathname.includes("/configurations")) {
        return Response.json({ success: true, result: {} });
      }
      if (url.pathname.includes("/dns_records")) {
        return Response.json({ success: true, result: { id: "dns-1" } });
      }
      if (url.pathname.endsWith("/token")) {
        tokenRequests += 1;
        if (tokenRequests === 1) {
          return Response.json({ success: true, result: "TUNNEL-RUN-TOKEN" });
        }
        return Response.json({
          success: false,
          errors: [{ code: 1033, message: "retained tunnel token is unavailable" }],
        }, { status: 502 });
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
    );
    const providers = new FakeProviders();
    const app = appWithVmProviders([providers], providers, workspaceTunnels);
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ defaultMachineTypeId: "small" }),
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    const machineId = await machineIdFor(workspace.id);

    const recreated = await appRequest(app, `/machines/${machineId}/recreate`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(recreated.status).toBe(200);
    await expect(recreated.json<{
      machine: { state: string; error: string | null };
    }>()).resolves.toMatchObject({
      machine: {
        state: "error",
        error: expect.stringContaining(
          "Cloudflare API: 1033: retained tunnel token is unavailable",
        ),
      },
    });
    expect(tokenRequests).toBe(2);
    expect(providers.createCalls).toBe(1);
    const row = (await rows<MachineRow>(testRuntime(providers, workspaceTunnels).db, {
      q: "SELECT * FROM machines WHERE id = ?1",
      v: [machineId],
    }))[0];
    expect(row).toMatchObject({ state: "error", tunnel_id: "tun-1" });
  });

  it("stays inert without configuration", async () => {
    const providers = new FakeProviders();
    const app = appWithVmProviders([providers], providers);
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ defaultMachineTypeId: "small" }),
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    expect(providers.userData.get(workspace.id) ?? "").not.toContain("/var/lib/blitz/tunnel-token");
  });
});
