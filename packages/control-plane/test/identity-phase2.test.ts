import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceView } from "@blitzos/schema";
import { hashSecret, randomToken } from "../core/crypto.js";
import { INVITE_TTL_MS, inviteCodeHash } from "../core/identity/invites.js";
import type { CreateVmInput, WebAppPort } from "../core/providers/types.js";
import {
  BOX_IMAGE_TICKETS_SINCE_MS,
  BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
  WorkspaceWebAppAuth,
} from "../core/webapp-tickets.js";
import {
  FakeProviders,
  appRequest,
  appWithProviders,
  createWorkspace,
  harness,
  operatorSession,
  sameOrgSession,
  resetDatabase,
  userSession,
} from "./helpers.js";

function json(body: object): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function oauthCookie(setCookie: string): string {
  const match = setCookie.match(/blitz_google_oauth=([^;]+)/u);
  if (match?.[1] === undefined) throw new Error("OAuth cookie missing");
  return `blitz_google_oauth=${match[1]}`;
}

async function googleCallback(
  app: ReturnType<typeof harness>["app"],
  email: string,
  startPath = "/auth/google/start",
  emailVerified = true,
): Promise<Response> {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ access_token: "google-token" }))
    .mockResolvedValueOnce(Response.json({
      sub: `sub-${email}`,
      email,
      email_verified: emailVerified,
      name: `Google ${email}`,
      picture: "https://images.example/avatar.png",
    }));
  const start = await appRequest(app, startPath);
  const location = new URL(start.headers.get("location") ?? "");
  return appRequest(
    app,
    `/auth/google/callback?code=code&state=${encodeURIComponent(location.searchParams.get("state") ?? "")}`,
    { headers: { Cookie: oauthCookie(start.headers.get("set-cookie") ?? "") } },
  );
}

class ProxyProviders extends FakeProviders {
  readonly proxyCalls: Array<{ port: WebAppPort; path: string }> = [];
  readonly drainTargets: Array<{ port: WebAppPort; membershipId: string; credential: string }> = [];
  readonly webAppCredentials: string[] = [];
  drainStatus = 204;

  override capabilities() {
    // The real box-image cutoff, so an aged workspace exercises the
    // static-token path while fresh ones get tickets.
    return {
      ...super.capabilities(),
      webAppActorBypassesGateway: true,
      webAppTicketsSinceMs: BOX_IMAGE_TICKETS_SINCE_MS,
      webAppViewerGuardsSinceMs: BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
    };
  }

  override async createVm(input: CreateVmInput) {
    return super.createVm(input);
  }

  async proxyWebApp(
    _id: string,
    port: WebAppPort,
    pathAndQuery: string,
    request: Request,
  ): Promise<Response> {
    this.proxyCalls.push({ port, path: pathAndQuery });
    if (pathAndQuery === "/admin/drain") {
      const target = await request.clone().json<{ membershipId: string }>();
      this.drainTargets.push({
        port,
        membershipId: target.membershipId,
        credential: request.headers.get("X-Blitz-WebApp-Token") ?? "",
      });
    } else {
      this.webAppCredentials.push(request.headers.get("X-Blitz-WebApp-Token") ?? "");
    }
    return new Response(null, { status: pathAndQuery === "/admin/drain" ? this.drainStatus : 200 });
  }
}

