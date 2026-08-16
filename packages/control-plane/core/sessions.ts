import { hashSecret } from "./crypto.js";
import { rows } from "./db.js";
import {
  clearSessionCookie,
  cookieValue,
  SESSION_COOKIE,
} from "./principals.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";

export function addSessionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.delete("/sessions", async (context) => {
    await requirePrincipal(context);
    const token = cookieValue(context.req.raw, SESSION_COOKIE);
    if (token !== null) {
      await rows(runtimeFactory(context).db, {
        q: "DELETE FROM sessions WHERE token_hash = ?1",
        v: [await hashSecret(token)],
      });
    }
    context.header("Set-Cookie", clearSessionCookie());
    return context.body(null, 204);
  });
}
