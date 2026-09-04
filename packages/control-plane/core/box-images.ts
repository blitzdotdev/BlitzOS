import { streamBlob } from "./blobs.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";

const BOX_IMAGE_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BOX_IMAGE_PART_PATTERN = /^part-[0-9]{3,}$/u;
const BOX_PAYLOAD_PARTS = new Set([
  "manifest.json",
  "payload.tar.gz",
  "daemon.tar.gz",
]);

function boxImageNotFound(context: CoreContext): Response {
  return context.json({ error: "not found", retryAction: null }, 404);
}

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
  return response ?? boxImageNotFound(context);
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
  router.get("/box-image/:release/:part", (context) => {
    const release = context.req.param("release");
    const part = context.req.param("part");
    if (
      !BOX_IMAGE_RELEASE_PATTERN.test(release)
      || (part !== "manifest.json" && !BOX_IMAGE_PART_PATTERN.test(part))
    ) {
      return boxImageNotFound(context);
    }
    return streamBoxImage(
      context,
      runtimeFactory,
      `box-image/${release}/${part}`,
    );
  });
  // Public like the image archive: a guest must be able to fetch its pinned
  // payload before any session principal exists. Only the bounded, versioned
  // object names are exposed from the shared R2 bucket.
  router.get("/box-payload/:version/:part", (context) => {
    const version = context.req.param("version");
    const part = context.req.param("part");
    if (!BOX_IMAGE_RELEASE_PATTERN.test(version) || !BOX_PAYLOAD_PARTS.has(part)) {
      return boxImageNotFound(context);
    }
    return streamBoxImage(
      context,
      runtimeFactory,
      `box-payload/${version}/${part}`,
    );
  });
}
