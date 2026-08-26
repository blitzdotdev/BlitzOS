import { changed, first } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { BoxIdentity } from "./types.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { canControlWorkspace } from "./workspace-access.js";
import { workspaceById } from "./workspace-records.js";
import {
  BOX_UPDATE_OUTCOMES,
  type BoxConfigResponse,
  type BoxUpdateOutcome,
  type BoxUpdateResultRequest,
} from "./wire.js";

// The box-config contract (see wire.ts and packages/schema/fixtures/box-config/):
// the VM host polls GET /workspaces/self/box-config with the box credential,
// refreshes /var/lib/blitz/origin from `controlPlaneOrigin` on every poll, and
// replaces the container only when `updateRequested` is set. It then reports
// { ref, outcome } to POST /workspaces/self/box-update-result, which clears the
// flag and stores the ref on the workspace row — per-workspace image
// observability. All of this is the cloud-VM path (Hetzner/AWS user-data); the
// microVM provider has its own guest lifecycle (packages/microvm-host/) and
// simply does not support updates yet.

/** The character set of a docker image reference or of the R2 tarball https
 * URL BOX_IMAGE_REF may hold — the same alphabet the bootstrap's embedded
 * manifest validator pins for `imageTag`. One token, no whitespace, so a ref
 * can cross the bash boundary unquoted-safe. */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u;

/** Exactly an origin — scheme, host, optional port, nothing after. The host
 * writes this value verbatim into /var/lib/blitz/origin, where the box
 * gateway compares it against the browser Origin header, so a path or a
 * trailing slash would break every websocket. */
const HTTP_ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/u;

/** APP_URL is the deployment's public origin. Absent or unparseable means
 * "not configured yet" (the self-host template ships it empty), and the
 * box-config route then answers with the request origin instead. */
export function controlPlaneOriginFromEnv(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function isBoxUpdateOutcome(value: unknown): value is BoxUpdateOutcome {
  return BOX_UPDATE_OUTCOMES.some((outcome) => outcome === value);
}

/** Accepts iff `ref` is one image-reference token and `outcome` is a known
 * verdict. Unknown extra keys are tolerated on purpose: hosts only update by
 * shipping new images, so an older control plane must keep accepting a newer
 * host's report or the update flag would stay set forever. */
export function parseBoxUpdateResult(value: JsonValue): BoxUpdateResultRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const ref = requiredString(value.ref, "ref", 512);
  if (!IMAGE_REF.test(ref)) throw new HttpError(400, "ref must be an image reference");
  if (!isBoxUpdateOutcome(value.outcome)) {
    throw new HttpError(400, `outcome must be one of ${BOX_UPDATE_OUTCOMES.join(", ")}`);
  }
  return { ref, outcome: value.outcome };
}

async function requireWorkspaceBox(
  context: CoreContext,
  runtimeFactory: RuntimeFactory,
): Promise<BoxIdentity & { workspaceId: string }> {
  const box = await authenticateBox(context.req.raw, runtimeFactory(context).db);
  if (box === null) throw new HttpError(401, "invalid box access token");
  if (box.workspaceId === null) {
    throw new HttpError(403, "only workspace boxes have a box config");
  }
  return { ...box, workspaceId: box.workspaceId };
}

export function addBoxConfigRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  // Host-polled, box-authenticated. The response shape is the box-config
  // contract; edit it with its fixtures, never alone.
  router.get("/workspaces/self/box-config", async (context) => {
    const box = await requireWorkspaceBox(context, runtimeFactory);
    const runtime = runtimeFactory(context);
    const row = await first<{ box_update_requested: number }>(runtime.db, {
      q: "SELECT box_update_requested FROM workspaces WHERE id = ?1 LIMIT 1",
      v: [box.workspaceId],
    });
    if (row === null) throw new HttpError(404, "workspace not found");
    const response: BoxConfigResponse = {
      boxImageRef: runtime.vars.boxImageRef,
      // The configured public origin when the deployment has one; otherwise
      // the origin this request arrived on. The fallback keeps a fresh
      // self-host working before APP_URL is filled in, but only the
      // configured value can heal a box after a domain move.
      controlPlaneOrigin:
        runtime.vars.controlPlaneOrigin ?? new URL(context.req.url).origin,
      updateRequested: row.box_update_requested === 1,
    };
    return context.json(response);
  });

  // The host's report after an update attempt. Clearing the flag on every
  // outcome is deliberate: a failed attempt was still the answer to this
  // request, and the flag re-arming itself would retry a kill-everything
  // operation nobody asked for twice.
  router.post("/workspaces/self/box-update-result", async (context) => {
    const box = await requireWorkspaceBox(context, runtimeFactory);
    const input = parseBoxUpdateResult(await readJson(context.req.raw, 4 * 1024));
    await changed(runtimeFactory(context).db, {
      q: `UPDATE workspaces
          SET box_update_requested = 0, box_image_reported = ?1, updated_at = ?2
          WHERE id = ?3 RETURNING id`,
      v: [input.ref, Date.now(), box.workspaceId],
    });
    return context.body(null, 204);
  });

  // The guest verb (`blitz box update`) lands here with the box's own token:
  // an agent inside the workspace may ask for its own box to be updated.
  router.post("/workspaces/self/box-update", async (context) => {
    const box = await requireWorkspaceBox(context, runtimeFactory);
    await changed(runtimeFactory(context).db, {
      q: `UPDATE workspaces
          SET box_update_requested = 1, updated_at = ?1
          WHERE id = ?2 RETURNING id`,
      v: [Date.now(), box.workspaceId],
    });
    return context.body(null, 204);
  });

  // Session-authenticated request path for the UI/API. No webapp UI consumes
  // it yet; the gate is the same one destroy uses.
  router.post("/workspaces/:id/box-update", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const row = await workspaceById(runtime.db, context.req.param("id"));
    if (row === null || row.org_id !== principal.orgId || row.phase === "destroyed") {
      throw new HttpError(404, "workspace not found");
    }
    if (!canControlWorkspace(principal, row)) throw new HttpError(403, "forbidden");
    await changed(runtime.db, {
      q: `UPDATE workspaces
          SET box_update_requested = 1, updated_at = ?1
          WHERE id = ?2 RETURNING id`,
      v: [Date.now(), row.id],
    });
    return context.body(null, 204);
  });
}
