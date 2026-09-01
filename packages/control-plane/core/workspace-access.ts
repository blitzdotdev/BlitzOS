import type { Db } from "./db.js";
import { first } from "./db.js";
import { HttpError } from "./http.js";
import type { Principal } from "./principals.js";
import { cookieValue, SESSION_COOKIE } from "./principals.js";
import { hashSecret, matchesStoredHash } from "./crypto.js";
import type { CoreContext, CoreRuntime } from "./runtime.js";
import { workspaceById, type WorkspaceRow } from "./workspace-records.js";
import type { WorkspaceMemberRole, WorkspaceRole } from "./wire.js";

export interface WorkspaceAccessRow {
  id: string;
  org_id: string | null;
  owner_membership_id: string | null;
}

/** What a caller may do in one workspace.
 *
 * `stored` is their `workspace_members` role, which is the only thing the
 * matrix in plans/MEMBER-MACHINES.md §3 grades. `orgAdmin` is the implicit
 * reach an org admin holds into every workspace of the org — access, and
 * workspace-admin powers, but not a stored role: it disappears the moment the
 * person stops being an org admin, so it is never written down. */
export interface WorkspaceAccess {
  stored: WorkspaceMemberRole | null;
  orgAdmin: boolean;
  owner: boolean;
}

/** True where the caller may run the workspace: members, roles, machines,
 * settings, credentials, delete. */
export function isWorkspaceAdmin(access: WorkspaceAccess): boolean {
  return access.orgAdmin || access.stored === "admin";
}

/** True where the caller may work in the workspace — their own machine, their
 * own sessions, credential use. A viewer may not. */
export function isWorkspaceMember(access: WorkspaceAccess): boolean {
  return isWorkspaceAdmin(access) || access.stored === "member";
}

/** The legacy four-value access role. It is what a webApp ticket carries and
 * what `WorkspaceView.role` reports, and it is pinned by fixtures on three
 * runtimes, so the stored role is projected onto it rather than replacing it.
 * Null means no access at all. */
export function legacyRole(access: WorkspaceAccess): WorkspaceRole | null {
  if (access.owner) return "owner";
  if (access.orgAdmin) return "admin";
  if (access.stored === "admin" || access.stored === "member") return "editor";
  if (access.stored === "viewer") return "viewer";
  return null;
}

export function accessFor(
  principal: Principal,
  workspace: WorkspaceAccessRow,
  stored: WorkspaceMemberRole | null,
): WorkspaceAccess {
  if (principal.orgId === null || workspace.org_id !== principal.orgId) {
    return { stored: null, orgAdmin: false, owner: false };
  }
  return {
    stored,
    orgAdmin: principal.role === "admin",
    owner: workspace.owner_membership_id !== null
      && workspace.owner_membership_id === principal.membershipId,
  };
}

export async function storedRole(
  db: Db,
  workspaceId: string,
  membershipId: string | null,
): Promise<WorkspaceMemberRole | null> {
  if (membershipId === null) return null;
  const row = await first<{ role: WorkspaceMemberRole }>(db, {
    q: `SELECT role FROM workspace_members
        WHERE workspace_id = ?1 AND membership_id = ?2 LIMIT 1`,
    v: [workspaceId, membershipId],
  });
  return row?.role ?? null;
}

export async function workspaceAccess(
  db: Db,
  principal: Principal,
  workspace: WorkspaceAccessRow,
): Promise<WorkspaceAccess> {
  return accessFor(
    principal,
    workspace,
    await storedRole(db, workspace.id, principal.membershipId),
  );
}

/** The gate every administrative workspace write shares. Org admins pass
 * through implicit reach; everybody else needs the stored admin row. */
export async function requireWorkspaceAdmin(
  db: Db,
  principal: Principal,
  workspace: WorkspaceAccessRow,
): Promise<WorkspaceAccess> {
  const access = await workspaceAccess(db, principal, workspace);
  if (!isWorkspaceAdmin(access)) throw new HttpError(403, "workspace admin required");
  return access;
}

