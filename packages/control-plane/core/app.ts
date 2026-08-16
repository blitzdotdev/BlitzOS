import { addBoxImageRoutes } from "./box-images.js";
import { addCredentialRoutes } from "./credentials/mint.js";
import { HttpError } from "./http.js";
import { addOAuthRoutes } from "./oauth.js";
import type { Principal } from "./principals.js";
import { ensurePrincipal } from "./principals.js";
import { addMicrovmHostRoutes } from "./providers/microvm.js";
import { addRegistryRoutes } from "./registry.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { addSessionRoutes } from "./sessions.js";
import { addVolumeRoutes } from "./volumes.js";
import { addWorkspaceRoutes } from "./workspaces.js";

export function installControlPlaneRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  addBoxImageRoutes(router, runtimeFactory);
  addMicrovmHostRoutes(router, runtimeFactory);

  async function requirePrincipal(context: CoreContext): Promise<Principal> {
    const runtime = runtimeFactory(context);
    const principal = await runtime.principalSource.authenticate(context.req.raw, runtime.db);
    if (principal === null) throw new HttpError(401, "unauthorized");
    await ensurePrincipal(runtime.db, principal);
    return principal;
  }

  addSessionRoutes(router, runtimeFactory, requirePrincipal);
  addOAuthRoutes(router, runtimeFactory, requirePrincipal);
  addWorkspaceRoutes(router, runtimeFactory, requirePrincipal);
  addCredentialRoutes(router, runtimeFactory, requirePrincipal);
  addVolumeRoutes(router, runtimeFactory, requirePrincipal);
  addRegistryRoutes(router, runtimeFactory);

  router.get("/machine-types", async (context) => {
    await requirePrincipal(context);
    return context.json(
      await runtimeFactory(context).providers.vmRegistry.listMachineTypes(),
    );
  });

  router.notFound((context) =>
    context.json({ error: "not found", retryAction: null }, 404),
  );
  router.onError((error, context) => {
    if (error instanceof HttpError) {
      return error.requestId === undefined
        ? context.json({ error: error.message, retryAction: null }, error.status)
        : context.json(
            { error: error.message, request_id: error.requestId },
            error.status,
          );
    }
    console.error(
      JSON.stringify({
        message: "request failed",
        error: error instanceof Error ? error.name : "unknown",
        path: new URL(context.req.url).pathname,
      }),
    );
    return context.json({ error: "internal server error", retryAction: null }, 500);
  });
}
