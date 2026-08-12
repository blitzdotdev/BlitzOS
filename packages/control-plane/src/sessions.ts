import type { Context, Hono } from "hono";
import { hashSecret } from "./crypto.js";
import type { Principal } from "./principals.js";
import {
  clearSessionCookie,
  cookieValue,
  mintSession,
  SESSION_COOKIE,
  sessionCookie,
} from "./principals.js";
import type { AppEnv } from "./types.js";

export function addSessionRoutes(
  app: Hono<AppEnv>,
  exchangePrincipal: (request: Request) => Promise<Principal | null>,
  requirePrincipal: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.post("/sessions", async (c) => {
    const principal = await exchangePrincipal(c.req.raw);
    if (principal === null) return c.json({ error: "unauthorized", retryAction: null }, 401);
    const token = await mintSession(c.env.DB, principal);
    c.header("Set-Cookie", sessionCookie(token));
    return c.body(null, 204);
  });

  app.delete("/sessions", async (c) => {
    await requirePrincipal(c);
    const token = cookieValue(c.req.raw, SESSION_COOKIE);
    if (token !== null) {
      await c.env.DB
        .prepare("DELETE FROM sessions WHERE token_hash = ?1")
        .bind(await hashSecret(token))
        .run();
    }
    c.header("Set-Cookie", clearSessionCookie());
    return c.body(null, 204);
  });
}
