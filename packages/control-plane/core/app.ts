import { addAgentRuleLibraryRoutes, addAgentRulesRoutes } from "./agent-rules.js";
import { addBoxImageRoutes } from "./box-images.js";
import { addCredentialRoutes } from "./connections/mint.js";
import { addWorkspaceEnvironmentRoutes } from "./environment.js";
import { frameworkHttpError, HttpError } from "./http.js";
import { addFilesRoutes } from "./files/routes.js";
import { addIdentityRoutes } from "./identity/routes.js";
import { addOAuthRoutes } from "./oauth.js";
import type { Principal } from "./principals.js";
import { addMicrovmHostRoutes } from "./compute/microvm.js";
import { addRecipeRoutes } from "./recipes.js";
import { addRecipeTriggerRoutes } from "./recipe-triggers.js";
import { addRegistryRoutes } from "./registry.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { addSessionRoutes } from "./sessions.js";
import { addVolumeRoutes } from "./volumes.js";
import { addWebAppStateRoutes } from "./webapp-state.js";
import { addWorkspaceTemplateRoutes } from "./workspace-templates.js";
import { addWorkspaceRoutes } from "./workspaces.js";

// TODO(house-canon): Route structured core logs through the canonical logger.
// `detail` carries the thrown message so config faults (for example a
// malformed CRED_MASTER_KEY) are diagnosable from the 500 log line.
function logRequestFailure(error: Error, context: CoreContext): void {
  console.error(
    JSON.stringify({
      message: "request failed",
      error: error instanceof Error ? error.name : "unknown",
      detail: error instanceof Error ? error.message : "unknown",
      path: new URL(context.req.url).pathname,
    }),
  );
}

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
  addRecipeTriggerRoutes(router, runtimeFactory, requireMembershipPrincipal);
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
    // Both targets build their app with teenyHono, which installs teenybase's
    // error handler, and both then call this function. Hono keeps exactly one
    // error handler and the last registration wins, so this handler is the only
    // one either target has. Flattening a framework throw to 500 therefore
    // erased the platform's own statuses: teenybase reports a missing row by
    // throwing ProcessError("Not found", 404), and the managed asset uploader
    // reads 404 — and only 404 — as "row absent", so it died on its first
    // asset (run-4 report, B2). Four unrelated faults also arrived wearing one
    // opaque envelope, which is what made that run's root cause expensive.
    const framework = frameworkHttpError(error);
    if (framework !== null) {
      // A framework 4xx has already told the client everything useful. A 5xx
      // has not, so it keeps the log line an opaque 500 used to get.
      if (framework.status >= 500) logRequestFailure(error, context);
      return context.json({ error: framework.message, retryAction: null }, framework.status);
    }
    logRequestFailure(error, context);
    return context.json({ error: "internal server error", retryAction: null }, 500);
  });
}
