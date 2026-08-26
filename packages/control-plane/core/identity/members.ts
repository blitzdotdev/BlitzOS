import type { Query } from "../db.js";
import { first, rows, transaction } from "../db.js";
import { seatAvailable, seatGateEnabled, seatLimitReached, seatsExhausted } from "../entitlements.js";
import { HttpError, isRecord, type JsonValue, readJson } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";

type MemberRole = "admin" | "member";
type MemberStatus = "active" | "disabled";

interface MemberRow {
  id: string;
  user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: MemberRole;
  status: MemberStatus;
}

interface MemberMutation {
  role?: MemberRole;
  status?: MemberStatus;
}

function requireOrgAdmin(principal: Principal): string {
  if (principal.orgId === null || principal.membershipId === null) {
    throw new HttpError(403, "active membership required");
  }
  if (principal.role !== "admin") throw new HttpError(403, "organization admin required");
  return principal.orgId;
}

function memberRole(value: JsonValue | undefined): MemberRole {
  if (value !== "admin" && value !== "member") {
    throw new HttpError(400, "role must be admin or member");
  }
  return value;
}

function memberStatus(value: JsonValue | undefined): MemberStatus {
  if (value !== "active" && value !== "disabled") {
    throw new HttpError(400, "status must be active or disabled");
  }
  return value;
}

function memberView(row: MemberRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    role: row.role,
    status: row.status,
  };
}

function parseMutation(value: JsonValue): MemberMutation {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const mutation: MemberMutation = {};
  if (value.role !== undefined) mutation.role = memberRole(value.role);
  if (value.status !== undefined) mutation.status = memberStatus(value.status);
  if (mutation.role === undefined && mutation.status === undefined) {
    throw new HttpError(400, "role or status is required");
  }
  return mutation;
}

async function memberInOrg(
  db: ReturnType<RuntimeFactory>["db"],
  id: string,
  orgId: string,
): Promise<MemberRow | null> {
  return first<MemberRow>(db, {
    q: `SELECT m.id, m.user_id, m.role, m.status, u.email, u.name, u.avatar_url
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = ?1 AND m.org_id = ?2
          AND m.status IN ('active', 'disabled') LIMIT 1`,
    v: [id, orgId],
  });
}

/** A membership stopped being active — the person left, or an admin disabled
 * them. Every session bound to it moves to another active membership of the
 * same user, or to none. Without this the session keeps a membership_id that
 * findSessionPrincipal refuses, which reads to the person as a hard 401
 * rather than as "you are not in that org any more".
 *
 * The NOT EXISTS is the statement's own precondition, not belt and braces: it
 * ships in the same batch as the status change, and that change carries SQL
 * guards of its own that a concurrent membership edit can still fail. A batch
 * runs every statement it was given, so without this clause a refused leave
 * would still bump the caller out of an org they are, in fact, still in. */
function rebindSessionsOffMembership(membershipId: string): Query {
  return {
    q: `UPDATE sessions SET membership_id = (
          SELECT id FROM memberships
          WHERE user_id = sessions.principal_id AND status = 'active'
          ORDER BY rowid DESC LIMIT 1
        )
        WHERE membership_id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM memberships WHERE id = ?1 AND status = 'active'
          )`,
    v: [membershipId],
  };
}

/** The reverse: a membership became active again. Sessions this user left
 * holding no membership at all are sitting on the create-org onboarding page,
 * so they pick the restored org up. Sessions already scoped to another org
 * stay there — being re-enabled somewhere must not move you. Same precondition
 * rule as above. */
function rebindIdentityOnlySessions(userId: string, membershipId: string): Query {
  return {
    q: `UPDATE sessions SET membership_id = ?1
        WHERE principal_id = ?2 AND membership_id IS NULL
          AND EXISTS (
            SELECT 1 FROM memberships WHERE id = ?1 AND status = 'active'
          )`,
    v: [membershipId, userId],
  };
}

