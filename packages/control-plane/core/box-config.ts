import { changed, first } from "./db.js";
import {
  HttpError,
  isBoolean,
  isRecord,
  isString,
  readJson,
  requiredString,
  type JsonValue,
} from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import { machineById, machineFor } from "./machines.js";
import type { BoxIdentity } from "./types.js";
import {
  isWorkspaceAdmin,
  isWorkspaceMember,
  workspaceAccess,
} from "./workspace-access.js";
import { machineView, workspaceById } from "./workspace-records.js";
import {
  BOX_PAYLOAD_OUTCOMES,
  BOX_UPDATE_OUTCOMES,
  type BoxConfigResponse,
  type BoxFeatures,
  type BoxPayloadConfig,
  type BoxPayloadOutcome,
  type BoxPayloadResultRequest,
  type BoxUpdateOutcome,
  type BoxUpdateResultRequest,
  type MachineResponse,
  type SetMachinePayloadHoldRequest,
} from "./wire.js";

// The box-config contract (see wire.ts and packages/schema/fixtures/box-config/):
// the VM host polls GET /workspaces/self/box-config with the box credential,
// refreshes /var/lib/blitz/origin from `controlPlaneOrigin` on every poll, and
// replaces the container only when `updateRequested` is set. It then reports
// { ref, outcome } to POST /workspaces/self/box-update-result, which clears the
// flag and stores the ref on the machine row. The in-box payload updater reads
// the additive deployment pin and reports its result to the neighboring route.
// Image replacement remains the cloud-VM path (Hetzner/AWS user-data); the
// payload channel authenticates the box itself and is provider-independent.

/** The character set of a docker image reference or of the R2 tarball https
 * URL BOX_IMAGE_REF may hold — the same alphabet the bootstrap's embedded
 * manifest validator pins for `imageTag`. One token, no whitespace, so a ref
 * can cross the bash boundary unquoted-safe. */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u;
