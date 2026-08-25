import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  PresenceSnapshotResponse,
  PutPresenceConnectionRequest,
  WorkspaceSessionResponse,
} from "@blitzos/schema";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
  userSession,
} from "./helpers.js";

async function putPresence(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  clientId: string,
  input: PutPresenceConnectionRequest,
): Promise<Response> {
  return appRequest(app, `/presence/connections/${clientId}`, {
    method: "PUT",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function getPresence(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
): Promise<PresenceSnapshotResponse> {
  const response = await appRequest(app, "/presence", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  return response.json<PresenceSnapshotResponse>();
}

function organizationPresence(
  visible: boolean,
  focused = false,
): PutPresenceConnectionRequest {
  return { workspaceId: null, surfaces: [], focusedSurface: null, visible, focused };
}

describe("organization presence", () => {
  beforeEach(resetDatabase);

  it("aggregates multiple clients into active, online, and away member states", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const mate = await sameOrgSession("mate");
    const workspace = await createWorkspace(app, owner);
    await env.DB.prepare("UPDATE workspaces SET org_share_role = 'editor' WHERE id = ?1")
      .bind(workspace.id).run();
    const created = await appRequest(app, `/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "terminal", title: "Pairing shell" }),
    });
    const { session } = await created.json<WorkspaceSessionResponse>();

    expect((await putPresence(app, owner, "owner-workspace", {
      workspaceId: workspace.id,
      surfaces: [{ kind: "session", sessionId: session.id }],
      focusedSurface: 0,
      visible: true,
      focused: true,
    })).status).toBe(204);
    expect((await putPresence(app, owner, "owner-drive", organizationPresence(false))).status).toBe(204);
    expect((await putPresence(app, mate.cookie, "mate-workspace", {
      workspaceId: workspace.id,
      surfaces: [{ kind: "file", surfaceId: "tab-4", label: "README.md" }],
      focusedSurface: 0,
      visible: true,
      focused: false,
    })).status).toBe(204);

    const first = await getPresence(app, owner);
    expect(first.expiresAfterMs).toBe(35_000);
    expect(first.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ membershipId: "personal", state: "active" }),
      expect.objectContaining({ membershipId: mate.membershipId, state: "online" }),
    ]));
    expect(first.members.find(({ membershipId }) => membershipId === "personal")?.activities)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          location: "workspace",
          workspaceId: workspace.id,
          surfaces: [{
            kind: "session",
            sessionId: session.id,
            sessionKind: "terminal",
            title: "Pairing shell",
          }],
        }),
        expect.objectContaining({ location: "organization" }),
      ]));

    await putPresence(app, owner, "owner-workspace", {
      workspaceId: workspace.id,
      surfaces: [{ kind: "session", sessionId: session.id }],
      focusedSurface: 0,
      visible: true,
      focused: false,
    });
    expect((await getPresence(app, owner)).members
      .find(({ membershipId }) => membershipId === "personal")?.state).toBe("online");
    await putPresence(app, owner, "owner-workspace", {
      workspaceId: workspace.id,
      surfaces: [{ kind: "session", sessionId: session.id }],
      focusedSurface: 0,
      visible: false,
      focused: false,
    });
    expect((await getPresence(app, owner)).members
      .find(({ membershipId }) => membershipId === "personal")?.state).toBe("away");

    expect((await appRequest(app, "/presence/connections/owner-workspace", {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    expect((await appRequest(app, "/presence/connections/owner-drive", {
      method: "DELETE",
      headers: { Cookie: owner },
    })).status).toBe(204);
    expect((await getPresence(app, mate.cookie)).members
      .some(({ membershipId }) => membershipId === "personal")).toBe(false);
  });

  it("redacts inaccessible workspace activity and coalesces its connection count", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const mate = await sameOrgSession("redacted-mate");
    const outsider = await userSession("outsider");
    const workspace = await createWorkspace(app, owner);
    const created = await appRequest(app, `/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "claude", title: "Secret pairing" }),
    });
    const { session } = await created.json<WorkspaceSessionResponse>();
    const report: PutPresenceConnectionRequest = {
      workspaceId: workspace.id,
      surfaces: [{ kind: "session", sessionId: session.id }],
      focusedSurface: 0,
      visible: true,
      focused: true,
    };
    await putPresence(app, owner, "private-one", report);
    await putPresence(app, owner, "private-two", { ...report, focused: false });

    const redacted = await getPresence(app, mate.cookie);
    const ownerView = redacted.members.find(({ membershipId }) => membershipId === "personal");
    expect(ownerView?.activities).toEqual([expect.objectContaining({ location: "other-workspace" })]);
    const serialized = JSON.stringify(ownerView);
    expect(serialized).not.toContain(workspace.id);
    expect(serialized).not.toContain(session.id);
    expect(serialized).not.toContain("Secret pairing");
    expect((await getPresence(app, outsider)).members).toEqual([]);

    await env.DB.prepare(
      `INSERT INTO workspace_grants
       (id, workspace_id, membership_id, role, granted_by_membership_id, created_at)
       VALUES ('mate-grant', ?1, ?2, 'viewer', 'personal', ?3)`,
    ).bind(workspace.id, mate.membershipId, Date.now()).run();
    const authorized = await getPresence(app, mate.cookie);
    expect(authorized.members.find(({ membershipId }) => membershipId === "personal")?.activities)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          location: "workspace",
          workspaceId: workspace.id,
          surfaces: [expect.objectContaining({ sessionId: session.id })],
        }),
      ]));
  });

  it("validates workspace access, normalized sessions, labels, and strict request keys", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const mate = await sameOrgSession("validator");
    const firstWorkspace = await createWorkspace(app, owner);
    const secondWorkspace = await createWorkspace(app, owner);
    expect((await putPresence(app, mate.cookie, "private-workspace", {
      workspaceId: firstWorkspace.id,
      surfaces: [],
      focusedSurface: null,
      visible: true,
      focused: false,
    })).status).toBe(403);
    await env.DB.prepare("UPDATE workspaces SET org_share_role = 'viewer' WHERE id IN (?1, ?2)")
      .bind(firstWorkspace.id, secondWorkspace.id).run();
    const created = await appRequest(app, `/workspaces/${firstWorkspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "terminal" }),
    });
    const { session } = await created.json<WorkspaceSessionResponse>();

    expect((await putPresence(app, mate.cookie, "crossed", {
      workspaceId: secondWorkspace.id,
      surfaces: [{ kind: "session", sessionId: session.id }],
      focusedSurface: 0,
      visible: true,
      focused: false,
    })).status).toBe(400);
    expect((await putPresence(app, mate.cookie, "bad-label", {
      workspaceId: firstWorkspace.id,
      surfaces: [{ kind: "file", surfaceId: "tab-1", label: "/workspace/.env" }],
      focusedSurface: 0,
      visible: true,
      focused: false,
    })).status).toBe(400);
    expect((await putPresence(app, mate.cookie, "hidden-focus", {
      workspaceId: firstWorkspace.id,
      surfaces: [],
      focusedSurface: null,
      visible: false,
      focused: true,
    })).status).toBe(400);
    expect((await appRequest(app, "/presence/connections/strict", {
      method: "PUT",
      headers: { Cookie: mate.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...organizationPresence(true), extra: "not allowed" }),
    })).status).toBe(400);
    expect((await putPresence(app, mate.cookie, "bad.client", organizationPresence(true))).status)
      .toBe(400);
    expect((await appRequest(app, "/presence/connections/oversized", {
      method: "PUT",
      headers: { Cookie: mate.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...organizationPresence(true), padding: "x".repeat(5_000) }),
    })).status).toBe(413);
  });

  it("expires leases by server time and lazily sweeps a bounded batch", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    await putPresence(app, owner, "fresh", organizationPresence(true, true));
    const expiredAt = Date.now() - 35_001;
    const statement = env.DB.prepare(
      `INSERT INTO presence_connections
       (membership_id, client_id, workspace_id, view_json, focused, visible,
        last_seen_at, created_at)
       VALUES ('personal', ?1, NULL, '{"surfaces":[],"focusedSurface":null}', 0, 0, ?2, ?2)`,
    );
    await env.DB.batch(Array.from({ length: 105 }, (_, index) => (
      statement.bind(`expired-${index}`, expiredAt)
    )));

    const first = await getPresence(app, owner);
    expect(first.members).toEqual([
      expect.objectContaining({ membershipId: "personal", state: "active" }),
    ]);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM presence_connections WHERE last_seen_at < ?1",
    ).bind(Date.now() - 35_000).first<number>("count")).toBe(5);
    await getPresence(app, owner);
    expect(await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM presence_connections WHERE last_seen_at < ?1",
    ).bind(Date.now() - 35_000).first<number>("count")).toBe(0);

    const freshAt = Date.now();
    await env.DB.batch(Array.from({ length: 200 }, (_, index) => (
      statement.bind(`active-${index}`, freshAt)
    )));
    expect((await appRequest(app, "/presence", { headers: { Cookie: owner } })).status).toBe(503);
  });

  it("stops returning a member immediately after membership disablement", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const mate = await sameOrgSession("disabled-presence");
    await putPresence(app, mate.cookie, "mate-client", organizationPresence(true, true));
    expect((await getPresence(app, owner)).members
      .some(({ membershipId }) => membershipId === mate.membershipId)).toBe(true);
    await env.DB.prepare("UPDATE memberships SET status = 'disabled' WHERE id = ?1")
      .bind(mate.membershipId).run();
    expect((await getPresence(app, owner)).members
      .some(({ membershipId }) => membershipId === mate.membershipId)).toBe(false);
    expect((await putPresence(app, mate.cookie, "mate-client", organizationPresence(true))).status)
      .toBe(401);
  });
});
