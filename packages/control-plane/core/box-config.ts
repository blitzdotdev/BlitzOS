import { changed, first } from "./db.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { BoxIdentity } from "./types.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import { machineFor } from "./machines.js";
import { machineById, machineTarget } from "./machine-access.js";
import {
  isWorkspaceAdmin,
  isWorkspaceMember,
  workspaceAccess,
} from "./workspace-access.js";
import { machineView, workspaceById } from "./workspace-records.js";
import {
  BOX_UPDATE_OUTCOMES,
  type BoxConfigResponse,
  type BoxUpdateOutcome,
  type BoxUpdateResultRequest,
  type MachineResponse,
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

/** The CONCRETE box image this deployment installs now.
 *
 * Two modes, one answer. Under a registry pin (`BOX_IMAGE_REF` is a
 * `ghcr.io/...` ref) the ref IS the image and `BOX_IMAGE_TAG` is empty. Under
 * an R2 manifest pin the ref is a `https://.../manifest.json` URL that is
 * byte-identical across rebakes, and `BOX_IMAGE_TAG` is the tag that actually
 * moves — so the tag is the only thing worth comparing a machine against.
 * This is the value the host reports back as `tag`, from the other end of the
 * same two modes. */
export function deploymentBoxImage(vars: {
  boxImageRef: string;
  boxImageTag: string;
}): string {
  const tag = vars.boxImageTag.trim();
  return tag === "" ? vars.boxImageRef : tag;
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
 * host's report or the update flag would stay set forever.
 *
 * `tag` is optional for the same reason in the other direction: a host emitted
 * before the manifest branch reports only `ref`. Present, it must be one image
 * reference token like `ref` is — it is the image the container now runs. */
export function parseBoxUpdateResult(value: JsonValue): BoxUpdateResultRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const ref = requiredString(value.ref, "ref", 512);
  if (!IMAGE_REF.test(ref)) throw new HttpError(400, "ref must be an image reference");
  const outcome = boxUpdateOutcome(requiredString(value.outcome, "outcome", 64));
  if (value.tag === undefined) return { ref, outcome };
  const tag = requiredString(value.tag, "tag", 512);
  if (!IMAGE_REF.test(tag)) throw new HttpError(400, "tag must be an image reference");
  return { ref, outcome, tag };
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
      boxImageSha256: runtime.vars.boxImageSha256,
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
    // A host that sends no `tag` leaves the stored one alone rather than
    // nulling it: it predates the field, and what the row already holds — the
    // image the boot was armed with — stays the best answer available.
    await changed(runtimeFactory(context).db, {
      q: `UPDATE machines
          SET box_update_requested = 0, box_image_reported = ?1,
              box_image_tag_reported = COALESCE(?4, box_image_tag_reported),
              box_update_outcome = ?5, updated_at = ?2
          WHERE id = ?3 RETURNING id`,
      v: [input.ref, Date.now(), box.id, input.tag ?? null, input.outcome],
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

  // The "Update machine" button in the My machine dialog.
  //
  // It names ONE machine, and it is registered here rather than in
  // `core/machines.ts` because the flag and its contract live here — but it
  // takes the same `/machines/:machineId/<verb>` shape and the same gate as
  // the lifecycle verbs beside it (`core/machine-access.ts`, scope `own`), so
  // a member may update their own machine and nobody else's.
  //
  // The workspace-level route below is the fan-out an admin asks for
  // deliberately. This one can never become that by accident, which matters:
  // replacing a container kills every process inside it, and a user who
  // clicked a button in their own machine dialog did not ask to restart their
  // colleagues' work. It answers with the machine, so the dialog can render
  // the pending flag without waiting for the next poll.
  router.post("/machines/:machineId/box-update", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const { machine } = await machineTarget(
      runtime.db,
      principal,
      context.req.param("machineId"),
      "own",
    );
    if (machine.state === "destroyed" || machine.state === "destroying") {
      throw new HttpError(409, `machine is ${machine.state}`);
    }
    await requestBoxUpdate(runtime.db, machine.id);
    const updated = await machineById(runtime.db, machine.id);
    if (updated === null) throw new HttpError(404, "machine not found");
    return context.json<MachineResponse>({
      machine: machineView(updated, deploymentBoxImage(runtime.vars)),
    });
  });

  // Session-authenticated request path for the UI/API. The webapp uses the
  // per-machine route above; this one stays the deliberate workspace-wide
  // fan-out, and the gate is the same one destroy uses.
  router.post("/workspaces/:id/box-update", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const row = await workspaceById(runtime.db, context.req.param("id"));
    if (row === null || row.org_id !== principal.orgId || row.deleted_at !== null) {
      throw new HttpError(404, "workspace not found");
    }
    // A workspace has no single box to update any more. A workspace admin
    // means "every box in this workspace", which is the whole point of asking
    // at the workspace level; a plain member may only ask for their own,
    // because replacing a container kills every process inside it.
    const access = await workspaceAccess(runtime.db, principal, row);
    if (isWorkspaceAdmin(access)) {
      await changed(runtime.db, {
        q: `UPDATE machines SET box_update_requested = 1, updated_at = ?1
            WHERE workspace_id = ?2 AND state != 'destroyed' RETURNING id`,
        v: [Date.now(), row.id],
      });
      return context.body(null, 204);
    }
    if (!isWorkspaceMember(access)) throw new HttpError(403, "forbidden");
    if (principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const machine = await machineFor(runtime.db, row.id, principal.membershipId);
    if (machine === null) throw new HttpError(409, "you have no machine in this workspace");
    await requestBoxUpdate(runtime.db, machine.id);
    return context.body(null, 204);
  });
}
