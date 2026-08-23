import type { WorkspaceEnvironmentResponse, WorkspaceView } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  backgroundTasksSettled,
  createWorkspace,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
  sameOrgSession,
} from "./helpers.js";

describe("workspace environments", () => {
  beforeEach(resetDatabase);

  it("validates, stores, and projects a workspace environment", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const environment = {
      env: { API_ORIGIN: "https://api.example", EMPTY: "" },
      startupScript: "printf ready\n",
    };
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small", environment }),
    });
    expect(created.status).toBe(201);
    expect((await created.json<{ workspace: WorkspaceView }>()).workspace.environment)
      .toEqual(environment);

    const invalid = [
      { env: { "BAD-KEY": "x" }, startupScript: null },
      { env: { PORT: 3000 }, startupScript: null },
      { env: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`KEY_${index}`, "x"])), startupScript: null },
      { env: { LARGE: "x".repeat(8 * 1024) }, startupScript: null },
      { env: {}, startupScript: "x".repeat(64 * 1024 + 1) },
    ];
    for (const candidate of invalid) {
      const response = await appRequest(app, "/workspaces", {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ machineTypeId: "small", environment: candidate }),
      });
      expect(response.status, JSON.stringify(candidate).slice(0, 100)).toBe(400);
    }
  });

  it("serves only the authenticated box's environment and files-ready state", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const environment = {
      env: { PROJECT_MODE: "analysis" },
      startupScript: "touch booted\n",
    };
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small", environment }),
    });
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    const ready = await appRequest(app, new URL(phoneHomeUrl(providers, workspace.id)).pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pub_key_ed25519: "ssh-ed25519 AAAAhost" }),
    });
    const box = await ready.json<{ access_token: string }>();
    await backgroundTasksSettled();
    await env.DB.prepare("UPDATE workspaces SET files_ready = 0 WHERE id = ?1")
      .bind(workspace.id).run();

    const self = await appRequest(app, "/workspaces/self/environment", {
      headers: { Authorization: `Bearer ${box.access_token}` },
    });
    expect(self.status).toBe(200);
    expect(await self.json<WorkspaceEnvironmentResponse>()).toEqual({
      ...environment,
      filesReady: false,
    });

    const nonBox = await appRequest(app, "/workspaces/self/environment", {
      headers: { Cookie: cookie },
    });
    expect(nonBox.status).toBe(401);
    await expect(nonBox.json()).resolves.toMatchObject({ error: "invalid box access token" });

    const other = await createWorkspace(app, cookie);
    const crossWorkspace = await appRequest(app, `/workspaces/${other.id}/environment`, {
      headers: { Authorization: `Bearer ${box.access_token}` },
    });
    expect(crossWorkspace.status).toBe(403);
    await expect(crossWorkspace.json()).resolves.toMatchObject({
      error: "a box may only read its own workspace environment",
    });

    await env.DB.prepare("UPDATE workspaces SET files_ready = 1 WHERE id = ?1")
      .bind(workspace.id).run();
    const complete = await appRequest(app, "/workspaces/self/environment", {
      headers: { Authorization: `Bearer ${box.access_token}` },
    });
    await expect(complete.json()).resolves.toEqual({ ...environment, filesReady: true });
  });

  it("hides env values and the startup script from members who cannot open the workspace", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const environment = {
      env: { API_ORIGIN: "https://api.example" },
      startupScript: "printf secret\n",
    };
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small", environment }),
    });
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    const member = await sameOrgSession("bystander");

    // GET /workspaces returns every row in the org. A member with no grant and
    // no org share reads the row, so the environment has to be gated the same
    // way `ssh` is or the whole org reads the config.
    const listed = await appRequest(app, "/workspaces", { headers: { Cookie: member.cookie } });
    const rows = (await listed.json<{ workspaces: WorkspaceView[] }>()).workspaces;
    const seen = rows.find(({ id }) => id === workspace.id);
    expect(seen?.role).toBeNull();
    expect(seen?.environment).toBeNull();

    expect((await appRequest(app, `/workspaces/${workspace.id}/org-role`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    })).status).toBe(204);
    const shared = await appRequest(app, "/workspaces", { headers: { Cookie: member.cookie } });
    const visible = (await shared.json<{ workspaces: WorkspaceView[] }>()).workspaces
      .find(({ id }) => id === workspace.id);
    expect(visible?.environment).toEqual(environment);
  });

  it("treats an unparseable stored environment as none configured", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const healthy = await createWorkspace(app, cookie);
    await env.DB.prepare("UPDATE workspaces SET environment = ?2 WHERE id = ?1")
      .bind(workspace.id, '{"env":{"BAD-KEY":"x"},"startupScript":null}').run();

    // One corrupt row must not take down the list for the whole org.
    const listed = await appRequest(app, "/workspaces", { headers: { Cookie: cookie } });
    expect(listed.status).toBe(200);
    const rows = (await listed.json<{ workspaces: WorkspaceView[] }>()).workspaces;
    expect(rows.find(({ id }) => id === workspace.id)?.environment).toBeNull();
    expect(rows.map(({ id }) => id)).toContain(healthy.id);

    const single = await appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
    });
    expect(single.status).toBe(200);
  });

  it("rejects a create body larger than the request ceiling", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ machineTypeId: "small", userData: "x".repeat(200 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});
