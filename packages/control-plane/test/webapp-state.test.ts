import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret, randomToken } from "../core/crypto.js";
import { runOrphanSweep } from "../core/index.js";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  sameOrgSession,
  resetDatabase,
  testRuntime,
} from "./helpers.js";

/** The org-wide share became a stored workspace role per member
 * (plans/MEMBER-MACHINES.md §1): editor → member, viewer → viewer. */
async function setOrgShareRole(workspaceId: string, role: "editor" | "viewer"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspace_members
     (workspace_id, membership_id, role, added_by_membership_id, added_at)
     SELECT ?1, m.id, ?2, 'personal', ?3
     FROM memberships m
     WHERE m.org_id = 'personal' AND m.status = 'active' AND m.id != 'personal'
     ON CONFLICT(workspace_id, membership_id) DO UPDATE SET role = excluded.role`,
  ).bind(workspaceId, role === "editor" ? "member" : "viewer", Date.now()).run();
}

const workspaceDoc = {
  version: 1,
  title: "Docs",
  agentDefault: "claude",
  tabs: {
    version: 1,
    tabs: [
      { id: 1, type: "terminal" },
      { id: 2, type: "claude" },
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

  it("keeps bounded managed-session titles and ignores retired layout keys", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const path = `/workspaces/${workspace.id}/webapp-state`;
    const sendTabs = (tabs: unknown) => appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...workspaceDoc, tabs }),
    });
    const titled = await sendTabs({
      version: 1,
      tabs: [{ id: 1, type: "claude", title: "  Release work  " }],
      activeId: 1,
      nextId: 2,
    });
    expect(titled.status).toBe(200);
    expect((await titled.json<{ doc: { tabs: { tabs: unknown[] } } }>()).doc.tabs.tabs)
      .toEqual([{ id: 1, type: "claude", title: "Release work" }]);
    expect((await sendTabs({
      version: 1,
      tabs: [{ id: 1, type: "terminal", title: "x".repeat(65) }],
      activeId: 1,
      nextId: 2,
    })).status).toBe(400);
    // The short-lived archive/window model only ever ran on one self-hosted
    // deployment. Its keys are unknown fields like any other: archived
    // records drop and a retained-window tab is an ordinary tab.
    const legacy = await sendTabs({
      version: 1,
      tabs: [{ id: 1, type: "terminal", title: "Build", windowOpen: false }],
      archivedTabs: [{ id: 4, type: "terminal", title: "Archived" }],
      activeId: 1,
      nextId: 5,
    });
    expect(legacy.status).toBe(200);
    expect((await legacy.json<{ doc: { tabs: unknown } }>()).doc.tabs).toEqual({
      version: 1,
      tabs: [{ id: 1, type: "terminal", title: "Build" }],
      activeId: 1,
      nextId: 5,
    });
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
      headers: { Cookie: member.cookie },
    }).then((response) => response.json())).resolves.toMatchObject({ doc: workspaceDoc });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const replacement = { ...workspaceDoc, title: "Member view" };
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
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
      headers: { Cookie: viewer.cookie },
    }).then((response) => response.json())).resolves.toMatchObject({ doc: workspaceDoc });
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: viewer.cookie, "Content-Type": "application/json" },
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
      headers: { Cookie: outsider.cookie },
    })).status).toBe(403);
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: outsider.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    })).status).toBe(403);
  });

  it("never lets the tab counter rewind, whichever account writes", async () => {
    const { app } = harness();
    const owner = await operatorSession(app);
    const member = await sameOrgSession("counter");
    const workspace = await createWorkspace(app, owner);
    await setOrgShareRole(workspace.id, "editor");
    const path = `/workspaces/${workspace.id}/webapp-state`;
    const withTabs = (ids: number[], nextId: number) => ({
      ...workspaceDoc,
      tabs: {
        version: 1,
        tabs: ids.map((id) => ({ id, type: "claude" })),
        activeId: ids.at(-1) ?? null,
        nextId,
      },
    });

    // The owner opens tabs up to id 6.
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: owner, "Content-Type": "application/json" },
      body: JSON.stringify(withTabs([1, 2, 3, 4, 5], 6)),
    })).status).toBe(200);

    // A client holding an older view closes back down to one tab. Its ids may
    // shrink, but the counter must not: tab ids name live tmux sessions, and
    // reissuing 2 would attach a new tab to a session still running.
    const rewound = await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(withTabs([1], 2)),
    });
    expect(rewound.status).toBe(200);
    await expect(rewound.json()).resolves.toMatchObject({ doc: { tabs: { nextId: 6 } } });
    await expect(appRequest(app, path, { headers: { Cookie: owner } })
      .then((response) => response.json()))
      .resolves.toMatchObject({ doc: { tabs: { nextId: 6 } } });
  });

  it("refuses to resurrect state for a destroyed workspace", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const path = `/workspaces/${workspace.id}/webapp-state`;
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    })).status).toBe(200);
    expect((await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(200);

    // An open tab that saves after the destroy must not recreate the row the
    // teardown just deleted.
    expect((await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    })).status).toBe(404);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM webapp_state WHERE workspace_id = ?1",
      ).bind(workspace.id).first<number>("count"),
    ).toBe(0);
  });

  /** The webApp folds the pre-split drawer into a panel tab. Both shapes have
   * to survive a round trip through here, or a rejected write takes the whole
   * shared document — every tab in it — down with it. */
  it("stores split documents and preserves pre-split drawer fields for migration", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const path = `/workspaces/${workspace.id}/webapp-state`;
    const split = {
      version: 1,
      agentDefault: "claude",
      tabs: {
        version: 1,
        tabs: [
          { id: 1, type: "claude" },
          { id: 2, type: "preview", url: "https://demo.blitz.dev", title: "Demo" },
          { id: 3, type: "panel", panel: "previews", region: "side" },
        ],
        activeId: 1,
        nextId: 4,
        sideActiveId: 3,
      },
      drawer: { version: 1, width: 340, expanded: ["src"] },
    };
    const put = await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(split),
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({ doc: split });

    // A pre-split row still has to read back with open/segment attached: the
    // webApp needs them to build the panel tab, and dropping them here would
    // silently close everyone's drawer.
    await env.DB.prepare("UPDATE webapp_state SET doc = ?1 WHERE workspace_id = ?2")
      .bind(JSON.stringify(workspaceDoc), workspace.id).run();
    const got = await appRequest(app, path, { headers: { Cookie: cookie } });
    await expect(got.json()).resolves.toMatchObject({
      doc: { drawer: { open: true, segment: "files", width: 280 } },
    });
  });

  it("drops a stored legacy chat tab on read instead of failing the document", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const path = `/workspaces/${workspace.id}/webapp-state`;
    // Seed a row the way the retired native-chat surface wrote it: a chat tab
    // in each pane, and both active ids pointing at one. The document is
    // shared, so a refusal here would take the whole tab layout down for
    // everyone rather than only losing the tabs that no longer exist.
    await appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    });
    await env.DB.prepare("UPDATE webapp_state SET doc = ?1 WHERE workspace_id = ?2").bind(
      JSON.stringify({
        ...workspaceDoc,
        tabs: {
          version: 1,
          tabs: [
            { id: 1, type: "chat", chatSessionId: "chat-session-1", chatProvider: "claude" },
            { id: 2, type: "terminal" },
            { id: 3, type: "chat", region: "side" },
          ],
          activeId: 1,
          nextId: 4,
          sideActiveId: 3,
        },
      }),
      workspace.id,
    ).run();

    const got = await appRequest(app, path, { headers: { Cookie: cookie } });
    expect(got.status).toBe(200);
    await expect(got.json()).resolves.toMatchObject({
      doc: {
        tabs: {
          version: 1,
          tabs: [{ id: 2, type: "terminal" }],
          activeId: null,
          nextId: 4,
        },
      },
    });
    const doc = (await appRequest(app, path, { headers: { Cookie: cookie } })
      .then((response) => response.json<{ doc: { tabs: { sideActiveId?: number } } }>())).doc;
    expect(doc.tabs.sideActiveId).toBeUndefined();
  });

  it("rejects panel and region fields that name nothing", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const path = `/workspaces/${workspace.id}/webapp-state`;
    const send = (tabs: unknown) => appRequest(app, path, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ ...workspaceDoc, tabs }),
    });
    expect((await send({
      version: 1,
      tabs: [{ id: 1, type: "panel", panel: "nope" }],
      activeId: 1,
      nextId: 2,
    })).status).toBe(400);
    expect((await send({
      version: 1,
      tabs: [{ id: 1, type: "claude", region: "middle" }],
      activeId: 1,
      nextId: 2,
    })).status).toBe(400);
    // activeId names the main pane, so it may not point at a side tab.
    expect((await send({
      version: 1,
      tabs: [{ id: 1, type: "claude", region: "side" }],
      activeId: 1,
      nextId: 2,
    })).status).toBe(400);
    expect((await send({
      version: 1,
      tabs: [{ id: 1, type: "claude" }],
      activeId: 1,
      nextId: 2,
      sideActiveId: 1,
    })).status).toBe(400);
  });

  it("normalizes legacy drawer segments to the merged connections tab", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    // 'integrations' is the pre-rename panel value; the older credential
    // segments fold the same way. Every legacy spelling lands on 'connections'.
    for (const legacySegment of ["leases", "integrations"]) {
      const legacy = {
        ...workspaceDoc,
        drawer: { ...workspaceDoc.drawer, segment: legacySegment },
      };
      const put = await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(legacy),
      });
      expect(put.status).toBe(200);
      await expect(put.json()).resolves.toMatchObject({
        doc: { drawer: { segment: "connections" } },
      });
      const got = await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
        headers: { Cookie: cookie },
      });
      await expect(got.json()).resolves.toMatchObject({
        doc: { drawer: { segment: "connections" } },
      });
    }
  });

  it("folds a legacy 'integrations' panel tab to 'connections'", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const doc = {
      ...workspaceDoc,
      tabs: {
        version: 1,
        tabs: [
          { id: 1, type: "claude" },
          { id: 2, type: "panel", panel: "integrations", region: "side" },
        ],
        activeId: 1,
        nextId: 3,
        sideActiveId: 2,
      },
      drawer: { version: 1, width: 280, expanded: [] },
    };
    const put = await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({
      doc: { tabs: { tabs: [
        { id: 1, type: "claude" },
        { id: 2, type: "panel", panel: "connections", region: "side" },
      ] } },
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

  // The webApp's own parser (packages/webapp/src/storage.ts) keeps the same
  // optional field. When this mirror dropped it, a deep-linked preview tab
  // came back from the server pointing at "/" after every reload.
  it("keeps the optional deep-link path on a preview tab", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const withPreviews = (tabs: object[]) => ({
      ...workspaceDoc,
      tabs: { version: 1, tabs, activeId: null, nextId: tabs.length + 1 },
    });
    const put = (tabs: object[]) => appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(withPreviews(tabs)),
    });

    const stored = await put([
      { id: 1, type: "preview", port: 3000, path: "/dashboard" },
      { id: 2, type: "preview", port: 5173 },
    ]);
    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toMatchObject({
      doc: {
        tabs: {
          tabs: [
            { id: 1, type: "preview", port: 3000, path: "/dashboard" },
            { id: 2, type: "preview", port: 5173 },
          ],
        },
      },
    });
    const reloaded = await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      headers: { Cookie: cookie },
    });
    await expect(reloaded.json()).resolves.toMatchObject({
      doc: { tabs: { tabs: [{ id: 1, path: "/dashboard" }, { id: 2 }] } },
    });

    expect((await put([{ id: 1, type: "preview", port: 3000, path: "dashboard" }])).status)
      .toBe(400);
    expect((await put([{ id: 1, type: "preview", port: 3000, path: 42 }])).status).toBe(400);
    expect((await put([
      { id: 1, type: "preview", port: 3000, path: `/${"x".repeat(4_096)}` },
    ])).status).toBe(400);
  });

  // The path travels from the in-box agent (`blitz preview open --path`) to the
  // focus marker to this document, and the browser renders it as
  // `/preview/<port><path>` in an iframe. A URL normalizes before it is
  // requested, so a stored `..` walks the iframe out of the `/preview/<port>/`
  // prefix and onto another box surface — the proxy's own traversal check never
  // sees the `..`. Refuse it here the same way a file tab's path is refused.
  it("refuses a traversal segment in a preview deep-link", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const put = (path: unknown) => appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...workspaceDoc,
        tabs: {
          version: 1,
          tabs: [{ id: 1, type: "preview", port: 3000, path }],
          activeId: null,
          nextId: 2,
        },
      }),
    });

    for (const path of ["/..", "/../workspace/", "/app/../../workspace/", "/a/../b"]) {
      expect((await put(path)).status, path).toBe(400);
    }
    // A `..` inside a segment is an ordinary route and is still stored.
    expect((await put("/a..b")).status).toBe(200);
    expect((await put(`/${"x".repeat(4_095)}`)).status).toBe(200);
  });

  it("keeps per-workspace state through a machine destroy and drops it with the workspace", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    await appRequest(app, `/workspaces/${workspace.id}/webapp-state`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(workspaceDoc),
    });
    // The workspace doc is workspace-wide, so a machine finishing its destroy
    // must not take it: another member may still be working. Deleting it is
    // the WORKSPACE delete's job, and only once every machine is gone.
    await env.DB.prepare(
      "UPDATE machines SET state = 'destroying' WHERE workspace_id = ?1",
    ).bind(workspace.id).run();

    expect(await runOrphanSweep(testRuntime(providers))).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM webapp_state WHERE workspace_id = ?1",
      ).bind(workspace.id).first<number>("count"),
    ).toBe(1);

    const destroyed = await appRequest(app, `/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(destroyed.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM webapp_state WHERE workspace_id = ?1",
      ).bind(workspace.id).first<number>("count"),
    ).toBe(0);
  });
});
