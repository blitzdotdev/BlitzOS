import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { addFolderRoutes } from "./folders.js";
import { addFolderObjectRoutes } from "./objects.js";

export function addFilesRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  addFolderRoutes(router, runtimeFactory, requirePrincipal);
  addFolderObjectRoutes(router, runtimeFactory, requirePrincipal);
}
