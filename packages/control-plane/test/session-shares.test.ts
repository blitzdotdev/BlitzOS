import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { CreateVmInput, WebAppPort } from "../core/compute/types.js";
import type { ListSessionSharesResponse, SessionShareView } from "../core/wire.js";
import {
  BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,
  BOX_IMAGE_TICKETS_SINCE_MS,
  BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
  WorkspaceWebAppAuth,
} from "../core/webapp-tickets.js";
import {
  FakeProviders,
  appRequest,
  appWithProviders,
  createWorkspace,
  operatorSession,
  resetDatabase,
  sameOrgSession,
} from "./helpers.js";

/**
 * PHASE 6 (plans/LODY-SHARING.md) — the control plane's half of session
 * sharing: the rows, the authority rules, the target-member proxy route, and
 * the ticket claim minted from them.
 *
 * The relay's own enforcement is on the box and is proven in
 * `webapp/test/lody-sharing-relay.test.ts`; what this suite decides is who is
 * ROUTED there and what claim they carry when they arrive.
 */

const SECRET = "test-webapp-root-secret";

class SharingProviders extends FakeProviders {
  readonly proxied: Array<{ path: string; credential: string }> = [];
  readonly drains: string[] = [];

  override capabilities() {
    return {
      ...super.capabilities(),
      webAppTicketsSinceMs: BOX_IMAGE_TICKETS_SINCE_MS,
      webAppViewerGuardsSinceMs: BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
      webAppSharedSessionsSinceMs: BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,
    };
  }

  override async createVm(input: CreateVmInput) {
    return super.createVm(input);
  }

  async proxyWebApp(
    _id: string,
    _port: WebAppPort,
    pathAndQuery: string,
    request: Request,
  ): Promise<Response> {
    const credential = request.headers.get("X-Blitz-WebApp-Token") ?? "";
    if (pathAndQuery === "/admin/drain") {
      const target = await request.clone().json<{ membershipId: string }>();
      this.drains.push(target.membershipId);
      return new Response(null, { status: 204 });
    }
    this.proxied.push({ path: pathAndQuery, credential });
    return new Response(null, { status: 200 });
  }
}

function json(body: unknown, method = "POST"): RequestInit {
  return { method, body: JSON.stringify(body) };
}

async function shareClaim(credential: string, workspaceId: string) {
  const verified = await new WorkspaceWebAppAuth(SECRET).verify(credential, workspaceId);
  return verified?.claims.share ?? null;
}

/** Every machine in the workspace boots an image new enough for every guard,
 * so a test that is not ABOUT the cutoffs never trips one.
 *
 * The default is the NEWEST cutoff rather than `Date.now()`, because a cutoff
 * is set to the moment an image becomes the pin and that moment can be in the
 * future of the commit that writes it — as `BOX_IMAGE_SHARED_SESSIONS_SINCE_MS`
 * is. A wall-clock default silently ages every machine to just before it and
 * turns four tests that are not about the cutoffs into 403s. */
const NEWEST_BOX_IMAGE_CUTOFF_MS = Math.max(
  BOX_IMAGE_TICKETS_SINCE_MS,
  BOX_IMAGE_VIEWER_GUARDS_SINCE_MS,
  BOX_IMAGE_SHARED_SESSIONS_SINCE_MS,
);

async function ageMachines(workspaceId: string, createdAt = NEWEST_BOX_IMAGE_CUTOFF_MS): Promise<void> {
  await env.DB.prepare("UPDATE machines SET created_at = ?1 WHERE workspace_id = ?2")
    .bind(createdAt, workspaceId).run();
}

