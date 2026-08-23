import { base64Url, randomToken } from "../crypto.js";
import type { Db, Query } from "../db.js";
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
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  revoked_at: number | null;
  org_name: string;
  creator_name: string;
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

/** The state a reader sees. Storage keeps only what a writer decided —
 * `redeemed_at` at redemption, `revoked_at` at revocation — and expiry is a
 * fact about `expires_at`, derived here instead of synced into the row by
 * writes-on-read. Revoked wins over redeemed (the write guards make the pair
 * unreachable anyway), and both beat expiry: a decision made while the
 * invite was open does not age into a different answer. */
function inviteState(
  invite: Pick<InviteRow, "revoked_at" | "redeemed_at" | "expires_at">,
  now: number,
): InviteState {
  if (invite.revoked_at !== null) return "revoked";
  if (invite.redeemed_at !== null) return "redeemed";
  return invite.expires_at <= now ? "expired" : "ready";
}

function inviteView(row: InviteRow, now: number) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    state: inviteState(row, now),
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

/** Loads the invite a redemption names and vets it against the redeeming
 * email, throwing the caller-visible refusal (400/404/409/403) when it is
 * not redeemable right now. The redemption batch re-guards every condition
 * in SQL, so this read decides only WHICH error a doomed attempt gets. */
export async function redeemableInvite(
  db: Db,
  code: string,
  email: string,
  now: number,
): Promise<InviteRow> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(code)) throw new HttpError(400, "invalid invite code");
  const invite = await inviteByHash(db, await inviteCodeHash(code));
  if (invite === null) throw new HttpError(404, "invite not found");
  const state = inviteState(invite, now);
  if (state !== "ready") throw new HttpError(409, `invite is ${state}`);
  if (invite.email !== null && invite.email !== email) {
    throw new HttpError(403, "invite is for a different email address");
  }
  return invite;
}

/** A first sign-in that arrives with an invite. The user and principal rows
 * are created inside the redemption batch, conditional on the invite still
 * being redeemable, so the account exists exactly when its invite membership
 * does — a lost race creates nothing and needs no compensating deletion. */
export interface InviteSignupSeed {
  googleUserId: string;
  name: string;
  avatarUrl: string | null;
  /** A verified bootstrap secret was presented: the created row may claim
   * the first-operator slot exactly like an open-mode signup would. */
  bootstrapOperator: boolean;
}

export async function redeemInviteSession(
  db: Db,
  code: string,
  userId: string,
  email: string,
  sessionTokenHash: string,
  sessionTtlMs: number,
  now = Date.now(),
  newUser?: InviteSignupSeed,
): Promise<string> {
  const invite = await redeemableInvite(db, code, email, now);
  const hash = invite.code_hash;
  const existing = await first<{ id: string }>(db, {
    q: "SELECT id FROM memberships WHERE user_id = ?1 AND org_id = ?2 LIMIT 1",
    v: [userId, invite.target_org_id],
  });
  const membershipId = existing?.id ?? crypto.randomUUID();
  const queries: Query[] = [];
  if (newUser !== undefined) {
    queries.push(
      {
        q: `INSERT INTO users
            (id, google_user_id, email, name, avatar_url, platform_operator,
             created_at, updated_at)
            SELECT ?1, ?2, ?3, ?4, ?5,
              CASE WHEN ?6 = 1
                     AND NOT EXISTS (SELECT 1 FROM users WHERE platform_operator = 1)
                   THEN 1 ELSE 0 END,
              ?7, ?7
            WHERE EXISTS (
              SELECT 1 FROM invites
              WHERE code_hash = ?8 AND revoked_at IS NULL AND redeemed_at IS NULL
                AND expires_at > ?7 AND (email IS NULL OR email = ?3)
            )
            RETURNING id`,
        v: [
          userId,
          newUser.googleUserId,
          email,
          newUser.name,
          newUser.avatarUrl,
          newUser.bootstrapOperator ? 1 : 0,
          now,
          hash,
        ],
      },
      {
        q: `INSERT INTO principals (id, unix_name, harnesses)
            SELECT ?1, 'blitz', '["claude","codex"]'
            WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)
            RETURNING id`,
        v: [userId],
      },
    );
  }
  queries.push(
    {
      q: `INSERT INTO memberships (id, user_id, org_id, role, status)
          SELECT ?1, ?2, target_org_id, role, 'active' FROM invites
          WHERE code_hash = ?3 AND revoked_at IS NULL AND redeemed_at IS NULL
            AND expires_at > ?4 AND (email IS NULL OR email = ?5)
          ON CONFLICT(user_id, org_id) DO UPDATE SET
            role = excluded.role, status = 'active'
          RETURNING id`,
      v: [membershipId, userId, hash, now, email],
    },
    {
      q: `UPDATE invites SET redeemed_by_user_id = ?1, redeemed_at = ?2
          WHERE code_hash = ?3 AND revoked_at IS NULL AND redeemed_at IS NULL
            AND expires_at > ?2 AND (email IS NULL OR email = ?4)
          RETURNING id`,
      v: [userId, now, hash, email],
    },
    {
      q: `INSERT INTO sessions
          (token_hash, principal_id, created_at, expires_at, membership_id)
          SELECT ?1, ?2, ?3, ?4, ?5
          WHERE EXISTS (
            SELECT 1 FROM invites WHERE code_hash = ?6
              AND redeemed_by_user_id = ?2 AND redeemed_at = ?3
          ) RETURNING token_hash`,
      v: [sessionTokenHash, userId, now, now + sessionTtlMs, membershipId, hash],
    },
  );
  const result = await transaction(db, queries);
  if (queries.some((_query, index) => result[index]?.length !== 1)) {
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
    const invite = await inviteByHash(runtime.db, await inviteCodeHash(code));
    if (invite === null) throw new HttpError(404, "invite not found");
    return context.json({ invite: inviteView(invite, Date.now()), ttlDays: INVITE_TTL_DAYS });
  });

  router.get("/invites", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireAdmin(principal);
    const runtime = runtimeFactory(context);
    const now = Date.now();
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
    return context.json({
      invites: invites.map((invite) => inviteView(invite, now)),
      ttlDays: INVITE_TTL_DAYS,
    });
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
          (id, code_hash, email, target_org_id, role,
           created_by_membership_id, created_at, expires_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
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
    // The guard is the derived 'ready' predicate: an already-expired invite
    // reads as expired everywhere, so revoking it is the same 409 it always
    // was once a listing had synced the row.
    const changed = await rows<{ id: string }>(runtimeFactory(context).db, {
      q: `UPDATE invites SET revoked_at = ?3
          WHERE id = ?1 AND target_org_id = ?2 AND revoked_at IS NULL
            AND redeemed_at IS NULL AND expires_at > ?3
          RETURNING id`,
      v: [context.req.param("id"), orgId, Date.now()],
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
