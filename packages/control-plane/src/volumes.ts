import type {
  CreateVolumeRequest,
  CreateVolumeResponse,
  DeleteVolumeResponse,
  ListVolumesResponse,
} from "@blitzos/schema";
import type { Context, Hono } from "hono";
import { HttpError, isRecord, positiveInteger, readJson, requiredString } from "./http.js";
import type { Principal } from "./principals.js";
import type { AppEnv } from "./types.js";
import type { VolumeProvider } from "./providers/types.js";

function createVolumeRequest(value: unknown): CreateVolumeRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  return {
    name: requiredString(value.name, "name", 128),
    sizeGb: positiveInteger(value.sizeGb, "sizeGb"),
    location: requiredString(value.location, "location", 128),
  };
}

export function addVolumeRoutes(
  app: Hono<AppEnv>,
  provider: VolumeProvider,
  requirePrincipal: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.post("/volumes", async (c) => {
    await requirePrincipal(c);
    const volume = await provider.createVolume(createVolumeRequest(await readJson(c.req.raw)));
    return c.json<CreateVolumeResponse>({ volume }, 201);
  });

  app.get("/volumes", async (c) => {
    await requirePrincipal(c);
    return c.json<ListVolumesResponse>({ volumes: await provider.listVolumes() });
  });

  app.delete("/volumes/:id", async (c) => {
    await requirePrincipal(c);
    const id = c.req.param("id");
    await provider.deleteVolume(id);
    return c.json<DeleteVolumeResponse>({ id });
  });
}
