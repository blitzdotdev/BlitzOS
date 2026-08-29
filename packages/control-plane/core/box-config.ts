import { changed, first } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { BoxIdentity } from "./types.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import { machineFor } from "./machines.js";
import { requireWorkspaceAdmin } from "./workspace-access.js";
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

/** APP_URL is the deployment's public origin. Absent or unparseable means
 * "not configured yet" (the self-host template ships it empty), and the
 * box-config route then answers with the request origin instead. `URL.origin`
 * is what makes the emitted value safe for the host to write verbatim into
 * /var/lib/blitz/origin: it is scheme, host and optional port, never a path
 * or a trailing slash, which the box gateway compares against the browser
 * Origin header. */
export function controlPlaneOriginFromEnv(value: string | null | undefined): string | undefined {
  const raw = (value ?? "").trim();
  if (raw === "") return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function boxUpdateOutcome(value: string): BoxUpdateOutcome {
  const outcome = BOX_UPDATE_OUTCOMES.find((known) => known === value);
  if (outcome === undefined) {
    throw new HttpError(400, `outcome must be one of ${BOX_UPDATE_OUTCOMES.join(", ")}`);
  }
  return outcome;
}

/** Accepts iff `ref` is one image-reference token and `outcome` is a known
 * verdict. Unknown extra keys are tolerated on purpose: hosts only update by
 * shipping new images, so an older control plane must keep accepting a newer
 * host's report or the update flag would stay set forever. */
export function parseBoxUpdateResult(value: JsonValue): BoxUpdateResultRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const ref = requiredString(value.ref, "ref", 512);
  if (!IMAGE_REF.test(ref)) throw new HttpError(400, "ref must be an image reference");
  return { ref, outcome: boxUpdateOutcome(requiredString(value.outcome, "outcome", 64)) };
}

/** Arm the flag the host's next poll reads. The flag is per MACHINE now: a
 * workspace holds one VM per member, so "update this box" names one of them.
 * Both request paths — the guest verb with the machine's own token and the
 * session route — write it here, so the one statement has one home. */
async function requestBoxUpdate(db: CoreRuntime["db"], machineId: string): Promise<void> {
  await changed(db, {
    q: `UPDATE machines
        SET box_update_requested = 1, updated_at = ?1
        WHERE id = ?2 RETURNING id`,
    v: [Date.now(), machineId],
  });
}

async function requireWorkspaceBox(
  context: CoreContext,
  runtimeFactory: RuntimeFactory,
): Promise<BoxIdentity & { workspaceId: string }> {
  const box = await authenticateBox(context.req.raw, runtimeFactory(context).db);
  if (box === null) throw new HttpError(401, "invalid box access token");
  if (box.workspaceId === null) {
    throw new HttpError(403, "only workspace machines have a box config");
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
      q: "SELECT box_update_requested FROM machines WHERE id = ?1 LIMIT 1",
      v: [box.id],
    });
    if (row === null) throw new HttpError(404, "machine not found");
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
      q: `UPDATE machines
          SET box_update_requested = 0, box_image_reported = ?1, updated_at = ?2
          WHERE id = ?3 RETURNING id`,
      v: [input.ref, Date.now(), box.id],
    });
    return context.body(null, 204);
  });

  // The guest verb (`blitz box update`) lands here with the box's own token:
  // an agent inside the workspace may ask for its own box to be updated.
  router.post("/workspaces/self/box-update", async (context) => {
    const box = await requireWorkspaceBox(context, runtimeFactory);
    await requestBoxUpdate(runtimeFactory(context).db, box.id);
    return context.body(null, 204);
  });

  // Session-authenticated request path for the UI/API. No webapp UI consumes
  // it yet; the gate is the same one destroy uses.
  router.post("/workspaces/:id/box-update", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const row = await workspaceById(runtime.db, context.req.param("id"));
    if (row === null || row.org_id !== principal.orgId || row.deleted_at !== null) {
      throw new HttpError(404, "workspace not found");
    }
    await requireWorkspaceAdmin(runtime.db, principal, row);
    // The caller's own machine. A workspace has no single box to update any
    // more, and picking somebody else's would restart a colleague's work.
    if (principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const machine = await machineFor(runtime.db, row.id, principal.membershipId);
    if (machine === null) throw new HttpError(409, "you have no machine in this workspace");
    await requestBoxUpdate(runtime.db, machine.id);
    return context.body(null, 204);
  });
}
