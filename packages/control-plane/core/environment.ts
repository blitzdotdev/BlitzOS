import { HttpError } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { CoreRouter, RuntimeFactory } from "./runtime.js";
import type { WorkspaceEnvironmentResponse } from "./wire.js";

/** Largest legal create/update body: userData 48 KiB, a credential manifest,
 * a member roster and JSON escaping on top. JSON.parse runs before any of it
 * is validated, so the ceiling stays close to real. */
export const WORKSPACE_REQUEST_MAX_BYTES = 128 * 1024;

/**
 * The legacy workspace-environment route.
 *
 * The feature is gone: static secrets live in `org_credentials` and only the
 * agent API serves them, and the startup script has no runner left. The
 * route stays because DEPLOYED broker binaries poll it every second at boot
 * and wait for a 200 carrying all three fields with `filesReady: true`. A 404
 * or a missing field makes every already-deployed box poll forever, so this
 * answers the empty set unconditionally — no workspace lookup, no readiness
 * gate, nothing that can turn into a retry.
 *
 * It is a compatibility shim with an expiry: it can go once no box that polls
 * it is still running.
 */
export function addWorkspaceEnvironmentRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/workspaces/:id/environment", async (context) => {
    const runtime = runtimeFactory(context);
    const box = await authenticateBox(context.req.raw, runtime.db);
    if (box === null) throw new HttpError(401, "invalid box access token");
    if (box.workspaceId === null) {
      throw new HttpError(403, "box is not attached to a workspace");
    }
    const idParam = context.req.param("id");
    if (idParam !== "self" && box.workspaceId !== idParam) {
      throw new HttpError(403, "a box may only read its own workspace environment");
    }
    return context.json<WorkspaceEnvironmentResponse>({
      env: {},
      startupScript: null,
      filesReady: true,
    });
  });
}
