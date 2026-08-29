import { bearerToken, DUMMY_HASH, hashSecret, matchesStoredHash, randomToken } from "./crypto.js";
import type { Db } from "./db.js";
import { changed, first, rows } from "./db.js";
import type { JsonValue } from "./http.js";
import { HttpError, isRecord, positiveInteger, readJson, requiredString } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS = 30;

/** The requests an operator token authenticates. Everything else is out of
 * scope, and the token resolves to no principal there at all.
 *
 * Two rules, both load-bearing:
 *
 *  - the method must be safe, which is what makes the credential read-only;
 *  - the path must be one of the three this token exists for — list the
 *    workspaces, read one workspace, read a box surface on port 7445, which
 *    serves files, ports and previews.
 *
 * Both lists name what is reachable rather than what is not, so a route added
 * tomorrow — or a third box port, if the box ever grows one — is out of scope
 * until someone adds it here.
 */
function withinOperatorScope(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  // pathname always starts with "/", so segments[0] is the empty string.
  const segments = pathname.split("/");
  if (segments[1] !== "workspaces") return false;
  // "/workspaces" and "/workspaces/:id".
  if (segments.length <= 3) return true;
  return segments[3] === "webapp" && segments[4] === "7445";
}

interface OperatorTokenRow {
  id: string;
  token_hash: string;
  user_id: string;
  membership_id: string;
  org_id: string;
  role: "admin" | "member";
}

/**
 * Resolves `Authorization: Bearer <token>` to the read-only principal the
 * token was minted with, or null when the request carries no operator token
 * or the token is unknown, revoked, expired, or belongs to a membership that
 * is no longer active.
 *
 * A live token used outside its scope throws 403 rather than returning null:
 * the caller holds a real credential and the useful answer is what it may not
 * do, not "unauthorized". The scope check runs after the lookup so that the
 * refusal cannot be used to probe which paths exist, and before the
 * `last_used_at` write so a refused request is not recorded as a use.
 */
export async function findOperatorTokenPrincipal(
  request: Request,
  db: Db,
): Promise<Principal | null> {
  const token = bearerToken(request);
  if (token === null) return null;
  const now = Date.now();
  const hash = await hashSecret(token);
  const row = await first<OperatorTokenRow>(db, {
    q: `SELECT t.id, t.token_hash, m.user_id, m.id AS membership_id, m.org_id, m.role
        FROM operator_tokens t
        JOIN memberships m
          ON m.id = t.created_by_membership_id AND m.status = 'active'
        WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND t.expires_at > ?2
        LIMIT 1`,
    v: [hash, now],
  });
  const matches = await matchesStoredHash(token, row?.token_hash ?? DUMMY_HASH);
  if (row === null || !matches) return null;
  if (!withinOperatorScope(request.method, new URL(request.url).pathname)) {
    throw new HttpError(403, "an operator token may only read workspaces");
  }
  // Awaited, not deferred: a standing credential is worth one write per
  // request to keep an honest record of when it was last used.
  await rows(db, {
    q: "UPDATE operator_tokens SET last_used_at = ?2 WHERE id = ?1",
    v: [row.id, now],
  });
  return {
    id: row.user_id,
    unixName: "blitz",
    // No harness: an operator token cannot create a workspace or reach the
    // agent port, so it never names one.
    harnesses: [],
    membershipId: row.membership_id,
    orgId: row.org_id,
    role: row.role,
    // The token is a read-only view of the operator's access, not the
    // operator. Minting further tokens stays with the session.
    platformOperator: false,
  };
}

interface MintedOperatorToken {
  id: string;
  label: string;
  /** The only time the plaintext exists. Only its hash is stored. */
  token: string;
  expiresAt: number;
}

interface MintRequest {
  label: string;
  ttlDays: number;
}

function parseMintRequest(body: JsonValue): MintRequest {
  if (!isRecord(body)) throw new HttpError(400, "request body must be an object");
  const label = requiredString(body.label, "label", 120);
  if (body.expiresInDays === undefined) return { label, ttlDays: DEFAULT_TTL_DAYS };
  const ttlDays = positiveInteger(body.expiresInDays, "expiresInDays");
  if (ttlDays > MAX_TTL_DAYS) {
    throw new HttpError(400, `expiresInDays must be at most ${MAX_TTL_DAYS}`);
  }
  return { label, ttlDays };
}

export function addOperatorTokenRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  /** users.platform_operator is the gate on minting. It is set on the first
   * account to sign in and by the bootstrap secret, and this is the first
   * thing in the app to read it. */
  async function requirePlatformOperator(context: CoreContext): Promise<Principal> {
    const principal = await requirePrincipal(context);
    if (!principal.platformOperator) throw new HttpError(403, "platform operator required");
    return principal;
  }

  router.post("/operator-tokens", async (context) => {
    const principal = await requirePlatformOperator(context);
    const membershipId = principal.membershipId;
    // The token carries this membership's access, so an operator who is
    // between organizations has nothing to bind one to.
    if (membershipId === null) throw new HttpError(403, "active membership required");
    const request = parseMintRequest(await readJson(context.req.raw));
    const token = randomToken();
    const id = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + request.ttlDays * DAY_MS;
    await rows(runtimeFactory(context).db, {
      q: `INSERT INTO operator_tokens
            (id, label, token_hash, created_by_membership_id, created_at, expires_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      v: [id, request.label, await hashSecret(token), membershipId, now, expiresAt],
    });
    return context.json<MintedOperatorToken>(
      { id, label: request.label, token, expiresAt },
      201,
    );
  });

  router.delete("/operator-tokens/:id", async (context) => {
    await requirePlatformOperator(context);
    const revoked = await changed(runtimeFactory(context).db, {
      q: `UPDATE operator_tokens SET revoked_at = ?2
          WHERE id = ?1 AND revoked_at IS NULL RETURNING id`,
      v: [context.req.param("id"), Date.now()],
    });
    if (revoked === 0) throw new HttpError(404, "operator token not found");
    return context.body(null, 204);
  });
}