export function addMemberRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/members", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const members = await rows<MemberRow>(runtimeFactory(context).db, {
      q: `SELECT m.id, m.user_id, m.role, m.status, u.email, u.name, u.avatar_url
          FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.org_id = ?1 AND m.status IN ('active', 'disabled')
          ORDER BY CASE m.status WHEN 'active' THEN 0 ELSE 1 END,
                   u.name, u.email, m.id`,
      v: [principal.orgId],
    });
    return context.json({ members: members.map(memberView) });
  });

  /** Leaving is a disable, not a delete. Ten tables hold NOT NULL references
   * to memberships(id) — invites, both grant tables, folders, folder
   * attachments, templates, recipes, volume ownership — and foreign keys are
   * on, so removing the row would either fail the constraint or take other
   * people's history with it. A disabled membership is already what every
   * auth path in the codebase means by "out": findSessionPrincipal rejects
   * the session, activeMembership skips it at login, and the workspace join
   * requires status = 'active'. Re-inviting the person reactivates the same
   * row, exactly as enable does after an admin disable.
   *
   * What the leaver owned stays in the org. Their workspaces keep pointing at
   * the disabled membership, so canControlWorkspace matches only on the org
   * admin branch and the admins inherit them. */
  router.delete("/members/self", async (context) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const runtime = runtimeFactory(context);
    const counts = await first<{ actives: number; admins: number }>(runtime.db, {
      q: `SELECT COUNT(*) AS actives,
                 SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins
          FROM memberships WHERE org_id = ?1 AND status = 'active'`,
      v: [principal.orgId],
    });
    if ((counts?.actives ?? 0) <= 1) {
      throw new HttpError(409, "the last member cannot leave the organization");
    }
    if (principal.role === "admin" && (counts?.admins ?? 0) <= 1) {
      throw new HttpError(409, "the last active admin cannot leave the organization");
    }
    const result = await transaction(runtime.db, [
      {
        q: `UPDATE memberships SET status = 'disabled'
            WHERE id = ?1 AND user_id = ?2 AND org_id = ?3 AND status = 'active'
              AND (SELECT COUNT(*) FROM memberships
                   WHERE org_id = ?3 AND status = 'active') > 1
              AND NOT (
                role = 'admin'
                AND (SELECT COUNT(*) FROM memberships
                     WHERE org_id = ?3 AND role = 'admin' AND status = 'active') <= 1
              )
            RETURNING id`,
        v: [principal.membershipId, principal.id, principal.orgId],
      },
      rebindSessionsOffMembership(principal.membershipId),
    ]);
    if (result[0]?.length !== 1) throw new HttpError(409, "the organization could not be left");
    return context.body(null, 204);
  });

  router.patch("/members/:id", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireOrgAdmin(principal);
    const runtime = runtimeFactory(context);
    const member = await memberInOrg(runtime.db, context.req.param("id"), orgId);
    if (member === null) throw new HttpError(404, "member not found");
    const mutation = parseMutation(await readJson(context.req.raw));
    const nextRole = mutation.role ?? member.role;
    const nextStatus = mutation.status ?? member.status;
    if (
      member.role === "admin"
      && member.status === "active"
      && (nextRole !== "admin" || nextStatus !== "active")
    ) {
      const activeAdmins = await first<{ count: number }>(runtime.db, {
        q: `SELECT COUNT(*) AS count FROM memberships
            WHERE org_id = ?1 AND role = 'admin' AND status = 'active'`,
        v: [orgId],
      });
      if ((activeAdmins?.count ?? 0) <= 1) {
        throw new HttpError(409, "the last active admin cannot be changed");
      }
    }
    // Re-activation is growth, so it meets the seat gate — and it meets it
    // inside the statement, next to the last-admin rule that is guarded the
    // same way. `status` here is the pre-update value, so an already-active
    // member changing role never has to find a free seat.
    const seatGate = seatGateEnabled(runtime.vars)
      ? `AND (?2 != 'active' OR status = 'active' OR ${seatAvailable("?4")})`
      : "";
    // Disabling a member is the admin-side twin of leaving, so it owes their
    // sessions the same rebind; enabling one hands the restored org back to a
    // session left with none. Both ride the same transaction as the status
    // change, so a session can never point at a membership that moved.
    const statements: Query[] = [{
      q: `UPDATE memberships SET role = ?1, status = ?2
          WHERE id = ?3 AND org_id = ?4
            AND NOT (
              role = 'admin' AND status = 'active'
              AND (?1 != 'admin' OR ?2 != 'active')
              AND (SELECT COUNT(*) FROM memberships
                   WHERE org_id = ?4 AND role = 'admin' AND status = 'active') <= 1
            )
            ${seatGate}
          RETURNING id`,
      v: [nextRole, nextStatus, member.id, orgId],
    }];
    if (nextStatus === "disabled" && member.status === "active") {
      statements.push(rebindSessionsOffMembership(member.id));
    }
    if (nextStatus === "active" && member.status === "disabled") {
      statements.push(rebindIdentityOnlySessions(member.user_id, member.id));
    }
    const changed = await transaction<{ id: string }>(runtime.db, statements);
    if (changed[0]?.length !== 1) {
      if (
        nextStatus === "active"
        && member.status !== "active"
        && await seatsExhausted(runtime, orgId)
      ) {
        throw await seatLimitReached(runtime, {
          org: orgId,
          user: principal.id,
          role: "admin",
        });
      }
      throw new HttpError(409, "the last active admin cannot be changed");
    }
    const updated = await memberInOrg(runtime.db, member.id, orgId);
    if (updated === null) throw new Error("member disappeared after update");
    return context.json({ member: memberView(updated) });
  });
}
