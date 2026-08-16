import { hashSecret } from "./crypto.js";
import { first, rows } from "./db.js";
import { HttpError, isRecord, readJson, requiredString } from "./http.js";
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

  router.post("/sessions/switch-org", async (context) => {
    const principal = await requirePrincipal(context);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const orgId = requiredString(value.orgId, "orgId", 256);
    const token = cookieValue(context.req.raw, SESSION_COOKIE);
    if (token === null) throw new HttpError(401, "unauthorized");
    const runtime = runtimeFactory(context);
    const membership = await first<{ id: string }>(runtime.db, {
      q: `SELECT id FROM memberships
          WHERE user_id = ?1 AND org_id = ?2 AND status = 'active' LIMIT 1`,
      v: [principal.id, orgId],
    });
    if (membership === null) throw new HttpError(403, "no active membership in organization");
    const updated = await rows<{ token_hash: string }>(runtime.db, {
      q: `UPDATE sessions SET membership_id = ?1, created_at = ?2
          WHERE token_hash = ?3 AND principal_id = ?4 RETURNING token_hash`,
      v: [membership.id, Date.now(), await hashSecret(token), principal.id],
    });
    if (updated.length !== 1) throw new HttpError(401, "unauthorized");
    return context.body(null, 204);
  });
}
