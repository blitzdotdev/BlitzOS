import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
} from "./helpers.js";

function json(body: { enabled: boolean }, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("recipes (disabled 2026-08-29, feature hidden)", () => {
  beforeEach(resetDatabase);

  // The recipe code and the `recipes` rows are untouched; only the routes are
  // unmounted (see the commented registration in core/app.ts). What this pins
  // is that the whole surface is absent, launch included, so nothing reaches a
  // launch source it can no longer resolve.
  it("answers 404 on every recipe route, launch included", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const body = {
      name: "routine",
      templateId: "any-workspace",
      harness: "claude",
      prompt: "Go.\n",
    };

    const routes: Array<[string, RequestInit]> = [
      ["/workspace-recipes", { headers: { Cookie: cookie } }],
      ["/workspace-recipes/some-id", { headers: { Cookie: cookie } }],
      ["/workspace-recipes", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }],
      ["/workspace-recipes/some-id", {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }],
      ["/workspace-recipes/some-id", { method: "DELETE", headers: { Cookie: cookie } }],
      ["/workspace-recipes/some-id/launch", { method: "POST", headers: { Cookie: cookie } }],
    ];
    for (const [path, init] of routes) {
      const response = await appRequest(app, path, init);
      expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(404);
      await expect(response.json(), path).resolves.toEqual({
        error: "not found",
        retryAction: null,
      });
    }
  });

  // The rows survive the surface. A recipe written before the feature was
  // hidden is still in D1, and turning the routes back on has to find it.
  it("leaves recipe rows in the database untouched", async () => {
    const { app } = harness();
    await operatorSession(app);
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO recipes
       (id, org_id, name, source_workspace_id, harness, model, effort, prompt,
        created_by_membership_id, created_at, updated_at)
       VALUES ('kept', 'personal', 'nightly evals', NULL, 'codex', NULL, NULL,
               'Go.\n', 'personal', ?1, ?1)`,
    ).bind(now).run();

    expect((await appRequest(app, "/workspace-recipes/kept")).status).toBe(404);
    await expect(env.DB.prepare("SELECT id, name FROM recipes WHERE id = 'kept'").first())
      .resolves.toMatchObject({ id: "kept", name: "nightly evals" });
  });

  it("gates usage capture behind the org admin and lazy-creates the folder once", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const member = await sameOrgSession("plain-member");

    expect((await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: true }, "PUT"),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, "/orgs/self/usage-capture", {
      headers: { Cookie: member.cookie },
    })).status).toBe(403);

    const before = await appRequest(app, "/orgs/self/usage-capture", {
      headers: { Cookie: admin },
    });
    expect(await before.json()).toEqual({ enabled: false, folderId: null });

    const enabled = await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: true }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    expect(enabled.status).toBe(200);
    const state = await enabled.json<{ enabled: boolean; folderId: string | null }>();
    expect(state.enabled).toBe(true);
    expect(state.folderId).not.toBeNull();

    // Owned by the enabling admin, grant-private (no org_role).
    const folder = await env.DB.prepare(
      "SELECT name, org_role, created_by_membership_id FROM folders WHERE id = ?1",
    ).bind(state.folderId).first<{ name: string; org_role: string | null; created_by_membership_id: string }>();
    expect(folder?.name).toBe("Agent usage");
    expect(folder?.org_role).toBeNull();
    expect(folder?.created_by_membership_id).toBe("personal");

    // Disable keeps the folder; re-enable reuses it instead of minting another.
    const disabled = await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: false }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    expect(await disabled.json()).toEqual({ enabled: false, folderId: state.folderId });
    const reEnabled = await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: true }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    expect(await reEnabled.json()).toEqual({ enabled: true, folderId: state.folderId });
    const folders = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM folders WHERE name = 'Agent usage'",
    ).first<{ total: number }>();
    expect(folders?.total).toBe(1);

    // Every create in a capturing org boots with the read-only usage mounts.
    const createdWorkspace = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    const workspace = (await createdWorkspace.json<WorkspaceEnvelope>()).workspace;
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain(
      "--mount type=bind,src=/var/lib/blitz/home/.claude/projects,dst=/workspace/shared/agent-usage/claude,readonly \\",
    );
    expect(userData).toContain(
      "--mount type=bind,src=/var/lib/blitz/home/.codex/sessions,dst=/workspace/shared/agent-usage/codex,readonly \\",
    );

    // Deleting the usage folder leaves the org columns alone — a dangling
    // usage_folder_id is accepted (no foreign key, no cascade); the push leg
    // inner-joins folders and simply stops exporting (pinned in
    // usage-push.test.ts).
    expect((await appRequest(app, `/folders/${state.folderId}`, {
      method: "DELETE",
      headers: { Cookie: admin },
    })).status).toBe(204);
    const after = await appRequest(app, "/orgs/self/usage-capture", {
      headers: { Cookie: admin },
    });
    expect(await after.json()).toEqual({ enabled: true, folderId: state.folderId });
  });
});
