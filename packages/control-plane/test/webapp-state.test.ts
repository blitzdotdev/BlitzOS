import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runOrphanSweep } from "../core/index.js";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  resetDatabase,
  testRuntime,
} from "./helpers.js";

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
