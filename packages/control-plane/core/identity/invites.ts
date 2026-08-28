import { randomToken } from "../crypto.js";
import type { Db } from "../db.js";
import { first, rows, transaction } from "../db.js";
import {
  seatAvailable,
  seatGateEnabled,
  seatLimitReached,
  seatsExhausted,
} from "../entitlements.js";
import { HttpError, isRecord, type JsonValue, readJson, requiredString } from "../http.js";
import type { Principal } from "../principals.js";
import {
  enforceRateLimit,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type RuntimeFactory,
  type RuntimeVariables,
} from "../runtime.js";
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

export function optionalEmail(value: JsonValue | undefined): string | null {
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

export async function expireInvites(db: Db, now: number, orgId?: string): Promise<void> {
  await rows(db, {
    q: `UPDATE invites SET state = 'expired'
        WHERE state = 'ready' AND expires_at <= ?1${orgId === undefined ? "" : " AND target_org_id = ?2"}`,
    v: orgId === undefined ? [now] : [now, orgId],
  });
}

/**
 * The clause a redemption statement must satisfy before it may set a
 * membership active.
 *
 * "Growth only": a user who already holds an active seat is re-stamping their
 * role, not taking a new seat, so they pass regardless of the limit. Everyone
 * else needs a free one, counted inside the statement that would take it.
 *
 * One clause covers both halves of the upsert, because it filters the invite
 * row the INSERT selects: a candidate that cannot have a seat produces no row,
 * so neither the insert nor the ON CONFLICT DO UPDATE that re-activates a
 * disabled member ever runs. A second copy on the DO UPDATE branch would ask
 * the same question again, in the same statement, one line later.
 *
 * The statement that burns the invite takes it too. The three statements run
 * as one batch but are not rolled back for each other, and gating only the
 * membership write would spend the code while admitting nobody — which is the
 * same stockpiled code coming back tomorrow.
 *
 * Both statements read the invite row, so the organization is `target_org_id`,
 * a column already in scope. Empty where gating is off, which leaves the
 * statement and its parameter list exactly as they were before this module.
 */
function growthAllowed(vars: RuntimeVariables, userParameter: string): string {
  if (!seatGateEnabled(vars)) return "";
  return `AND (EXISTS (
                SELECT 1 FROM memberships seated
                WHERE seated.user_id = ${userParameter}
                  AND seated.org_id = target_org_id
                  AND seated.status = 'active')
              OR ${seatAvailable("target_org_id")})`;
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
  runtime: CoreRuntime,
  request: Request,
  code: string,
  userId: string,
  email: string,
  sessionTokenHash: string,
  now = Date.now(),
): Promise<string> {
  const db = runtime.db;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) throw new HttpError(400, "invalid invite code");
  const hash = await inviteCodeHash(code);
  await expireInvites(db, now);
  const invite = await inviteByHash(db, hash);
  if (invite === null) throw new HttpError(404, "invite not found");
  if (invite.state !== "ready") throw new HttpError(409, `invite is ${invite.state}`);
  if (invite.email !== null && invite.email !== email) {
    throw new HttpError(403, "invite is for a different email address");
  }
  const existing = await first<{ id: string; status: string }>(db, {
    q: "SELECT id, status FROM memberships WHERE user_id = ?1 AND org_id = ?2 LIMIT 1",
    v: [userId, invite.target_org_id],
  });
  const membershipId = existing?.id ?? crypto.randomUUID();
  // The seat gate lives in the statements below, not in a check above them.
  // A revoked-then-restored member holding an old code is exactly the caller
  // a read-then-write gate lets through.
  const seatGate = growthAllowed(runtime.vars, "?2");
  const burnGate = growthAllowed(runtime.vars, "?1");
  const result = await transaction(db, [
    {
      q: `INSERT INTO memberships (id, user_id, org_id, role, status)
          SELECT ?1, ?2, target_org_id, role, 'active' FROM invites
          WHERE code_hash = ?3 AND state = 'ready' AND expires_at > ?4
            AND (email IS NULL OR email = ?5)
            ${seatGate}
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
            ${burnGate}
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
      v: [sessionTokenHash, userId, now, now + runtime.vars.sessionTtlMs, membershipId, hash],
    },
  ]);
  if (result[0]?.length !== 1 || result[1]?.length !== 1 || result[2]?.length !== 1) {
    // Name the reason the statements refused. They decided it; this only reads
    // it back, and only where taking a seat was what was being asked for.
    if (existing?.status !== "active" && await seatsExhausted(runtime, invite.target_org_id)) {
      throw await seatLimitReached(runtime, request, {
        org: invite.target_org_id,
        user: userId,
        role: invite.role,
      });
    }
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
    // A browser following the invite link gets the app shell; the invite
    // page then re-fetches this route for the JSON view.
    if (
      runtime.assets !== undefined
      && (context.req.header("accept") ?? "").includes("text/html")
    ) {
      return runtime.assets.fetch(context.req.raw);
    }
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
    const runtime = runtimeFactory(context);
    await enforceRateLimit(runtime.vars.requestRateLimiter, `create:${principal.id}`);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const role = inviteRole(value.role);
    const email = optionalEmail(value.email);
    // Soft, and only soft: an invite is not a seat, so this refuses early for
    // the person's sake. The seat itself is granted or refused at redemption.
    if (await seatsExhausted(runtime, orgId)) {
      throw await seatLimitReached(
        runtime,
        context.req.raw,
        { org: orgId, user: principal.id, role: "admin" },
      );
    }
    const code = randomToken(32);
    const id = crypto.randomUUID();
    const now = Date.now();
    await rows(runtime.db, {
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
