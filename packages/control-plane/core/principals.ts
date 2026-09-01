import { DUMMY_HASH, hashSecret, matchesStoredHash, randomToken } from "./crypto.js";
import type { Db } from "./db.js";
import { first, rows } from "./db.js";

/**
 * Which plane a request authenticated on.
 *
 * `"machine"` is an agent inside a box, holding the box credential;
 * `"session"` is a person — a browser cookie, an operator token, a signed
 * OAuth state. It is NOT a second identity: an agent acts as its own member,
 * and every ownership and role check reads `membershipId` exactly as before.
 *
 * It exists because membership cannot tell a person from the agent on their
 * box — it is the same membership — and one rule has to: an agent may destroy
 * only the machines the agent plane created.
 */
export type PrincipalPlane = "session" | "machine";

export interface Principal {
  id: string;
  unixName: string;
  harnesses: string[];
  membershipId: string | null;
  orgId: string | null;
  role: "admin" | "member" | null;
  platformOperator: boolean;
  plane: PrincipalPlane;
}

export interface PrincipalSource {
  authenticate(request: Request, db: Db): Promise<Principal | null>;
}

interface SessionRow {
  token_hash: string;
  id: string;
  platform_operator: number;
  membership_id: string | null;
  org_id: string | null;
  role: "admin" | "member" | null;
  status: "invited" | "active" | "disabled" | null;
}

export const SESSION_COOKIE = "blitz_session";

export function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function findSessionPrincipal(
  request: Request,
  db: Db,
): Promise<Principal | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token === null) return null;
  const hash = await hashSecret(token);
  const row = await first<SessionRow>(db, {
    q: `SELECT s.token_hash, u.id, u.platform_operator, s.membership_id,
              m.org_id, m.role, m.status
       FROM sessions s
       JOIN users u ON u.id = s.principal_id
       LEFT JOIN memberships m ON m.id = s.membership_id AND m.user_id = u.id
       WHERE s.token_hash = ?1 AND s.expires_at > ?2 LIMIT 1`,
    v: [hash, Date.now()],
  });
  const matches = await matchesStoredHash(token, row?.token_hash ?? DUMMY_HASH);
  if (row === null || !matches) return null;
  if (row.membership_id !== null && row.status !== "active") return null;
  return {
    id: row.id,
    unixName: "blitz",
    harnesses: ["claude", "codex"],
    membershipId: row.membership_id,
    orgId: row.org_id,
    role: row.role,
    platformOperator: row.platform_operator === 1,
    plane: "session",
  };
}

export function createSessionPrincipalSource(): PrincipalSource {
  return { authenticate: findSessionPrincipal };
}

/** Re-resolves the principal a signed OAuth state names. A callback must never
 * trust the ambient session: it arrives from the provider, so the connect flow
 * binds the principal into its signed state at /start and loads it fresh here —
 * a user disabled or removed from the org mid-flow resolves to null, exactly
 * like an expired session. */
export async function findStatePrincipal(
  db: Db,
  userId: string,
  membershipId: string | null,
): Promise<Principal | null> {
  const row = await first<Omit<SessionRow, "token_hash"> & { membership_id: string | null }>(db, {
    q: `SELECT u.id, u.platform_operator, m.id AS membership_id,
              m.org_id, m.role, m.status
       FROM users u
       LEFT JOIN memberships m ON m.id = ?2 AND m.user_id = u.id
       WHERE u.id = ?1 LIMIT 1`,
    v: [userId, membershipId],
  });
  if (row === null) return null;
  if (membershipId !== null && row.membership_id === null) return null;
  if (row.membership_id !== null && row.status !== "active") return null;
  return {
    id: row.id,
    unixName: "blitz",
    harnesses: ["claude", "codex"],
    membershipId: row.membership_id,
    orgId: row.org_id,
    role: row.role,
    platformOperator: row.platform_operator === 1,
    plane: "session",
  };
}

export async function ensurePrincipal(db: Db, principal: Principal): Promise<void> {
  await rows(db, {
    q: `INSERT INTO principals (id, unix_name, harnesses) VALUES (?1, ?2, ?3)
        ON CONFLICT(id) DO UPDATE SET unix_name = excluded.unix_name, harnesses = excluded.harnesses`,
    v: [principal.id, principal.unixName, JSON.stringify(principal.harnesses)],
  });
}

export async function mintSession(
  db: Db,
  principal: Principal,
  ttlMs: number,
  now = Date.now(),
): Promise<string> {
  await ensurePrincipal(db, principal);
  const token = randomToken();
  await rows(db, {
    q: `INSERT INTO sessions (token_hash, principal_id, created_at, expires_at)
        VALUES (?1, ?2, ?3, ?4)`,
    v: [await hashSecret(token), principal.id, now, now + ttlMs],
  });
  return token;
}

/** Lax, not Strict. A browser withholds a Strict cookie on every top-level
 * navigation that another site started — the Google sign-in return, a search
 * result, a link in chat. The root serves the marketing page to a request with
 * no session, so under Strict a signed-in person landed on marketing every time
 * they arrived from anywhere but this origin, sign-in included.
 *
 * Lax keeps the defense that matters: it still withholds the cookie from
 * cross-site POST, PUT, and DELETE, and every state change here is one of
 * those. The two GET callbacks that do change state — sign-in and connect —
 * authenticate from their own signed state, not from this cookie. */
export function sessionCookie(token: string, ttlMs: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

