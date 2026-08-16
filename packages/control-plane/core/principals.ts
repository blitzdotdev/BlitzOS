import {
  bearerToken,
  DUMMY_HASH,
  hashSecret,
  matchesStoredHash,
  randomToken,
  safeEqualSecret,
} from "./crypto.js";
import type { Db } from "./db.js";
import { first, rows } from "./db.js";
import { isString } from "./http.js";

export interface Principal {
  id: string;
  unixName: string;
  harnesses: string[];
}

export interface PrincipalSource {
  authenticate(request: Request, db: Db): Promise<Principal | null>;
  exchange(request: Request): Promise<Principal | null>;
}

interface SessionRow {
  token_hash: string;
  id: string;
  unix_name: string;
  harnesses: string;
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

function parseHarnesses(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => isString(item))
      ? parsed
      : [];
  } catch {
    return [];
  }
}

export async function findSessionPrincipal(
  request: Request,
  db: Db,
): Promise<Principal | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token === null) return null;
  const hash = await hashSecret(token);
  const row = await first<SessionRow>(db, {
    q: `SELECT s.token_hash, p.id, p.unix_name, p.harnesses
       FROM sessions s JOIN principals p ON p.id = s.principal_id
       WHERE s.token_hash = ?1 AND s.expires_at > ?2 LIMIT 1`,
    v: [hash, Date.now()],
  });
  const matches = await matchesStoredHash(token, row?.token_hash ?? DUMMY_HASH);
  if (row === null || !matches) return null;
  return { id: row.id, unixName: row.unix_name, harnesses: parseHarnesses(row.harnesses) };
}

export function createOperatorPrincipalSource(operatorKey: string): PrincipalSource {
  return {
    authenticate: findSessionPrincipal,
    async exchange(request): Promise<Principal | null> {
      const provided = bearerToken(request) ?? request.headers.get("x-operator-key");
      if (provided === null || !(await safeEqualSecret(provided, operatorKey))) return null;
      return { id: "operator", unixName: "operator", harnesses: ["claude", "codex"] };
    },
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

export function sessionCookie(token: string, ttlMs: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
