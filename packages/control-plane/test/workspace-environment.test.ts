import type { WorkspaceEnvironmentResponse, WorkspaceView } from "@blitzos/schema";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appRequest,
  boxTokenFor,
  createWorkspace,
  harness,
  operatorSession,
  resetDatabase,
} from "./helpers.js";

/**
 * The workspace environment is retired (plans/MEMBER-MACHINES.md §1).
 *
 * Values live in `workspace_credentials` and only `blitz-cred` reads them; the
 * startup script has no runner left. What survives is a compatibility shim,
 * and these tests pin exactly what it owes: DEPLOYED broker binaries poll
 * `GET /workspaces/self/environment` every second at boot and wait for a 200
 * carrying all three fields with `filesReady: true`. A 404 or a dropped field
 * makes every already-deployed box poll forever.
 */
describe("workspace environment (legacy shim)", () => {
  beforeEach(resetDatabase);

  it("answers the empty set with all three fields and filesReady true", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const workspace = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, workspace.id);

    for (const path of ["/workspaces/self/environment", `/workspaces/${workspace.id}/environment`]) {
      const response = await appRequest(app, path, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status, path).toBe(200);
      const body = await response.json<WorkspaceEnvironmentResponse>();
      // Exactly these keys: the box decodes with DisallowUnknownFields and
      // waits for filesReady, so a missing or extra field is a boot that never
      // finishes.
      expect(Object.keys(body).sort()).toEqual(["env", "filesReady", "startupScript"]);
      expect(body).toEqual({ env: {}, startupScript: null, filesReady: true });
    }
  });

  it("still refuses an unauthenticated caller and another workspace's id", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const mine = await createWorkspace(app, cookie);
    const other = await createWorkspace(app, cookie);
    const token = await boxTokenFor(app, providers, mine.id);

    expect((await appRequest(app, "/workspaces/self/environment")).status).toBe(401);
    expect((await appRequest(app, `/workspaces/${other.id}/environment`, {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(403);
  });

  it("ignores a legacy environment field on a create", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const created = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        environment: { env: { API_ORIGIN: "https://api.example" }, startupScript: null },
      }),
    });
    // The field is gone from the request, not refused: an old client that
    // still sends one gets its workspace, and the value goes nowhere. A
    // credential is written through `credentials` now.
    expect(created.status).toBe(201);
    const workspace = (await created.json<{ workspace: WorkspaceView }>()).workspace;
    expect(workspace.credentials).toEqual([]);
  });

  it("rejects a create body larger than the request ceiling", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const response = await appRequest(app, "/workspaces", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        machineTypeId: "small",
        userData: "#cloud-config\n".padEnd(200 * 1024, "x"),
      }),
    });
    expect(response.status).toBe(413);
  });
});
