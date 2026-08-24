import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceSessionResponse } from "@blitzos/schema";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
} from "./helpers.js";

function workspaceDoc(
  title: string,
  sessionId: string,
  type: "claude" | "terminal" | "chat" = "claude",
) {
  return {
    version: 1,
    title,
    agentDefault: "claude",
    tabs: {
      version: 1,
      tabs: [{ id: 1, type, sessionId }],
      activeId: 1,
      nextId: 2,
    },
    drawer: { version: 1, width: 340, expanded: [] },
  } as const;
}

async function setOrgShareRole(
  workspaceId: string,
  role: "editor" | "viewer",
): Promise<void> {
  await env.DB.prepare("UPDATE workspaces SET org_share_role = ?1 WHERE id = ?2")
    .bind(role, workspaceId).run();
}

describe("workspace sessions and member views", () => {
  beforeEach(resetDatabase);

  it("keeps two members' navigation independent while they reference one shared session", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const mate = await sameOrgSession("mate");
    const workspace = await createWorkspace(app, owner);
    await setOrgShareRole(workspace.id, "editor");

    const created = await appRequest(app, `/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "claude", title: "Pairing" }),
    });
    expect(created.status).toBe(201);
    const { session } = await created.json<WorkspaceSessionResponse>();
    expect(session).toMatchObject({ kind: "claude", revision: 1, title: "Pairing" });

    const viewPath = `/workspaces/${workspace.id}/view`;
    const putView = (cookie: string, revision: number, title: string) => appRequest(app, viewPath, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ revision, doc: workspaceDoc(title, session.id) }),
    });
    expect((await putView(owner, 0, "Owner layout")).status).toBe(200);
    expect((await putView(mate.cookie, 0, "Mate layout")).status).toBe(200);

    await expect(appRequest(app, viewPath, { headers: { Cookie: owner } })
      .then((response) => response.json())).resolves.toMatchObject({
      revision: 1,
      migratedFromV1: false,
      doc: { title: "Owner layout", tabs: { tabs: [{ sessionId: session.id }] } },
      sessions: [{ id: session.id, title: "Pairing" }],
    });
    await expect(appRequest(app, viewPath, { headers: { Cookie: mate.cookie } })
      .then((response) => response.json())).resolves.toMatchObject({
      revision: 1,
      doc: { title: "Mate layout" },
    });
  });

  it("rejects a stale personal-view revision instead of silently replacing it", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const workspace = await createWorkspace(app, owner);
    const sessionResponse = await appRequest(app, `/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "terminal" }),
    });
    const { session } = await sessionResponse.json<WorkspaceSessionResponse>();
    const path = `/workspaces/${workspace.id}/view`;
    const write = (revision: number, title: string) => appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ revision, doc: workspaceDoc(title, session.id, "terminal") }),
    });

    expect((await write(0, "First")).status).toBe(200);
    await expect(write(1, "Second").then((response) => response.json()))
      .resolves.toMatchObject({ revision: 2, doc: { title: "Second" } });
    const stale = await write(1, "Stale browser");
    expect(stale.status).toBe(409);
    await expect(appRequest(app, path, { headers: { Cookie: owner } })
      .then((response) => response.json())).resolves.toMatchObject({
      revision: 2,
      doc: { title: "Second" },
    });
  });

  it("lets a viewer save a personal layout but not mutate shared sessions", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const viewer = await sameOrgSession("viewer");
    const workspace = await createWorkspace(app, owner);
    await setOrgShareRole(workspace.id, "viewer");
    const created = await appRequest(app, `/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "claude" }),
    });
    const { session } = await created.json<WorkspaceSessionResponse>();

    const view = await appRequest(app, `/workspaces/${workspace.id}/view`, {
      method: "PUT",
      headers: { Cookie: viewer.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 0, doc: workspaceDoc("Viewer layout", session.id) }),
    });
    expect(view.status).toBe(200);
    expect((await appRequest(app, `/workspaces/${workspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: viewer.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "terminal" }),
    })).status).toBe(403);
    expect((await appRequest(app, `/workspaces/${workspace.id}/sessions/${session.id}`, {
      method: "PATCH",
      headers: { Cookie: viewer.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 1, title: "Nope" }),
    })).status).toBe(403);
  });

  it("normalizes a legacy shared document once, then writes only the caller's V2 view", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const mate = await sameOrgSession("legacy-mate");
    const workspace = await createWorkspace(app, owner);
    await setOrgShareRole(workspace.id, "editor");
    const legacy = {
      version: 1,
      title: "Legacy shared",
      agentDefault: "claude",
      tabs: {
        version: 1,
        tabs: [{ id: 7, type: "claude" }],
        activeId: 7,
        nextId: 8,
      },
      drawer: { version: 1, width: 340, expanded: [] },
    } as const;
    expect((await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify(legacy),
    })).status).toBe(200);

    const path = `/workspaces/${workspace.id}/view`;
    const fallback = await appRequest(app, path, { headers: { Cookie: mate.cookie } });
    const body = await fallback.json<{
      revision: number;
      migratedFromV1: boolean;
      doc: ReturnType<typeof workspaceDoc>;
      sessions: Array<{ id: string }>;
    }>();
    expect(body).toMatchObject({ revision: 0, migratedFromV1: true });
    const legacySessionId = body.doc.tabs.tabs[0]?.sessionId;
    expect(legacySessionId).toBe(`legacy-${workspace.id}-7`);
    expect(body.sessions).toEqual([expect.objectContaining({ id: legacySessionId })]);

    const migrated = await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: mate.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 0, doc: body.doc }),
    });
    expect(migrated.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM workspace_sessions WHERE workspace_id = ?1",
      ).bind(workspace.id).first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM workspace_member_views WHERE workspace_id = ?1",
      ).bind(workspace.id).first<number>("count"),
    ).toBe(1);

    // The owner still has no personal V2 row, so their fallback remains the
    // untouched legacy document rather than the mate's personal title/layout.
    await expect(appRequest(app, path, { headers: { Cookie: owner } })
      .then((response) => response.json())).resolves.toMatchObject({
      revision: 0,
      migratedFromV1: true,
      doc: { title: "Legacy shared" },
    });

    expect((await appRequest(
      app,
      `/workspaces/${workspace.id}/sessions/${legacySessionId}`,
      { method: "DELETE", headers: { Cookie: owner, "If-Match": "1" } },
    )).status).toBe(204);
    await expect(appRequest(app, path, { headers: { Cookie: owner } })
      .then((response) => response.json())).resolves.toMatchObject({ sessions: [] });
    // Compatibility data cannot recreate an explicitly archived V2 session.
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 0, doc: body.doc }),
    })).status).toBe(400);
  });

  it("keeps session IDs workspace-bound and protects session revisions", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const firstWorkspace = await createWorkspace(app, owner);
    const secondWorkspace = await createWorkspace(app, owner);
    const created = await appRequest(app, `/workspaces/${firstWorkspace.id}/sessions`, {
      method: "POST",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "chat" }),
    });
    const { session } = await created.json<WorkspaceSessionResponse>();

    expect((await appRequest(app, `/workspaces/${secondWorkspace.id}/view`, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 0, doc: workspaceDoc("Crossed", session.id, "chat") }),
    })).status).toBe(400);

    const path = `/workspaces/${firstWorkspace.id}/sessions/${session.id}`;
    const updated = await appRequest(app, path, {
      method: "PATCH",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({
        revision: 1,
        title: "Shared chat",
        chatSessionId: "actor-session",
        chatProvider: "claude",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      session: { revision: 2, title: "Shared chat", chatSessionId: "actor-session" },
    });
    expect((await appRequest(app, path, {
      method: "PATCH",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify({ revision: 1, title: "Stale" }),
    })).status).toBe(409);
  });
});