describe("identity phase 2", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetDatabase();
  });

  it("lists only org workspaces with roles and owner data, and applies 404/403 detail errors", async () => {
    const { app } = harness();
    const ownerCookie = await operatorSession(app);
    const member = await sameOrgSession("editor");
    const outsiderCookie = await userSession("outsider");
    const workspace = await createWorkspace(app, ownerCookie);

    const metadata = await appRequest(app, "/workspaces", { headers: { Cookie: member.cookie } });
    const metadataBody = await metadata.json<{ workspaces: WorkspaceView[] }>();
    expect(metadataBody.workspaces).toEqual([
      expect.objectContaining({
        id: workspace.id,
        role: null,
        owner: { name: "Operator", avatarUrl: null },
        canObserve: false,
        launchable: false,
        ssh: null,
      }),
    ]);
    expect((await appRequest(app, `/workspaces/${workspace.id}`, { headers: { Cookie: member.cookie } })).status).toBe(403);
    expect((await appRequest(app, `/workspaces/${workspace.id}`, { headers: { Cookie: outsiderCookie } })).status).toBe(404);
    const refresh = await appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: member.cookie, Accept: "text/html,application/xhtml+xml" },
    });
    expect(refresh.headers.get("content-type")).toContain("text/html");
    expect(await refresh.text()).toContain("webapp shell");
    await appRequest(app, `/workspaces/${workspace.id}/grants`, {
      ...json({ membershipId: member.membershipId, role: "editor" }),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    const detail = await appRequest(app, `/workspaces/${workspace.id}`, { headers: { Cookie: member.cookie } });
    await expect(detail.json()).resolves.toMatchObject({ workspace: { role: "editor" } });
    await expect(appRequest(app, "/workspaces", { headers: { Cookie: outsiderCookie } }).then((response) => response.json())).resolves.toEqual({ workspaces: [] });
  });

  it("grants viewers and editors, authorizes the proxy, forbids destroy, and drains best-effort", async () => {
    const providers = new ProxyProviders();
    const app = appWithProviders(providers, providers);
    const ownerCookie = await operatorSession(app);
    const editor = await sameOrgSession("collaborator");
    const workspace = await createWorkspace(app, ownerCookie);
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, { headers: { Cookie: editor.cookie } })).status).toBe(403);
    const viewer = await appRequest(app, `/workspaces/${workspace.id}/grants`, {
      ...json({ membershipId: editor.membershipId, role: "viewer" }),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    expect(viewer.status).toBe(201);
    // A viewer reaches the files port with a role-carrying ticket once the VM
    // boots a guest that enforces read-only; the agent port stays closed.
    await env.DB.prepare("UPDATE workspaces SET created_at = ?1 WHERE id = ?2")
      .bind(BOX_IMAGE_VIEWER_GUARDS_SINCE_MS, workspace.id).run();
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, { headers: { Cookie: editor.cookie } })).status).toBe(200);
    await expect(new WorkspaceWebAppAuth("test-webapp-root-secret").verify(
      providers.webAppCredentials.at(-1) ?? "",
      workspace.id,
    )).resolves.toMatchObject({
      kind: "ticket",
      claims: { role: "viewer", userId: "collaborator", membershipId: editor.membershipId },
    });
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7444`, { headers: { Cookie: editor.cookie } })).status).toBe(403);

    // A VM from before the guarded image refuses viewers outright.
    await env.DB.prepare("UPDATE workspaces SET created_at = ?1 WHERE id = ?2")
      .bind(BOX_IMAGE_VIEWER_GUARDS_SINCE_MS - 1, workspace.id).run();
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, { headers: { Cookie: editor.cookie } })).status).toBe(403);
    await env.DB.prepare("UPDATE workspaces SET created_at = ?1 WHERE id = ?2")
      .bind(Date.now(), workspace.id).run();
    const created = await appRequest(app, `/workspaces/${workspace.id}/grants`, {
      ...json({ membershipId: editor.membershipId, role: "editor" }),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    const grant = await created.json<{ grant: { id: string } }>();
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, { headers: { Cookie: editor.cookie } })).status).toBe(200);
    await expect(new WorkspaceWebAppAuth("test-webapp-root-secret").verify(
      providers.webAppCredentials.at(-1) ?? "",
      workspace.id,
    )).resolves.toMatchObject({
      kind: "ticket",
      claims: { role: "editor", userId: "collaborator", membershipId: editor.membershipId },
    });
    expect((await appRequest(app, `/workspaces/${workspace.id}`, { method: "DELETE", headers: { Cookie: editor.cookie } })).status).toBe(403);

    providers.drainStatus = 503;
    const revoked = await appRequest(app, `/workspaces/${workspace.id}/grants/${grant.grant.id}`, {
      method: "DELETE",
      headers: { Cookie: ownerCookie },
    });
    expect(revoked.status).toBe(204);
    await vi.waitFor(() => {
      expect(providers.proxyCalls).toContainEqual({ port: 7445, path: "/admin/drain" });
      expect(providers.proxyCalls).toContainEqual({ port: 7444, path: "/admin/drain" });
      expect(providers.drainTargets).toEqual([
        { port: 7445, membershipId: editor.membershipId, credential: expect.any(String) },
        { port: 7444, membershipId: editor.membershipId, credential: expect.any(String) },
      ]);
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM workspace_grants").first<number>("count")).toBe(0);
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, { headers: { Cookie: editor.cookie } })).status).toBe(403);
  });

  it("keeps the static token and viewer refusal for pre-ticket VMs", async () => {
    const providers = new ProxyProviders();
    const app = appWithProviders(providers, providers);
    const ownerCookie = await operatorSession(app);
    const member = await sameOrgSession("colleague");
    const workspace = await createWorkspace(app, ownerCookie);
    // Age the workspace to before the 20260817a pin: its VM never upgrades,
    // so its gateway only byte-compares the static token.
    await env.DB.prepare("UPDATE workspaces SET created_at = 1786900000000 WHERE id = ?1")
      .bind(workspace.id).run();

    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, { headers: { Cookie: ownerCookie } })).status).toBe(200);
    await expect(new WorkspaceWebAppAuth("test-webapp-root-secret").verify(
      providers.webAppCredentials.at(-1) ?? "",
      workspace.id,
    )).resolves.toMatchObject({ kind: "static" });

    await appRequest(app, `/workspaces/${workspace.id}/grants`, {
      ...json({ membershipId: member.membershipId, role: "viewer" }),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp/7445/ports`, { headers: { Cookie: member.cookie } })).status).toBe(403);
  });

  it("proxies only browser surfaces, refusing the agent HOME and the drain switch", async () => {
    const providers = new ProxyProviders();
    const app = appWithProviders(providers, providers);
    const ownerCookie = await operatorSession(app);
    const workspace = await createWorkspace(app, ownerCookie);
    const proxy = (path: string, method = "GET") => appRequest(
      app,
      `/workspaces/${workspace.id}/webapp/${path}`,
      { method, headers: { Cookie: ownerCookie } },
    );

    // dufs serves /srv/blitz-files, where the agent's HOME sits beside
    // /workspace: reaching it would hand over the agent's OAuth credentials.
    expect((await proxy("7445/home/.claude/.credentials.json")).status).toBe(403);
    expect((await proxy("7445/home/")).status).toBe(403);
    // Traversal, raw and percent-encoded, must not climb out of /workspace.
    expect((await proxy("7445/workspace/%2e%2e/home/.claude.json")).status).toBe(403);
    // Both the gateway and the actor answer /admin/drain for any ticket.
    expect((await proxy("7445/admin/drain", "POST")).status).toBe(403);
    expect((await proxy("7444/admin/drain", "POST")).status).toBe(403);
    // The gateway's /acp is a second door to the agent on the files port.
    expect((await proxy("7445/acp")).status).toBe(403);

    for (const allowed of [
      "7445/workspace/",
      "7445/workspace/notes.md",
      "7445/ports",
      "7445/previews",
      "7445/preview/3000/",
      "7445/terminal/ws",
      "7444",
    ]) {
      expect((await proxy(allowed)).status, allowed).toBe(200);
    }
  });

  it("lists real memberships only and keeps last-active-admin protection", async () => {
    const { app } = harness();
    const adminCookie = await operatorSession(app);
    expect((await appRequest(app, "/members", {
      ...json({ email: "Claim@Example.com", role: "member" }),
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    })).status).toBe(404);
    await expect(appRequest(app, "/members", {
      headers: { Cookie: adminCookie },
    }).then((response) => response.json())).resolves.toEqual({
      members: [{
        id: "personal",
        email: "operator@example.com",
        name: "Operator",
        avatarUrl: null,
        role: "admin",
        status: "active",
      }],
    });
    expect((await appRequest(app, "/members/personal", {
      method: "PATCH",
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    })).status).toBe(409);
    expect((await appRequest(app, "/members/personal", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    })).status).toBe(404);
  });

  it("mints a lowercased email-pinned invite and redeems it atomically for a matching verified login", async () => {
    const { app } = harness();
    const adminCookie = await operatorSession(app);
    const before = Date.now();
    const created = await appRequest(app, "/invites", {
      ...json({ email: "Invitee@Example.com", role: "member" }),
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    });
    const body = await created.json<{
      code: string;
      invite: { id: string; email: string; expiresAt: number };
      ttlDays: number;
    }>();
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body.invite.email).toBe("invitee@example.com");
    expect(body.ttlDays).toBe(7);
    expect(body.invite.expiresAt).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    const stored = await env.DB.prepare("SELECT code_hash FROM invites WHERE id = ?1").bind(body.invite.id).first<string>("code_hash");
    expect(stored).toBe(await inviteCodeHash(body.code));
    expect(stored).not.toBe(body.code);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM users").first<number>("count")).toBe(1);
    await expect(appRequest(app, `/invite/${body.code}`).then((response) => response.json())).resolves.toMatchObject({
      invite: { email: "invitee@example.com", role: "member", state: "ready" },
    });
    await expect(appRequest(app, "/invites", {
      headers: { Cookie: adminCookie },
    }).then((response) => response.json())).resolves.toMatchObject({
      invites: [expect.objectContaining({ email: "invitee@example.com", state: "ready" })],
    });
    await expect(appRequest(app, "/members", {
      headers: { Cookie: adminCookie },
    }).then((response) => response.json())).resolves.toMatchObject({ members: [{ id: "personal" }] });

    const callback = await googleCallback(app, "invitee@example.com", `/auth/google/start?invite=${body.code}`);
    expect(callback.status).toBe(302);
    expect(await env.DB.prepare("SELECT state FROM invites WHERE id = ?1").bind(body.invite.id).first<string>("state")).toBe("redeemed");
    expect(await env.DB.prepare(
      `SELECT m.org_id FROM sessions s JOIN memberships m ON m.id = s.membership_id
       WHERE s.principal_id = (SELECT id FROM users WHERE email = 'invitee@example.com')
       ORDER BY s.created_at DESC LIMIT 1`,
    ).first<string>("org_id")).toBe("personal");
    expect(await env.DB.prepare(
      `SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE u.email = 'invitee@example.com' AND m.org_id = 'personal'`,
    ).first<string>("role")).toBe("member");
  });

  it("refuses a mismatched verified email and leaves the pinned invite ready", async () => {
    const { app } = harness();
    const adminCookie = await operatorSession(app);
    const created = await appRequest(app, "/invites", {
      ...json({ email: "pinned@example.com", role: "admin" }),
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    });
    const body = await created.json<{ code: string; invite: { id: string } }>();
    const callback = await googleCallback(
      app,
      "wrong@example.com",
      `/auth/google/start?invite=${body.code}`,
    );
    expect(callback.status).toBe(403);
    await expect(callback.json()).resolves.toEqual({
      error: "invite is for a different email address",
      retryAction: null,
    });
    await expect(appRequest(app, `/invite/${body.code}`).then((response) => response.json())).resolves.toMatchObject({
      invite: { email: "pinned@example.com", role: "admin", state: "ready" },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM memberships WHERE user_id = (SELECT id FROM users WHERE email = 'wrong@example.com')",
    ).first<number>("count")).toBe(0);
  });

  it("refuses an unverified email and leaves the pinned invite ready", async () => {
    const { app } = harness();
    const adminCookie = await operatorSession(app);
    const created = await appRequest(app, "/invites", {
      ...json({ email: "pinned@example.com", role: "member" }),
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    });
    const body = await created.json<{ code: string }>();
    const callback = await googleCallback(
      app,
      "pinned@example.com",
      `/auth/google/start?invite=${body.code}`,
      false,
    );
    expect(callback.status).toBe(401);
    await expect(callback.json()).resolves.toEqual({
      error: "Google email is not verified",
      retryAction: null,
    });
    await expect(appRequest(app, `/invite/${body.code}`).then((response) => response.json())).resolves.toMatchObject({
      invite: { email: "pinned@example.com", state: "ready" },
    });
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE email = 'pinned@example.com'",
    ).first<number>("count")).toBe(0);
  });

  it("keeps open invites redeemable by any verified Google email and revocable while ready", async () => {
    const { app } = harness();
    const adminCookie = await operatorSession(app);
    const open = await appRequest(app, "/invites", {
      ...json({ role: "member" }),
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    });
    const openBody = await open.json<{ code: string; invite: { id: string } }>();
    await expect(appRequest(app, `/invite/${openBody.code}`).then((response) => response.json())).resolves.toMatchObject({
      invite: { email: null, state: "ready" },
    });
    expect((await googleCallback(
      app,
      "anyone@example.com",
      `/auth/google/start?invite=${openBody.code}`,
    )).status).toBe(302);
    expect(await env.DB.prepare("SELECT state FROM invites WHERE id = ?1").bind(openBody.invite.id).first<string>("state")).toBe("redeemed");

    const second = await appRequest(app, "/invites", {
      ...json({ role: "member" }),
      headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    });
    const secondBody = await second.json<{ code: string; invite: { id: string } }>();
    expect((await appRequest(app, `/invites/${secondBody.invite.id}`, { method: "DELETE", headers: { Cookie: adminCookie } })).status).toBe(204);
    await expect(appRequest(app, `/invite/${secondBody.code}`).then((response) => response.json())).resolves.toMatchObject({ invite: { state: "revoked" } });
  });

  it("switches sessions among active memberships and scopes volumes and connections", async () => {
    const { app, providers } = harness();
    const operatorCookie = await operatorSession(app);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO orgs (id, slug, name, vm_limit, created_at, updated_at) VALUES ('second', 'second', 'Second', 2, ?1, ?1)").bind(now),
      env.DB.prepare("INSERT INTO memberships (id, user_id, org_id, role, status) VALUES ('second-admin', 'operator', 'second', 'admin', 'active')"),
    ]);
    expect((await appRequest(app, "/sessions/switch-org", {
      ...json({ orgId: "second" }),
      headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
    })).status).toBe(204);
    await expect(appRequest(app, "/me", { headers: { Cookie: operatorCookie } }).then((response) => response.json())).resolves.toMatchObject({ org: { id: "second" }, organizations: expect.arrayContaining([expect.objectContaining({ org: expect.objectContaining({ id: "personal" }) })]) });

    const secondVolume = await appRequest(app, "/volumes", {
      ...json({ name: "second-data", sizeGb: 10, location: "test" }),
      headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
    });
    const secondVolumeId = (await secondVolume.json<{ volume: { id: string } }>()).volume.id;
    expect(providers.volumes.has(secondVolumeId)).toBe(true);
    await appRequest(app, "/sessions/switch-org", {
      ...json({ orgId: "personal" }),
      headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
    });
    await expect(appRequest(app, "/volumes", { headers: { Cookie: operatorCookie } }).then((response) => response.json())).resolves.toEqual({ volumes: [] });
    expect((await appRequest(app, `/volumes/${secondVolumeId}`, { method: "DELETE", headers: { Cookie: operatorCookie } })).status).toBe(404);

    const configured = await appRequest(app, "/connections/team-token", {
      method: "PUT",
      headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "hetzner", kind: "static", custody: "cp", config: { placements: [] }, root: "secret" }),
    });
    expect(configured.status).toBe(204);
    await appRequest(app, "/sessions/switch-org", {
      ...json({ orgId: "second" }),
      headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
    });
    await expect(appRequest(app, "/connections", { headers: { Cookie: operatorCookie } }).then((response) => response.json())).resolves.toEqual({ connections: [] });
    expect((await appRequest(app, "/connections/team-token", { method: "DELETE", headers: { Cookie: operatorCookie } })).status).toBe(404);
    expect((await appRequest(app, "/connections/team-token", {
      method: "PUT",
      headers: { Cookie: operatorCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "hetzner", kind: "static", custody: "cp", config: { placements: [] }, root: "second-secret" }),
    })).status).toBe(204);
    await expect(appRequest(app, "/connections", { headers: { Cookie: operatorCookie } }).then((response) => response.json())).resolves.toMatchObject({
      connections: [{ name: "team-token", createdBy: "operator" }],
    });
  });
});