describe("session shares", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  async function workspaceWithMember(role: "member" | "viewer" = "member") {
    const providers = new SharingProviders();
    const app = appWithProviders(providers, providers);
    const ownerCookie = await operatorSession(app);
    const other = await sameOrgSession("collaborator");
    const workspace = await createWorkspace(app, ownerCookie);
    const added = await appRequest(app, `/workspaces/${workspace.id}/members`, {
      ...json({ membershipId: other.membershipId, role }),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    expect(added.status).toBe(201);
    await ageMachines(workspace.id);
    return { providers, app, ownerCookie, other, workspace };
  }

  it("grants, re-grants at another level, and lists both halves of the screen", async () => {
    const { app, ownerCookie, other, workspace } = await workspaceWithMember();

    const granted = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: other.membershipId, level: "ro" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    expect(granted.status).toBe(201);
    const share = await granted.json<SessionShareView>();
    expect(share).toMatchObject({
      sessionId: "sess-alpha",
      granteeMembershipId: other.membershipId,
      level: "ro",
      ownerMembershipId: "personal",
    });

    // The same call at another level is an update, not a second row: the unique
    // key is (workspace, session, grantee).
    const promoted = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: other.membershipId, level: "rw" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    expect(promoted.status).toBe(200);
    expect(await promoted.json<SessionShareView>()).toMatchObject({ id: share.id, level: "rw" });

    const ownerView = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      headers: { Cookie: ownerCookie },
    });
    await expect(ownerView.json<ListSessionSharesResponse>()).resolves.toMatchObject({
      granted: [{ id: share.id, level: "rw" }],
      received: [],
    });

    const granteeView = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      headers: { Cookie: other.cookie },
    });
    await expect(granteeView.json<ListSessionSharesResponse>()).resolves.toMatchObject({
      granted: [],
      received: [{ id: share.id, level: "rw" }],
    });
  });

  it("refuses read-write to a workspace viewer, and demotes one at mint time", async () => {
    const { providers, app, ownerCookie, other, workspace } = await workspaceWithMember();

    // While they are a member, read-write is granted and minted as writable.
    expect((await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: other.membershipId, level: "rw" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    })).status).toBe(201);
    expect((await appRequest(app, `/workspaces/${workspace.id}/shared/personal/webapp/7445/lody/rpc`, {
      method: "POST",
      headers: { Cookie: other.cookie },
    })).status).toBe(200);
    await expect(shareClaim(providers.proxied.at(-1)?.credential ?? "", workspace.id)).resolves.toEqual({
      target: "personal",
      scope: "sessions",
      read: [],
      write: ["sess-alpha"],
    });

    // Demoted to viewer, the ROW survives — so a re-promotion restores it —
    // but the ticket carries the session as read-only.
    expect((await appRequest(app, `/workspaces/${workspace.id}/members/${other.membershipId}`, {
      ...json({ role: "viewer" }, "PATCH"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    })).status).toBe(200);
    await ageMachines(workspace.id);
    expect((await appRequest(app, `/workspaces/${workspace.id}/shared/personal/webapp/7445/lody/rpc`, {
      method: "POST",
      headers: { Cookie: other.cookie },
    })).status).toBe(200);
    await expect(shareClaim(providers.proxied.at(-1)?.credential ?? "", workspace.id)).resolves.toEqual({
      target: "personal",
      scope: "sessions",
      read: ["sess-alpha"],
      write: [],
    });

    // And a NEW read-write grant to a viewer is refused where the mistake was
    // made, rather than silently downgraded.
    const refused = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-beta", granteeMembershipId: other.membershipId, level: "rw" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    expect(refused.status).toBe(400);
    await expect(refused.json()).resolves.toMatchObject({
      error: "a workspace viewer may only receive read-only access",
    });
  });

  it("routes a grantee to the owner's machine and refuses everyone else", async () => {
    const { providers, app, ownerCookie, other, workspace } = await workspaceWithMember();
    const shared = `/workspaces/${workspace.id}/shared/personal/webapp/7445/lody/sync`;

    // No grant: the route is refused before any machine is touched.
    expect((await appRequest(app, shared, { headers: { Cookie: other.cookie } })).status).toBe(403);
    expect(providers.proxied).toEqual([]);

    expect((await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: other.membershipId, level: "ro" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    })).status).toBe(201);

    expect((await appRequest(app, shared, { headers: { Cookie: other.cookie } })).status).toBe(200);
    expect(providers.proxied.at(-1)?.path).toBe("/lody/sync");
    await expect(shareClaim(providers.proxied.at(-1)?.credential ?? "", workspace.id)).resolves.toEqual({
      target: "personal",
      scope: "sessions",
      read: ["sess-alpha"],
      write: [],
    });

    // One address, one meaning: your own machine is never reachable through the
    // shared prefix, even by naming yourself.
    const self = await appRequest(
      app,
      `/workspaces/${workspace.id}/shared/${other.membershipId}/webapp/7445/lody/sync`,
      { headers: { Cookie: other.cookie } },
    );
    expect(self.status).toBe(400);

    // The surface allowlist still applies: the shared prefix carries the same
    // path contract as the ordinary one.
    expect((await appRequest(
      app,
      `/workspaces/${workspace.id}/shared/personal/webapp/7445/home/.claude/.credentials.json`,
      { headers: { Cookie: other.cookie } },
    )).status).toBe(403);
  });

  it("gives a workspace admin scope:all with no grant row at all", async () => {
    const { providers, app, workspace } = await workspaceWithMember();
    const admin = await sameOrgSession("second-admin", "admin");
    const shared = `/workspaces/${workspace.id}/shared/personal/webapp/7445/lody/sync`;

    expect((await appRequest(app, shared, { headers: { Cookie: admin.cookie } })).status).toBe(200);
    await expect(shareClaim(providers.proxied.at(-1)?.credential ?? "", workspace.id)).resolves.toEqual({
      target: "personal",
      scope: "all",
      read: [],
      write: [],
    });
  });

  it("refuses the shared route on a machine whose image predates the claim", async () => {
    const { app, ownerCookie, other, workspace } = await workspaceWithMember();
    expect((await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: other.membershipId, level: "ro" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    })).status).toBe(201);
    await ageMachines(workspace.id, BOX_IMAGE_SHARED_SESSIONS_SINCE_MS - 1);

    // Fail-closed and legible: an older gateway refuses the whole ticket
    // because the claim is a field it does not know, so the refusal is made
    // here where it can name the fix.
    const refused = await appRequest(
      app,
      `/workspaces/${workspace.id}/shared/personal/webapp/7445/lody/sync`,
      { headers: { Cookie: other.cookie } },
    );
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      error: "shared sessions arrive when that member's machine is recycled",
    });
  });

  it("revokes: the next request is refused and the live connection is drained", async () => {
    const { providers, app, ownerCookie, other, workspace } = await workspaceWithMember();
    const shared = `/workspaces/${workspace.id}/shared/personal/webapp/7445/lody/sync`;

    const created = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: other.membershipId, level: "ro" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    const share = await created.json<SessionShareView>();
    const second = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-beta", granteeMembershipId: other.membershipId, level: "ro" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    });
    expect(second.status).toBe(201);
    expect((await appRequest(app, shared, { headers: { Cookie: other.cookie } })).status).toBe(200);

    // One of two grants: the connection stays, because draining would cut the
    // session they still hold.
    expect((await appRequest(app, `/workspaces/${workspace.id}/session-shares/${share.id}`, {
      method: "DELETE",
      headers: { Cookie: ownerCookie },
    })).status).toBe(204);
    expect(providers.drains).toEqual([]);
    await expect(shareClaim(
      (await appRequest(app, shared, { headers: { Cookie: other.cookie } }))
        .status === 200 ? providers.proxied.at(-1)?.credential ?? "" : "",
      workspace.id,
    )).resolves.toMatchObject({ read: ["sess-beta"] });

    // The last grant: the row goes AND the grantee's connections to that box
    // are closed.
    const remaining = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      headers: { Cookie: ownerCookie },
    }).then((response) => response.json<ListSessionSharesResponse>());
    expect((await appRequest(app, `/workspaces/${workspace.id}/session-shares/${remaining.granted[0]?.id ?? ""}`, {
      method: "DELETE",
      headers: { Cookie: ownerCookie },
    })).status).toBe(204);
    expect(providers.drains).toEqual([other.membershipId]);
    expect((await appRequest(app, shared, { headers: { Cookie: other.cookie } })).status).toBe(403);
  });

  it("lets a workspace admin grant on another member's behalf, and nobody else", async () => {
    const { app, ownerCookie, other, workspace } = await workspaceWithMember();
    const admin = await sameOrgSession("second-admin", "admin");

    // An ordinary member may not name somebody else as the owner: they would be
    // sharing a session on a box that is not theirs.
    const forged = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({
        sessionId: "sess-alpha",
        granteeMembershipId: other.membershipId,
        level: "ro",
        ownerMembershipId: "personal",
      }, "PUT"),
      headers: { Cookie: other.cookie, "Content-Type": "application/json" },
    });
    expect(forged.status).toBe(403);

    const byAdmin = await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({
        sessionId: "sess-alpha",
        granteeMembershipId: other.membershipId,
        level: "ro",
        ownerMembershipId: "personal",
      }, "PUT"),
      headers: { Cookie: admin.cookie, "Content-Type": "application/json" },
    });
    expect(byAdmin.status).toBe(201);
    await expect(byAdmin.json<SessionShareView>()).resolves.toMatchObject({
      ownerMembershipId: "personal",
      createdByMembershipId: admin.membershipId,
    });
  });

  it("refuses a grantee who is not in the workspace, and a self-share", async () => {
    const { app, ownerCookie, workspace } = await workspaceWithMember();
    const outsider = await sameOrgSession("outsider");

    expect((await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: outsider.membershipId, level: "ro" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    })).status).toBe(404);

    expect((await appRequest(app, `/workspaces/${workspace.id}/session-shares`, {
      ...json({ sessionId: "sess-alpha", granteeMembershipId: "personal", level: "ro" }, "PUT"),
      headers: { Cookie: ownerCookie, "Content-Type": "application/json" },
    })).status).toBe(400);
  });
});
