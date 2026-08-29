import { HttpError } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type { ListWorkspaceTemplatesResponse } from "./wire.js";

/**
 * The retired template surface.
 *
 * A workspace is its own template now (plans/MEMBER-MACHINES.md §0): it
 * carries the machine type, agent rules, repos and credentials a template used
 * to carry, and "new workspace from existing" is
 * `CreateWorkspaceRequest.cloneFromWorkspaceId`. The four
 * `workspace_template*` tables were dropped in migration 0043.
 *
 * The routes stay, and answer honestly rather than 404. The list answers an
 * empty set, because a deployed client that polls it must be able to render
 * "no templates" instead of an error banner; every write says what replaced
 * it, so somebody reading the response learns where to go.
 */
const RETIRED = "workspace templates were replaced by workspace clones; "
  + "create a workspace with cloneFromWorkspaceId";

export function addWorkspaceTemplateRoutes(
  router: CoreRouter,
  _runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/workspace-templates", async (context) => {
    await requirePrincipal(context);
    return context.json<ListWorkspaceTemplatesResponse>({ templates: [] });
  });

  const gone = async (context: CoreContext): Promise<Response> => {
    await requirePrincipal(context);
    throw new HttpError(400, RETIRED);
  };

  router.get("/workspace-templates/:id", gone);
  router.post("/workspace-templates", gone);
  router.put("/workspace-templates/:id", gone);
  router.delete("/workspace-templates/:id", gone);
}
