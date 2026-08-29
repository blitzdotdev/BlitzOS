import { addAgentRuleLibraryRoutes, addAgentRulesRoutes } from "./agent-rules.js";
import { addBoxConfigRoutes } from "./box-config.js";
import { addBoxImageRoutes } from "./box-images.js";
import { addCredentialRoutes } from "./connections/mint.js";
import { addWorkspaceEnvironmentRoutes } from "./environment.js";
import { addEntitlementsRoutes, SeatLimitReached, seatLimitEnvelope } from "./entitlements.js";
import { frameworkHttpError, HttpError } from "./http.js";
import { addFilesRoutes } from "./files/routes.js";
import { addMachineRoutes } from "./machines.js";
import { addMachineStatsRoutes } from "./machine-stats.js";
import { addIdentityRoutes } from "./identity/routes.js";
import { addOAuthRoutes } from "./oauth.js";
import { addOperatorTokenRoutes, findOperatorTokenPrincipal } from "./operator-tokens.js";
import type { Principal } from "./principals.js";
import { addMicrovmHostRoutes } from "./compute/microvm.js";
import { addOrgComputeCredentialRoutes } from "./compute/org-credentials.js";
import { addOrgUsageCaptureRoutes } from "./recipes.js";
import { addRegistryRoutes } from "./registry.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import { addSessionRoutes } from "./sessions.js";
import { addVersionRoutes } from "./version.js";
import { addVolumeRoutes } from "./volumes.js";
import { addWebAppStateRoutes } from "./webapp-state.js";
import { addWorkspaceCredentialRoutes } from "./workspace-credentials.js";
import { addWorkspaceMemberRoutes } from "./workspace-members.js";
import { addWorkspaceSettingsRoutes } from "./workspace-settings.js";
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
  // Unauthenticated by construction: it calls no principal helper. Deploy
  // tooling must read it without a session.
  addVersionRoutes(router, runtimeFactory);
  addBoxImageRoutes(router, runtimeFactory);
  addMicrovmHostRoutes(router, runtimeFactory);
  // Box-authenticated read of the managed agent rules; no session principal.
  addAgentRulesRoutes(router, runtimeFactory);

  // The one place a request becomes a Principal, so the one place the
  // read-only operator token is honoured. Routes never see the credential:
  // each add*Routes call below is handed this function, or the membership
  // wrapper that calls it, and findOperatorTokenPrincipal refuses everything
  // outside the token's scope before it hands a principal back. A route
  // added later that reaches for runtime.principalSource instead gets the
  // session-cookie source alone, where an operator token authenticates
  // nothing — so a new route fails closed rather than open either way.
  async function requirePrincipal(context: CoreContext): Promise<Principal> {
    const runtime = runtimeFactory(context);
    const principal = await runtime.principalSource.authenticate(context.req.raw, runtime.db);
    // Login (mintSession) already upserts the principal; re-upserting here
    // added a D1 write to every authenticated request.
    if (principal !== null) return principal;
    const operator = await findOperatorTokenPrincipal(context.req.raw, runtime.db);
    if (operator === null) throw new HttpError(401, "unauthorized");
    return operator;
  }

  async function requireMembershipPrincipal(context: CoreContext): Promise<Principal> {
    const principal = await requirePrincipal(context);
    if (principal.membershipId === null) throw new HttpError(403, "active membership required");
    return principal;
  }

  addSessionRoutes(router, runtimeFactory, requirePrincipal);
  addOperatorTokenRoutes(router, runtimeFactory, requirePrincipal);
  addIdentityRoutes(router, runtimeFactory, requirePrincipal);
  addEntitlementsRoutes(router, runtimeFactory, requirePrincipal);
  addOrgComputeCredentialRoutes(router, runtimeFactory, requirePrincipal);
  addOAuthRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addWebAppStateRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addAgentRuleLibraryRoutes(router, runtimeFactory, requireMembershipPrincipal);
  // Templates and Recipes are disabled product-wide (2026-08-29). Both
  // registrations stay here, commented, so the decision is visible where the
  // surface used to be mounted and turning either back on is one line.
  //   - Templates: the object is gone. A workspace is its own template, and
  //     "new workspace from existing" is CreateWorkspaceRequest.cloneFromWorkspaceId
  //     (plans/MEMBER-MACHINES.md §0). Migration 0043 dropped the four tables.
  //   - Recipes: disabled 2026-08-29, feature hidden. The code and the
  //     `recipes` rows are untouched; only the routes are unmounted.
  // addWorkspaceTemplateRoutes(router, runtimeFactory, requireMembershipPrincipal);
  // addRecipeRoutes(router, runtimeFactory, requireMembershipPrincipal);
  //
  // Usage capture is not a recipe surface — it is an org switch that fills a
  // Drive folder — so it stays mounted.
  addOrgUsageCaptureRoutes(router, runtimeFactory, requireMembershipPrincipal);
  // Box-authenticated, so it is registered ahead of the session-authenticated
  // /workspaces/:id routes it shares a prefix with.
  addWorkspaceEnvironmentRoutes(router, runtimeFactory);
  // Mostly box-authenticated (/workspaces/self/*), registered ahead for the
  // same reason; its one session route (/workspaces/:id/box-update) collides
  // with nothing.
  addBoxConfigRoutes(router, runtimeFactory, requireMembershipPrincipal);
  // Box-authenticated too, and registered here for the same prefix reason: the
  // guest's own disk report (packages/schema/fixtures/machine-stats/).
  addMachineStatsRoutes(router, runtimeFactory);
  // Registered before addWorkspaceRoutes: /workspaces/:id/members and
  // /workspaces/:id/credentials are literal paths under the same prefix.
  addWorkspaceMemberRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addWorkspaceCredentialRoutes(router, runtimeFactory, requireMembershipPrincipal);
  // Same reason: /workspaces/:id/repos is a literal path under the prefix
  // addWorkspaceRoutes registers its parameterised routes on.
  addWorkspaceSettingsRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addWorkspaceRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addMachineRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addCredentialRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addVolumeRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addFilesRoutes(router, runtimeFactory, requireMembershipPrincipal);
  addRegistryRoutes(router, runtimeFactory);

  router.get("/machine-types", async (context) => {
    const principal = await requireMembershipPrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const runtime = runtimeFactory(context);
    const computeDescriptors = new Set(runtime.providers.compute.descriptors());
    const registeredComputeProviderIds = new Set(runtime.providers.vmRegistry.all()
      .filter((provider) => computeDescriptors.has(provider))
      .map(({ id }) => id));
    const providerStatuses = (await runtime.providers.compute.providerStatuses(principal.orgId))
      .filter(({ providerId }) => registeredComputeProviderIds.has(providerId));
    const excludedProviderIds = new Set(providerStatuses.flatMap((status) =>
      status.access === "credential-required" ? [status.providerId] : []));
    return context.json({
      ...await runtime.providers.vmRegistry.listMachineTypes(
        principal.orgId,
        excludedProviderIds,
      ),
      providerStatuses,
    });
  });

  router.notFound((context) =>
    context.json({ error: "not found", retryAction: null }, 404),
  );
  router.onError((error, context) => {
    // The seat-gate refusal. It carries a retryAction and a checkout link, so
    // it cannot travel as an HttpError: that envelope is fixed at
    // `retryAction: null` and every other caller depends on it.
    if (error instanceof SeatLimitReached) {
      return context.json(seatLimitEnvelope(error), 402);
    }
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
