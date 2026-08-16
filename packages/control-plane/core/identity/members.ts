import { first, rows, transaction } from "../db.js";
import { HttpError, isRecord, type JsonValue, readJson, requiredString } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";

type MemberRole = "admin" | "member";
type MemberStatus = "invited" | "active" | "disabled";

interface MemberRow {
  id: string;
  user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  google_user_id: string | null;
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

function emailAddress(value: JsonValue | undefined): string {
  const email = requiredString(value, "email", 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw new HttpError(400, "email must be valid");
  return email;
}

function memberRole(value: JsonValue | undefined): MemberRole {
  if (value !== "admin" && value !== "member") {
    throw new HttpError(400, "role must be admin or member");
  }
  return value;
}

function memberStatus(value: JsonValue | undefined): MemberStatus {
  if (value !== "invited" && value !== "active" && value !== "disabled") {
    throw new HttpError(400, "status must be invited, active, or disabled");
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
    bound: row.google_user_id !== null,
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
    q: `SELECT m.id, m.user_id, m.role, m.status,
               u.email, u.name, u.avatar_url, u.google_user_id
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.id = ?1 AND m.org_id = ?2 LIMIT 1`,
    v: [id, orgId],
  });
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
      q: `SELECT m.id, m.user_id, m.role, m.status,
                 u.email, u.name, u.avatar_url, u.google_user_id
          FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.org_id = ?1
          ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
                   u.name, u.email, m.id`,
      v: [principal.orgId],
    });
    return context.json({ members: members.map(memberView) });
  });

  router.post("/members", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireOrgAdmin(principal);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const email = emailAddress(value.email);
    const role = memberRole(value.role);
    const runtime = runtimeFactory(context);
    const existing = await first<{ id: string; google_user_id: string | null }>(runtime.db, {
      q: "SELECT id, google_user_id FROM users WHERE email = ?1 LIMIT 1",
      v: [email],
    });
    if (existing?.google_user_id !== null && existing !== null) {
      throw new HttpError(409, "email is already bound to a Google account");
    }
    const userId = existing?.id ?? crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const now = Date.now();
    const result = await transaction(runtime.db, [
      {
        q: `INSERT INTO users
            (id, google_user_id, email, name, avatar_url, platform_operator, created_at, updated_at)
            VALUES (?1, NULL, ?2, ?2, NULL, 0, ?3, ?3)
            ON CONFLICT(email) DO NOTHING`,
        v: [userId, email, now],
      },
      {
        q: `INSERT INTO memberships (id, user_id, org_id, role, status)
            VALUES (?1, ?2, ?3, ?4, 'invited')
            ON CONFLICT(user_id, org_id) DO NOTHING RETURNING id`,
        v: [membershipId, userId, orgId, role],
      },
    ]);
    if (result[1]?.length !== 1) throw new HttpError(409, "member already exists");
    const member = await memberInOrg(runtime.db, membershipId, orgId);
    if (member === null) throw new Error("invited member disappeared after creation");
    return context.json({ member: memberView(member) }, 201);
  });

  router.patch("/members/:id", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireOrgAdmin(principal);
    const runtime = runtimeFactory(context);
    const member = await memberInOrg(runtime.db, context.req.param("id"), orgId);
    if (member === null) throw new HttpError(404, "member not found");
    const mutation = parseMutation(await readJson(context.req.raw));
    if (member.status === "invited" && mutation.status === "active") {
      throw new HttpError(400, "invited members activate by signing in");
    }
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
    const changed = await rows<{ id: string }>(runtime.db, {
      q: `UPDATE memberships SET role = ?1, status = ?2
          WHERE id = ?3 AND org_id = ?4
            AND NOT (
              role = 'admin' AND status = 'active'
              AND (?1 != 'admin' OR ?2 != 'active')
              AND (SELECT COUNT(*) FROM memberships
                   WHERE org_id = ?4 AND role = 'admin' AND status = 'active') <= 1
            )
          RETURNING id`,
      v: [nextRole, nextStatus, member.id, orgId],
    });
    if (changed.length !== 1) {
      throw new HttpError(409, "the last active admin cannot be changed");
    }
    const updated = await memberInOrg(runtime.db, member.id, orgId);
    if (updated === null) throw new Error("member disappeared after update");
    return context.json({ member: memberView(updated) });
  });

  router.delete("/members/:id", async (context) => {
    const principal = await requirePrincipal(context);
    const orgId = requireOrgAdmin(principal);
    const runtime = runtimeFactory(context);
    const member = await memberInOrg(runtime.db, context.req.param("id"), orgId);
    if (member === null) throw new HttpError(404, "member not found");
    if (member.status !== "invited" || member.google_user_id !== null) {
      throw new HttpError(409, "only unbound invited members can be deleted");
    }
    await transaction(runtime.db, [
      { q: "DELETE FROM memberships WHERE id = ?1 AND org_id = ?2", v: [member.id, orgId] },
      {
        q: `DELETE FROM users WHERE id = ?1 AND google_user_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?1)`,
        v: [member.user_id],
      },
    ]);
    return context.body(null, 204);
  });
}
