import { randomToken } from "../crypto.js";
import type { Db } from "../db.js";
import { first, rows, transaction } from "../db.js";
import { HttpError, isRecord, type JsonValue, readJson, requiredString } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { INVITE_TTL_DAYS } from "../wire.js";

type InviteRole = "admin" | "member";
type InviteState = "ready" | "redeemed" | "revoked" | "expired";

export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1_000;

interface InviteRow {
  id: string;
  code_hash: string;
  email: string | null;
  target_org_id: string;
  role: InviteRole;
  state: InviteState;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  org_name: string;
  creator_name: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function inviteCodeHash(code: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(code),
  )));
}

function inviteRole(value: JsonValue | undefined): InviteRole {
  if (value !== "admin" && value !== "member") {
    throw new HttpError(400, "role must be admin or member");
  }
  return value;
}

function optionalEmail(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  const email = requiredString(value, "email", 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw new HttpError(400, "email must be valid");
  return email;
}

function inviteView(row: InviteRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    redeemedAt: row.redeemed_at,
    org: { id: row.target_org_id, name: row.org_name },
    createdBy: row.creator_name,
  };
}

function requireAdmin(principal: Principal): string {
  if (principal.orgId === null || principal.membershipId === null || principal.role !== "admin") {
    throw new HttpError(403, "organization admin required");
  }
  return principal.orgId;
}

async function expireInvites(db: Db, now: number, orgId?: string): Promise<void> {
  await rows(db, {
    q: `UPDATE invites SET state = 'expired'
        WHERE state = 'ready' AND expires_at <= ?1${orgId === undefined ? "" : " AND target_org_id = ?2"}`,
    v: orgId === undefined ? [now] : [now, orgId],
  });
}

async function inviteByHash(db: Db, hash: string): Promise<InviteRow | null> {
  return first<InviteRow>(db, {
    q: `SELECT invite.*, org.name AS org_name, creator.name AS creator_name
        FROM invites invite
        JOIN orgs org ON org.id = invite.target_org_id
        JOIN memberships creator_membership ON creator_membership.id = invite.created_by_membership_id
        JOIN users creator ON creator.id = creator_membership.user_id
        WHERE invite.code_hash = ?1 LIMIT 1`,
    v: [hash],
  });
}

export async function redeemInviteSession(
  db: Db,
  code: string,
  userId: string,
  email: string,
  sessionTokenHash: string,
  sessionTtlMs: number,
  now = Date.now(),
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) throw new HttpError(400, "invalid invite code");
  const hash = await inviteCodeHash(code);
  await expireInvites(db, now);
  const invite = await inviteByHash(db, hash);
  if (invite === null) throw new HttpError(404, "invite not found");
  if (invite.state !== "ready") throw new HttpError(409, `invite is ${invite.state}`);
  if (invite.email !== null && invite.email !== email) {
    throw new HttpError(403, "invite is for a different email address");
  }
  const existing = await first<{ id: string }>(db, {
    q: "SELECT id FROM memberships WHERE user_id = ?1 AND org_id = ?2 LIMIT 1",
    v: [userId, invite.target_org_id],
  });
  const membershipId = existing?.id ?? crypto.randomUUID();
  const result = await transaction(db, [
    {
      q: `INSERT INTO memberships (id, user_id, org_id, role, status)
          SELECT ?1, ?2, target_org_id, role, 'active' FROM invites
          WHERE code_hash = ?3 AND state = 'ready' AND expires_at > ?4
            AND (email IS NULL OR email = ?5)
          ON CONFLICT(user_id, org_id) DO UPDATE SET
            role = excluded.role, status = 'active'
          RETURNING id`,
      v: [membershipId, userId, hash, now, email],
    },
    {
      q: `UPDATE invites SET state = 'redeemed', redeemed_by_user_id = ?1,
              redeemed_at = ?2
          WHERE code_hash = ?3 AND state = 'ready' AND expires_at > ?2
            AND (email IS NULL OR email = ?4)
          RETURNING id`,
      v: [userId, now, hash, email],
    },
    {
      q: `INSERT INTO sessions
          (token_hash, principal_id, created_at, expires_at, membership_id)
          SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM invites WHERE code_hash = ?6 AND state = 'redeemed'
              AND redeemed_by_user_id = ?2 AND redeemed_at = ?3
          ) RETURNING token_hash`,
      v: [sessionTokenHash, userId, now, now + sessionTtlMs, membershipId, hash],
    },
  ]);
  if (result[0]?.length !== 1 || result[1]?.length !== 1 || result[2]?.length !== 1) {
    throw new HttpError(409, "invite could not be redeemed");
  }
  return membershipId;
}

