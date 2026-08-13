import { hashSecret } from "./crypto.js";
import { rows } from "./db.js";
import type { Principal } from "./principals.js";
import {
  clearSessionCookie,
  cookieValue,
  mintSession,
  SESSION_COOKIE,
  sessionCookie,
} from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";

export function addSessionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/sessions", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await runtime.principalSource.exchange(context.req.raw);
    if (principal === null) {
      return context.json({ error: "unauthorized", retryAction: null }, 401);
    }
    const token = await mintSession(runtime.db, principal, runtime.vars.sessionTtlMs);
    context.header("Set-Cookie", sessionCookie(token, runtime.vars.sessionTtlMs));
    return context.body(null, 204);
  });

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
