import { hashSecret } from "../crypto.js";
import { first, rows, transaction } from "../db.js";
import { HttpError, isRecord, type JsonValue, readJson, requiredString } from "../http.js";
import type { Principal } from "../principals.js";
import { cookieValue, SESSION_COOKIE } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { addGoogleAuthRoutes } from "./google.js";
import { addInviteRoutes } from "./invites.js";
import { addMemberRoutes } from "./members.js";
import { availableOrgSlug, DEFAULT_ORG_VM_LIMIT, MAX_SELF_CREATED_ORGS } from "./orgs.js";

interface MeRow {
  user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  platform_operator: number;
  membership_id: string | null;
  role: "admin" | "member" | null;
  status: "active" | null;
  org_id: string | null;
  slug: string | null;
  org_name: string | null;
  vm_limit: number | null;
}

interface MembershipView {
  id: string;
  role: "admin" | "member";
  status: "active";
}

interface OrgView {
  id: string;
  slug: string;
  name: string;
  vmLimit: number;
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    platformOperator: boolean;
  };
  membership: MembershipView | null;
  org: OrgView | null;
  organizations: Array<{ membership: MembershipView; org: OrgView }>;
}

function meResponse(row: MeRow): MeResponse {
  const hasMembership =
    row.membership_id !== null
    && row.role !== null
    && row.status !== null
    && row.org_id !== null
    && row.slug !== null
    && row.org_name !== null
    && row.vm_limit !== null;
  return {
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      platformOperator: row.platform_operator === 1,
    },
    membership: hasMembership
      ? { id: row.membership_id ?? "", role: row.role ?? "member", status: "active" }
      : null,
    org: hasMembership
      ? {
          id: row.org_id ?? "",
          slug: row.slug ?? "",
          name: row.org_name ?? "",
          vmLimit: row.vm_limit ?? DEFAULT_ORG_VM_LIMIT,
        }
      : null,
    organizations: [],
  };
}

async function loadMe(
  runtimeFactory: RuntimeFactory,
  context: CoreContext,
  principal: Principal,
): Promise<MeResponse> {
  const row = await first<MeRow>(runtimeFactory(context).db, {
    q: `SELECT u.id AS user_id, u.email, u.name, u.avatar_url,
              u.platform_operator, m.id AS membership_id, m.role, m.status,
              o.id AS org_id, o.slug, o.name AS org_name, o.vm_limit
        FROM users u
        LEFT JOIN memberships m ON m.id = ?2 AND m.user_id = u.id
        LEFT JOIN orgs o ON o.id = m.org_id
        WHERE u.id = ?1 LIMIT 1`,
    v: [principal.id, principal.membershipId],
  });
  if (row === null) throw new HttpError(401, "unauthorized");
  const response = meResponse(row);
  const organizations = await rows<{
    membership_id: string;
    role: "admin" | "member";
    status: "active";
    org_id: string;
    slug: string;
    org_name: string;
    vm_limit: number;
  }>(runtimeFactory(context).db, {
    q: `SELECT m.id AS membership_id, m.role, m.status, o.id AS org_id,
               o.slug, o.name AS org_name, o.vm_limit
        FROM memberships m JOIN orgs o ON o.id = m.org_id
        WHERE m.user_id = ?1 AND m.status = 'active'
        ORDER BY o.name, o.id`,
    v: [principal.id],
  });
  return {
    ...response,
    organizations: organizations.map((item) => ({
      membership: { id: item.membership_id, role: item.role, status: item.status },
      org: {
        id: item.org_id,
        slug: item.slug,
        name: item.org_name,
        vmLimit: item.vm_limit,
      },
    })),
  };
}

function parseOrgName(value: JsonValue): string {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", 120).trim();
  if (name === "") throw new HttpError(400, "name must be a non-empty string");
  return name;
}

export function addIdentityRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  addGoogleAuthRoutes(router, runtimeFactory);
  addInviteRoutes(router, runtimeFactory, requirePrincipal);
  addMemberRoutes(router, runtimeFactory, requirePrincipal);

  router.get("/me", async (context) => {
    const principal = await requirePrincipal(context);
    return context.json(await loadMe(runtimeFactory, context, principal));
  });

  // Signup gating (SIGNUP_MODE / ALLOWED_EMAIL_DOMAINS) is enforced at the
  // Google callback, where users are created. Org creation deliberately
  // stays open to any signed-in user, including under SIGNUP_MODE=invite:
  // a session only exists for accounts that got in through an invite, the
  // bootstrap secret, or before the gate — refusing them here would add a
  // second gate with no additional access control.
  //
  // This route serves both onboarding (identity-only session, no membership)
  // and a member starting a second org from the rail. Either way it rebinds
  // the calling session to the new org, so the caller lands inside it. The
  // only limit is MAX_SELF_CREATED_ORGS, which stands in for the "already a
  // member" 409 this route used to carry as its de-facto quota cap.
  router.post("/orgs", async (context) => {
    const principal = await requirePrincipal(context);
    const token = cookieValue(context.req.raw, SESSION_COOKIE);
    if (token === null) throw new HttpError(401, "unauthorized");
    const runtime = runtimeFactory(context);
    const created = await first<{ count: number }>(runtime.db, {
      q: "SELECT COUNT(*) AS count FROM orgs WHERE created_by_user_id = ?1",
      v: [principal.id],
    });
    if ((created?.count ?? 0) >= MAX_SELF_CREATED_ORGS) {
      throw new HttpError(409, "organization limit reached");
    }
    const name = parseOrgName(await readJson(context.req.raw));
    const id = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const slug = await availableOrgSlug(runtime.db, name);
    const now = Date.now();
    const sessionHash = await hashSecret(token);
    const result = await transaction(runtime.db, [
      {
        q: `INSERT INTO orgs
            (id, slug, name, vm_limit, created_by_user_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
            RETURNING id`,
        v: [id, slug, name, DEFAULT_ORG_VM_LIMIT, principal.id, now],
      },
      {
        q: `INSERT INTO memberships (id, user_id, org_id, role, status)
            SELECT ?1, ?2, ?3, 'admin', 'active'
            WHERE EXISTS (SELECT 1 FROM orgs WHERE id = ?3)
            RETURNING id`,
        v: [membershipId, principal.id, id],
      },
      {
        q: `UPDATE sessions SET membership_id = ?1
            WHERE token_hash = ?2 AND principal_id = ?3
            RETURNING token_hash`,
        v: [membershipId, sessionHash, principal.id],
      },
    ]);
    if (
      result[0]?.length !== 1
      || result[1]?.length !== 1
      || result[2]?.length !== 1
    ) {
      throw new HttpError(409, "organization could not be created");
    }
    return context.json({
      org: { id, slug, name, vmLimit: DEFAULT_ORG_VM_LIMIT },
      membership: { id: membershipId, role: "admin", status: "active" },
    }, 201);
  });
}
