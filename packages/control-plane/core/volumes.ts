import { HttpError, isRecord, positiveInteger, readJson, requiredString } from "./http.js";
import type { Principal } from "./principals.js";
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
    await requirePrincipal(context);
    const volume = await runtimeFactory(context).providers.volume.createVolume(
      createVolumeRequest(await readJson(context.req.raw)),
    );
    return context.json<CreateVolumeResponse>({ volume }, 201);
  });

  router.get("/volumes", async (context) => {
    await requirePrincipal(context);
    return context.json<ListVolumesResponse>({
      volumes: await runtimeFactory(context).providers.volume.listVolumes(),
    });
  });

  router.delete("/volumes/:id", async (context) => {
    await requirePrincipal(context);
    const id = context.req.param("id");
    await runtimeFactory(context).providers.volume.deleteVolume(id);
    return context.json<DeleteVolumeResponse>({ id });
  });
}