/** The live workspace an administrative write names, gated by §3.
 *
 * Every workspace-admin route starts here: a workspace in another org, or one
 * already tombstoned, is 404 rather than 403, so nothing leaks about what the
 * organization holds. The `org_id` narrowing is what lets the caller look up
 * the org roster without re-checking it. */
export async function workspaceForAdminWrite(
  db: Db,
  principal: Principal,
  id: string,
): Promise<WorkspaceRow & { org_id: string }> {
  const workspace = await workspaceById(db, id);
  if (
    workspace === null
    || workspace.org_id === null
    || workspace.org_id !== principal.orgId
    || workspace.deleted_at !== null
  ) {
    throw new HttpError(404, "workspace not found");
  }
  await requireWorkspaceAdmin(db, principal, workspace);
  // SAFETY: org_id was null-checked immediately above; the intersection only narrows that one property.
  return workspace as WorkspaceRow & { org_id: string };
}

export interface WebAppWorkspaceAccess {
  workspace: WorkspaceRow;
  userId: string;
  membershipId: string;
  role: WorkspaceRole;
  access: WorkspaceAccess;
}

/** Resolves session, membership, workspace, and stored workspace role in one
 * D1 read on every authenticated webApp request. The ordinary principal lookup
 * is only a miss-path fallback needed to preserve the 401 response contract. */
export async function webAppWorkspaceForRequest(
  runtime: CoreRuntime,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
  context: CoreContext,
  id: string,
): Promise<WebAppWorkspaceAccess> {
  const token = cookieValue(context.req.raw, SESSION_COOKIE);
  if (token !== null) {
    const hash = await hashSecret(token);
    const row = await first<WorkspaceRow & {
      session_token_hash: string;
      session_principal_id: string;
      session_membership_id: string;
      session_org_id: string;
      session_member_role: "admin" | "member";
      stored_role: WorkspaceMemberRole | null;
    }>(runtime.db, {
      q: `SELECT w.*, s.token_hash AS session_token_hash,
                 s.principal_id AS session_principal_id,
                 m.id AS session_membership_id, m.org_id AS session_org_id,
                 m.role AS session_member_role, wm.role AS stored_role,
                 owner_user.name AS owner_name,
                 owner_user.avatar_url AS owner_avatar_url
          FROM sessions s
          JOIN memberships m
            ON m.id = s.membership_id
           AND m.user_id = s.principal_id
           AND m.status = 'active'
          JOIN workspaces w ON w.id = ?3
          LEFT JOIN workspace_members wm
            ON wm.workspace_id = w.id AND wm.membership_id = m.id
          LEFT JOIN memberships owner ON owner.id = w.owner_membership_id
          LEFT JOIN users owner_user ON owner_user.id = owner.user_id
          WHERE s.token_hash = ?1 AND s.expires_at > ?2
          LIMIT 1`,
      v: [hash, Date.now(), id],
    });
    if (row !== null && (await matchesStoredHash(token, row.session_token_hash))) {
      const principal: Principal = {
        id: row.session_principal_id,
        unixName: "blitz",
        harnesses: [],
        membershipId: row.session_membership_id,
        orgId: row.session_org_id,
        role: row.session_member_role,
        platformOperator: false,
    plane: "session",
      };
      if (row.org_id !== principal.orgId) throw new HttpError(404, "workspace not found");
      const access = accessFor(principal, row, row.stored_role);
      const role = legacyRole(access);
      if (role === null) throw new HttpError(403, "forbidden");
      return {
        workspace: row,
        userId: principal.id,
        membershipId: row.session_membership_id,
        role,
        access,
      };
    }
  }
  const principal = await requirePrincipal(context);
  const row = await workspaceById(runtime.db, id);
  if (row === null || row.org_id !== principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  const access = await workspaceAccess(runtime.db, principal, row);
  const role = legacyRole(access);
  if (role === null) throw new HttpError(403, "forbidden");
  if (principal.membershipId === null) throw new HttpError(403, "active membership required");
  return {
    workspace: row,
    userId: principal.id,
    membershipId: principal.membershipId,
    role,
    access,
  };
}
