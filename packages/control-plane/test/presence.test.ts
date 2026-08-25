import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  PresenceSnapshotResponse,
  PutPresenceConnectionRequest,
  WorkspaceSessionResponse,
} from "@blitzos/schema";
import {
  MAX_CONNECTIONS_PER_MEMBERSHIP,
  MAX_SNAPSHOT_CONNECTIONS,
} from "../core/presence.js";
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
    expect(first.truncated).toBe(false);
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

  it("expires leases by server time, sweeps on writes, and truncates instead of failing", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    await putPresence(app, owner, "fresh", organizationPresence(true, true));
    const expiredAt = Date.now() - 35_001;
    const statement = env.DB.prepare(
      `INSERT INTO presence_connections
       (membership_id, client_id, workspace_id, view_json, focused, visible,
        last_seen_at, created_at)
       VALUES (?1, ?2, NULL, '{"surfaces":[],"focusedSurface":null}', 0, 0, ?3, ?3)`,
    );
    await env.DB.batch(Array.from({ length: 105 }, (_, index) => (
      statement.bind("personal", `expired-${index}`, expiredAt)
    )));
    const expiredCount = async (): Promise<number | null> => env.DB.prepare(
      "SELECT COUNT(*) AS count FROM presence_connections WHERE last_seen_at < ?1",
    ).bind(Date.now() - 35_000).first<number>("count");

    // Reads filter by the server cutoff but never write.
    const first = await getPresence(app, owner);
    expect(first.members).toEqual([
      expect.objectContaining({ membershipId: "personal", state: "active" }),
    ]);
    expect(first.truncated).toBe(false);
    expect(await expiredCount()).toBe(105);
    // Each write sweeps one bounded batch.
    await putPresence(app, owner, "fresh", organizationPresence(true, true));
    expect(await expiredCount()).toBe(5);
    await putPresence(app, owner, "fresh", organizationPresence(true, true));
    expect(await expiredCount()).toBe(0);

    // An organization past the snapshot bound still gets a snapshot: the
    // least active tail is dropped and the response says so.
    const mates = await Promise.all(Array.from({ length: 4 }, (_, index) => (
      sameOrgSession(`crowd-${index}`)
    )));
    const freshAt = Date.now();
    await env.DB.batch(mates.flatMap((mate) => (
      Array.from({ length: MAX_SNAPSHOT_CONNECTIONS / 4 }, (_, index) => (
        statement.bind(mate.membershipId, `active-${index}`, freshAt)
      ))
    )));
    const crowded = await getPresence(app, owner);
    expect(crowded.truncated).toBe(true);
    expect(crowded.members.length).toBeGreaterThan(1);
    expect(crowded.members[0]).toMatchObject({ membershipId: "personal", state: "active" });
  });

  it("caps live connections per membership by dropping the oldest", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    for (let index = 0; index < MAX_CONNECTIONS_PER_MEMBERSHIP + 4; index += 1) {
      await env.DB.prepare(
        "UPDATE presence_connections SET last_seen_at = last_seen_at - 1000 WHERE membership_id = 'personal'",
      ).run();
      expect((await putPresence(app, owner, `tab-${index}`, organizationPresence(true))).status)
        .toBe(204);
    }
    const remaining = await env.DB.prepare(
      "SELECT client_id FROM presence_connections WHERE membership_id = 'personal' ORDER BY client_id",
    ).all<{ client_id: string }>();
    expect(remaining.results).toHaveLength(MAX_CONNECTIONS_PER_MEMBERSHIP);
    expect(remaining.results.map(({ client_id }) => client_id)).not.toContain("tab-0");
    expect(remaining.results.map(({ client_id }) => client_id)).toContain(
      `tab-${MAX_CONNECTIONS_PER_MEMBERSHIP + 3}`,
    );
  });

  it("applies the shared workspace access rule per observer role", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const admin = await sameOrgSession("observer-admin", "admin");
    const member = await sameOrgSession("observer-member");
    const workspace = await createWorkspace(app, owner);
    await putPresence(app, owner, "private", {
      workspaceId: workspace.id,
      surfaces: [{ kind: "workspace" }],
      focusedSurface: 0,
      visible: true,
      focused: true,
    });
    const ownerActivity = async (cookie: string) => (await getPresence(app, cookie)).members
      .find(({ membershipId }) => membershipId === "personal")?.activities.map(({ location }) => location);

    // Owner sees their own workspace; an org admin sees every workspace in the
    // org; a plain member with neither grant nor org share sees only that the
    // owner is somewhere else.
    expect(await ownerActivity(owner)).toEqual(["workspace"]);
    expect(await ownerActivity(admin.cookie)).toEqual(["workspace"]);
    expect(await ownerActivity(member.cookie)).toEqual(["other-workspace"]);

    // A grant reveals it; revoking the grant mid-connection redacts it again
    // on the very next snapshot, without waiting for a heartbeat.
    await env.DB.prepare(
      `INSERT INTO workspace_grants
       (id, workspace_id, membership_id, role, granted_by_membership_id, created_at)
       VALUES ('member-grant', ?1, ?2, 'viewer', 'personal', ?3)`,
    ).bind(workspace.id, member.membershipId, Date.now()).run();
    expect(await ownerActivity(member.cookie)).toEqual(["workspace"]);
    await env.DB.prepare("DELETE FROM workspace_grants WHERE id = 'member-grant'").run();
    expect(await ownerActivity(member.cookie)).toEqual(["other-workspace"]);
  });

  it("degrades a stored view today's parser rejects instead of failing the snapshot", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const workspace = await createWorkspace(app, owner);
    await env.DB.prepare(
      `INSERT INTO presence_connections
       (membership_id, client_id, workspace_id, view_json, focused, visible,
        last_seen_at, created_at)
       VALUES ('personal', 'stale-schema', ?1, '{"surfaces":[{"kind":"gone"}]}', 1, 1, ?2, ?2)`,
    ).bind(workspace.id, Date.now()).run();
    const snapshot = await getPresence(app, owner);
    expect(snapshot.members.find(({ membershipId }) => membershipId === "personal")?.activities)
      .toEqual([expect.objectContaining({
        location: "workspace",
        workspaceId: workspace.id,
        surfaces: [{ kind: "workspace" }],
        focusedSurface: 0,
      })]);
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
