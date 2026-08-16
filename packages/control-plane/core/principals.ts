import { DUMMY_HASH, hashSecret, matchesStoredHash, randomToken } from "./crypto.js";
import type { Db } from "./db.js";
import { first, rows } from "./db.js";
import { isString } from "./http.js";

export interface Principal {
  id: string;
  unixName: string;
  harnesses: string[];
  membershipId: string | null;
  orgId: string | null;
  role: "admin" | "member" | null;
  platformOperator: boolean;
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
  };
}

export function createSessionPrincipalSource(): PrincipalSource {
  return { authenticate: findSessionPrincipal };
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

export async function mintUserSession(
  db: Db,
  userId: string,
  membershipId: string | null,
  ttlMs: number,
  now = Date.now(),
): Promise<string> {
  const token = randomToken();
  await rows(db, {
    q: `INSERT INTO sessions
        (token_hash, principal_id, created_at, expires_at, membership_id)
        VALUES (?1, ?2, ?3, ?4, ?5)`,
    v: [await hashSecret(token), userId, now, now + ttlMs, membershipId],
  });
  return token;
}

export function sessionCookie(token: string, ttlMs: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
