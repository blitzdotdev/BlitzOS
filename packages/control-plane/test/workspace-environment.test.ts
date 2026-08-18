import type { WorkspaceEnvironmentResponse, WorkspaceView } from "@blitzos/schema";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { scheduledSyncsSettled } from "../core/files/sync.js";
import {
  appRequest,
  createWorkspace,
  harness,
  operatorSession,
  phoneHomeUrl,
  resetDatabase,
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
    await scheduledSyncsSettled();
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
});
