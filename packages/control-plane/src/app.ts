import { Hono } from "hono";
import type { Context } from "hono";
import { HttpError } from "./http.js";
import { addOAuthRoutes } from "./oauth.js";
import type { Principal } from "./principals.js";
import { ensurePrincipal } from "./principals.js";
import { addRegistryRoutes } from "./registry.js";
import { addSessionRoutes } from "./sessions.js";
import type { AppDependencies, AppEnv, ControlPlaneApp } from "./types.js";
import { addVolumeRoutes } from "./volumes.js";
import { addWorkspaceRoutes } from "./workspaces.js";

export function createApp(deps: AppDependencies): ControlPlaneApp {
  const app = new Hono<AppEnv>();

  async function requirePrincipal(c: Context<AppEnv>): Promise<Principal> {
    const principal = await deps.principalSource.authenticate(c.req.raw, c.env.DB);
    if (principal === null) throw new HttpError(401, "unauthorized");
    await ensurePrincipal(c.env.DB, principal);
    return principal;
  }

  addSessionRoutes(app, (request) => deps.principalSource.exchange(request), requirePrincipal);
  addOAuthRoutes(app, requirePrincipal);
  addWorkspaceRoutes(app, deps, requirePrincipal);
  addVolumeRoutes(app, deps.volumeProvider, requirePrincipal);
  addRegistryRoutes(app);

  app.get("/machine-types", async (c) => {
    await requirePrincipal(c);
    return c.json({ machineTypes: await deps.vmProvider.listMachineTypes() });
  });

  app.notFound((c) => c.json({ error: "not found", retryAction: null }, 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message, retryAction: null }, error.status);
    }
    console.error(
      JSON.stringify({
        message: "request failed",
        error: error instanceof Error ? error.name : "unknown",
        path: new URL(c.req.url).pathname,
      }),
    );
    return c.json({ error: "internal server error", retryAction: null }, 500);
  });
  return app;
}