const PAYLOAD_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const PAYLOAD_MANIFEST_URL = /^https?:\/\/[^/\s?#]+(?:[/?][^\s#]*)?$/u;

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

/** Builds the in-place payload pin without reading the manifest. The deploy
 * publishes and pins both values together, so request-time config stays a
 * pure projection of Worker vars. An empty manifest ref is the documented
 * off switch; a half or malformed non-empty pin is a deployment error. */
export function boxPayloadConfigFromEnv(
  manifestUrlValue: string,
  versionValue: string,
): BoxPayloadConfig | null {
  if (manifestUrlValue === "") return null;
  if (!PAYLOAD_MANIFEST_URL.test(manifestUrlValue)) {
    throw new Error("BOX_PAYLOAD_REF must be an absolute http(s) manifest URL or empty");
  }
  if (!PAYLOAD_VERSION.test(versionValue)) {
    throw new Error("BOX_PAYLOAD_VERSION must be a version token when BOX_PAYLOAD_REF is set");
  }
  return { version: versionValue, manifestUrl: manifestUrlValue };
}

/** Parses the deployment feature switch at the Worker boundary. Only the
 * literal string "1" enables Lody; absent and every other value are the safe
 * off default. */
export function boxFeaturesFromEnv(value: string | null | undefined): BoxFeatures {
  return { lodySessions: value === "1" };
}

function boxLodySessionsBinding(context: CoreContext): string | undefined {
  const value = Object.entries(context.env)
    .find(([name]) => name === "BOX_LODY_SESSIONS")?.[1];
  return isString(value) ? value : undefined;
}

function boxUpdateOutcome(value: string): BoxUpdateOutcome {
  const outcome = BOX_UPDATE_OUTCOMES.find((known) => known === value);
  if (outcome === undefined) {
    throw new HttpError(400, `outcome must be one of ${BOX_UPDATE_OUTCOMES.join(", ")}`);
  }
  return outcome;
}

function boxPayloadOutcome(value: string): BoxPayloadOutcome {
  const outcome = BOX_PAYLOAD_OUTCOMES.find((known) => known === value);
  if (outcome === undefined) {
    throw new HttpError(400, `outcome must be one of ${BOX_PAYLOAD_OUTCOMES.join(", ")}`);
  }
  return outcome;
}

function payloadVersion(value: JsonValue | undefined, field: string): string {
  const version = requiredString(value, field, 512);
  if (!PAYLOAD_VERSION.test(version)) {
    throw new HttpError(400, `${field} must be a version token`);
  }
  return version;
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

/** Mirrors the box-payload result contract parser. Unknown keys are tolerated
 * so a newer updater can add diagnostics without losing the four fields this
 * control plane knows how to persist. `detail` may be empty; the whole request
 * is already bounded to 4 KiB at the HTTP boundary. */
export function parseBoxPayloadResult(value: JsonValue): BoxPayloadResultRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  if (!isString(value.detail)) throw new HttpError(400, "detail must be a string");
  return {
    version: payloadVersion(value.version, "version"),
    daemonVersion: payloadVersion(value.daemonVersion, "daemonVersion"),
    outcome: boxPayloadOutcome(requiredString(value.outcome, "outcome", 64)),
    detail: value.detail,
  };
}

function parseSetMachinePayloadHold(value: JsonValue): SetMachinePayloadHoldRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  if (!isBoolean(value.payloadHold)) {
    throw new HttpError(400, "payloadHold must be a boolean");
  }
  return { payloadHold: value.payloadHold };
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
    const row = await first<{ box_update_requested: number; payload_hold: number }>(runtime.db, {
      q: "SELECT box_update_requested, payload_hold FROM machines WHERE id = ?1 LIMIT 1",
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
      payload: row.payload_hold === 1
        ? null
        : boxPayloadConfigFromEnv(
            runtime.vars.boxPayloadRef,
            runtime.vars.boxPayloadVersion,
          ),
      features: boxFeaturesFromEnv(
        boxLodySessionsBinding(context),
      ),
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

  // The in-box updater's last status. Its versions name what is running after
  // the attempt, never an unverified, deferred, or rolled-back target; detail
  // names a staged or attempted pin. This is an idempotent projection onto the
  // machine row: retrying the same report creates nothing and returns the same
  // success, while refreshing when the plane last heard it.
  router.post("/workspaces/self/payload-result", async (context) => {
    const box = await requireWorkspaceBox(context, runtimeFactory);
    const input = parseBoxPayloadResult(await readJson(context.req.raw, 4 * 1024));
    await changed(runtimeFactory(context).db, {
      q: `UPDATE machines
          SET payload_reported = ?1, daemon_reported = ?2,
              payload_outcome = ?3, payload_reported_at = ?4
          WHERE id = ?5 RETURNING id`,
      v: [
        input.version,
        input.daemonVersion,
        input.outcome,
        Date.now(),
        box.id,
      ],
    });
    return context.body(null, 204);
  });

  /** Holds or resumes deployment-wide payload delivery for one machine.
   * Workspace-admin only: the write changes shipped code on somebody else's
   * box even though applying it does not replace their container. */
  router.patch("/machines/:machineId", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const machine = await machineById(runtime.db, context.req.param("machineId"));
    if (machine === null) throw new HttpError(404, "machine not found");
    const workspace = await workspaceById(runtime.db, machine.workspace_id);
    if (workspace === null || workspace.org_id !== principal.orgId) {
      throw new HttpError(404, "machine not found");
    }
    if (!isWorkspaceAdmin(await workspaceAccess(runtime.db, principal, workspace))) {
      throw new HttpError(403, "workspace admin required");
    }
    const input = parseSetMachinePayloadHold(await readJson(context.req.raw, 4 * 1024));
    await changed(runtime.db, {
      q: `UPDATE machines SET payload_hold = ?1, updated_at = ?2
          WHERE id = ?3 RETURNING id`,
      v: [input.payloadHold ? 1 : 0, Date.now(), machine.id],
    });
    const updated = await machineById(runtime.db, machine.id);
    if (updated === null) throw new Error("machine disappeared during payload hold update");
    return context.json<MachineResponse>({ machine: machineView(updated) });
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
