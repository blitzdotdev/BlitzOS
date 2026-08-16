import { HttpError, isRecord, positiveInteger, readJson, requiredString } from "./http.js";
import type { Principal } from "./principals.js";
import { first, rows } from "./db.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type {
  CreateVolumeRequest,
  CreateVolumeResponse,
  DeleteVolumeResponse,
  ListVolumesResponse,
} from "./wire.js";

function createVolumeRequest(value: unknown): CreateVolumeRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  return {
    name: requiredString(value.name, "name", 128),
    sizeGb: positiveInteger(value.sizeGb, "sizeGb"),
    location: requiredString(value.location, "location", 128),
  };
}

export function addVolumeRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/volumes", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    const volume = await runtime.providers.volume.createVolume(
      createVolumeRequest(await readJson(context.req.raw)),
    );
    await rows(runtime.db, {
      q: `INSERT INTO volume_ownership
          (volume_id, org_id, created_by_membership_id, created_at)
          VALUES (?1, ?2, ?3, ?4)`,
      v: [volume.id, principal.orgId, principal.membershipId, Date.now()],
    });
    return context.json<CreateVolumeResponse>({ volume }, 201);
  });

  router.get("/volumes", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const runtime = runtimeFactory(context);
    const ownership = await rows<{ volume_id: string }>(runtime.db, {
      q: "SELECT volume_id FROM volume_ownership WHERE org_id = ?1",
      v: [principal.orgId],
    });
    const owned = new Set(ownership.map((row) => row.volume_id));
    return context.json<ListVolumesResponse>({
      volumes: (await runtime.providers.volume.listVolumes()).filter((volume) => owned.has(volume.id)),
    });
  });

  router.delete("/volumes/:id", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const id = context.req.param("id");
    const runtime = runtimeFactory(context);
    const ownership = await first<{ volume_id: string }>(runtime.db, {
      q: "SELECT volume_id FROM volume_ownership WHERE volume_id = ?1 AND org_id = ?2 LIMIT 1",
      v: [id, principal.orgId],
    });
    if (ownership === null) throw new HttpError(404, "volume not found");
    await runtime.providers.volume.deleteVolume(id);
    await rows(runtime.db, {
      q: "DELETE FROM volume_ownership WHERE volume_id = ?1 AND org_id = ?2",
      v: [id, principal.orgId],
    });
    return context.json<DeleteVolumeResponse>({ id });
  });
}
