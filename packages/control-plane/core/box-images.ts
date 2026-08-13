import { streamBlob } from "./blobs.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";

async function streamBoxImage(
  context: CoreContext,
  runtimeFactory: RuntimeFactory,
  key: string,
): Promise<Response> {
  const response = await streamBlob(
    runtimeFactory(context).blobs,
    key,
    context.req.raw,
  );
  return (
    response ?? context.json({ error: "not found", retryAction: null }, 404)
  );
}

export function addBoxImageRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.get("/box-image", (context) =>
    streamBoxImage(context, runtimeFactory, "box-image"),
  );
  router.get("/box-image/:part", (context) =>
    streamBoxImage(
      context,
      runtimeFactory,
      `box-image/${context.req.param("part")}`,
    ),
  );
}
