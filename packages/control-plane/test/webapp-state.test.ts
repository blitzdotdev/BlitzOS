import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret, randomToken } from "../core/crypto.js";
import { runOrphanSweep } from "../core/index.js";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  resetDatabase,
  testRuntime,
} from "./helpers.js";

async function sameOrgSession(id: string): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO principals (id, unix_name, harnesses) VALUES (?1, 'blitz', '[\"codex\"]')",
    ).bind(id),
    env.DB.prepare(
      `INSERT INTO users
       (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, NULL, 0, ?5, ?5)`,
    ).bind(id, `google-${id}`, `${id}@example.com`, id, now),
    env.DB.prepare(
      `INSERT INTO memberships (id, user_id, org_id, role, status)
       VALUES (?1, ?2, 'personal', 'member', 'active')`,
    ).bind(`${id}-membership`, id),
    env.DB.prepare(
      `INSERT INTO sessions (token_hash, principal_id, created_at, expires_at, membership_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(await hashSecret(token), id, now, now + 60_000, `${id}-membership`),
  ]);
  return `blitz_session=${token}`;
}

async function setOrgShareRole(workspaceId: string, role: "editor" | "viewer"): Promise<void> {
  await env.DB.prepare("UPDATE workspaces SET org_share_role = ?1 WHERE id = ?2")
    .bind(role, workspaceId).run();
}

const workspaceDoc = {
  version: 1,
  title: "Docs",
  agentDefault: "claude",
  tabs: {
    version: 1,
    tabs: [
      { id: 1, type: "terminal" },
      {
        id: 2,
        type: "chat",
        chatSessionId: "chat-session-1",
        chatProvider: "claude",
      },
    ],
    activeId: 2,
    nextId: 3,
  },
  drawer: {
    version: 1,
    open: true,
    width: 280,
    expanded: ["src"],
    segment: "files",
  },
} as const;

describe("server-side webApp state", () => {
  beforeEach(resetDatabase);

  it("stores validated global and workspace documents with last-write-wins", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const globalDoc = {
      version: 1,
      activeWorkspaceId: workspace.id,
      order: [workspace.id, "stale-workspace"],
    };

    const putGlobal = await appRequest(app, "/webapp-state", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(globalDoc),
    });
    expect(putGlobal.status).toBe(200);
    await expect(appRequest(app, "/webapp-state", {
      headers: { Cookie: cookie },
    }).then((response) => response.json())).resolves.toMatchObject({ doc: globalDoc });

    const path = `/workspaces/${workspace.id}/webapp-state`;
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    })).status).toBe(200);
    const replacement = { ...workspaceDoc, title: "Renamed" };
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(replacement),
    })).status).toBe(200);
    await expect(appRequest(app, path, {
      headers: { Cookie: cookie },
    }).then((response) => response.json())).resolves.toMatchObject({ doc: replacement });

    const invalid = await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...workspaceDoc, version: 2 }),
    });
    expect(invalid.status).toBe(400);
  });

  it("shares one workspace doc between the owner and org-wide editors", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("mate");
    const workspace = await createWorkspace(app, owner);
    await setOrgShareRole(workspace.id, "editor");
    const path = `/workspaces/${workspace.id}/webapp-state`;

    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    })).status).toBe(200);
    await expect(appRequest(app, path, {
      headers: { Cookie: member },
    }).then((response) => response.json())).resolves.toMatchObject({ doc: workspaceDoc });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replacement = { ...workspaceDoc, title: "Member view" };
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: member, "Content-Type": "application/json" },
      body: JSON.stringify(replacement),
    })).status).toBe(200);
    await expect(appRequest(app, path, {
      headers: { Cookie: owner },
    }).then((response) => response.json())).resolves.toMatchObject({ doc: replacement });
  });

  it("lets org-wide viewers read the shared doc but not write it", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const viewer = await sameOrgSession("observer");
    const workspace = await createWorkspace(app, owner);
    await setOrgShareRole(workspace.id, "viewer");
    const path = `/workspaces/${workspace.id}/webapp-state`;

    await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    });
    await expect(appRequest(app, path, {
      headers: { Cookie: viewer },
    }).then((response) => response.json())).resolves.toMatchObject({ doc: workspaceDoc });
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: viewer, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    })).status).toBe(403);
  });

  it("hides workspace state from members without any share", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const outsider = await sameOrgSession("bystander");
    const workspace = await createWorkspace(app, owner);
    const path = `/workspaces/${workspace.id}/webapp-state`;

    expect((await appRequest(app, path, {
      headers: { Cookie: outsider },
    })).status).toBe(403);
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: outsider, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    })).status).toBe(403);
  });

  it("normalizes legacy drawer segments to the merged integrations tab", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const legacy = {
      ...workspaceDoc,
      drawer: { ...workspaceDoc.drawer, segment: "leases" },
    };
    const put = await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(legacy),
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({
      doc: { drawer: { segment: "integrations" } },
    });
    const got = await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      headers: { Cookie: cookie },
    });
    await expect(got.json()).resolves.toMatchObject({
      doc: { drawer: { segment: "integrations" } },
    });
  });

  it("deletes per-workspace state on explicit destroy while preserving globals", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await appRequest(app, "/webapp-state", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, activeWorkspaceId: workspace.id, order: [workspace.id] }),
    });
    await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    });

    expect((await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM webapp_state WHERE workspace_id = ?1",
      ).bind(workspace.id).first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM webapp_state WHERE workspace_id IS NULL",
      ).first<number>("count"),
    ).toBe(1);
  });

  it("deletes per-workspace state when the orphan sweep finishes destroy", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    });
    await env.DB.prepare(
      "UPDATE workspaces SET phase = 'destroying' WHERE id = ?1",
    ).bind(workspace.id).run();

    expect(await runOrphanSweep(testRuntime(providers))).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM webapp_state WHERE workspace_id = ?1",
      ).bind(workspace.id).first<number>("count"),
    ).toBe(0);
  });
});
