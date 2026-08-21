import { addAgentRuleLibraryRoutes, addAgentRulesRoutes } from "./agent-rules.js";
import { addBoxImageRoutes } from "./box-images.js";
import { addCredentialRoutes } from "./connections/mint.js";
import { addWorkspaceEnvironmentRoutes } from "./environment.js";
import { HttpError } from "./http.js";
import { addFilesRoutes } from "./files/routes.js";
import { addIdentityRoutes } from "./identity/routes.js";
import { addOAuthRoutes } from "./oauth.js";
import type { Principal } from "./principals.js";
import { addMicrovmHostRoutes } from "./compute/microvm.js";
import { addRecipeRoutes } from "./recipes.js";
import { addRegistryRoutes } from "./registry.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { addSessionRoutes } from "./sessions.js";
import { addVolumeRoutes } from "./volumes.js";
import { addWebAppStateRoutes } from "./webapp-state.js";
import { addWorkspaceTemplateRoutes } from "./workspace-templates.js";
import { addWorkspaceRoutes } from "./workspaces.js";

export function installControlPlaneRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  addBoxImageRoutes(router, runtimeFactory);
  addMicrovmHostRoutes(router, runtimeFactory);
  // Box-authenticated read of the managed agent rules; no session principal.
  addAgentRulesRoutes(router, runtimeFactory);

  async function requirePrincipal(context: CoreContext): Promise<Principal> {
    const runtime = runtimeFactory(context);
    const principal = await runtime.principalSource.authenticate(context.req.raw, runtime.db);
    if (principal === null) throw new HttpError(401, "unauthorized");
    // Login (mintSession) already upserts the principal; re-upserting here
    // added a D1 write to every authenticated request.
    return principal;
  }

  async function requireMembershipPrincipal(context: CoreContext): Promise<Principal> {
    const principal = await requirePrincipal(context);
    if (principal.membershipId === null) throw new HttpError(403, "active membership required");
    return principal;
  }

  addSessionRoutes(router, runtimeFactory, requirePrincipal);
  addIdentityRoutes(router, runtimeFactory, requirePrincipal);
  addOAuthRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addWebAppStateRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addAgentRuleLibraryRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addWorkspaceTemplateRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addRecipeRoutes(router, runtimeFactory, requireMembershipPrincipal);
  // Box-authenticated, so it is registered ahead of the session-authenticated
  // /workspaces/:id routes it shares a prefix with.
  addWorkspaceEnvironmentRoutes(router, runtimeFactory);
  addWorkspaceRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addCredentialRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addVolumeRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addFilesRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addRegistryRoutes(router, runtimeFactory);

  router.get("/machine-types", async (context) => {
    await requireMembershipPrincipal(context);
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
    // TODO(house-canon): Route structured core logs through the canonical logger.
    // `detail` carries the thrown message so config faults (for example a
    // malformed CRED_MASTER_KEY) are diagnosable from the 500 log line.
    console.error(
      JSON.stringify({
        message: "request failed",
        error: error instanceof Error ? error.name : "unknown",
        detail: error instanceof Error ? error.message : "unknown",
        path: new URL(context.req.url).pathname,
      }),
    );
    return context.json({ error: "internal server error", retryAction: null }, 500);
  });
}