export function addInviteRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/invite/:code", async (context) => {
    const code = context.req.param("code");
    if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) throw new HttpError(404, "invite not found");
    const runtime = runtimeFactory(context);
    const now = Date.now();
    await expireInvites(runtime.db, now);
    const invite = await inviteByHash(runtime.db, await inviteCodeHash(code));
    if (invite === null) throw new HttpError(404, "invite not found");
    return context.json({ invite: inviteView(invite), ttlDays: INVITE_TTL_DAYS });
  });

  router.get("/invites", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireAdmin(principal);
    const runtime = runtimeFactory(context);
    await expireInvites(runtime.db, Date.now(), orgId);
    const invites = await rows<InviteRow>(runtime.db, {
      q: `SELECT invite.*, org.name AS org_name, creator.name AS creator_name
          FROM invites invite
          JOIN orgs org ON org.id = invite.target_org_id
          JOIN memberships creator_membership ON creator_membership.id = invite.created_by_membership_id
          JOIN users creator ON creator.id = creator_membership.user_id
          WHERE invite.target_org_id = ?1
          ORDER BY invite.created_at DESC, invite.id`,
      v: [orgId],
    });
    return context.json({ invites: invites.map(inviteView), ttlDays: INVITE_TTL_DAYS });
  });

  router.post("/invites", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireAdmin(principal);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const role = inviteRole(value.role);
    const email = optionalEmail(value.email);
    const code = randomToken(32);
    const id = crypto.randomUUID();
    const now = Date.now();
    await rows(runtimeFactory(context).db, {
      q: `INSERT INTO invites
          (id, code_hash, email, target_org_id, role, state,
           created_by_membership_id, redeemed_by_user_id, created_at,
           expires_at, redeemed_at)
          VALUES (?1, ?2, ?3, ?4, ?5, 'ready', ?6, NULL, ?7, ?8, NULL)`,
      v: [
        id,
        await inviteCodeHash(code),
        email,
        orgId,
        role,
        principal.membershipId,
        now,
        now + INVITE_TTL_MS,
      ],
    });
    return context.json({
      invite: { id, email, role, state: "ready", createdAt: now, expiresAt: now + INVITE_TTL_MS },
      code,
      ttlDays: INVITE_TTL_DAYS,
    }, 201);
  });

  router.delete("/invites/:id", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireAdmin(principal);
    const changed = await rows<{ id: string }>(runtimeFactory(context).db, {
      q: `UPDATE invites SET state = 'revoked'
          WHERE id = ?1 AND target_org_id = ?2 AND state = 'ready'
          RETURNING id`,
      v: [context.req.param("id"), orgId],
    });
    if (changed.length === 0) {
      const exists = await first<{ id: string }>(runtimeFactory(context).db, {
        q: "SELECT id FROM invites WHERE id = ?1 AND target_org_id = ?2 LIMIT 1",
        v: [context.req.param("id"), orgId],
      });
      if (exists === null) throw new HttpError(404, "invite not found");
      throw new HttpError(409, "only ready invites can be revoked");
    }
    return context.body(null, 204);
  });
}
