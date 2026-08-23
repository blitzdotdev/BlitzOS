import type { Db } from "./db.js";
import { first } from "./db.js";
import { HttpError } from "./http.js";
import type { Principal } from "./principals.js";
import { cookieValue, SESSION_COOKIE } from "./principals.js";
import { hashSecret } from "./crypto.js";
import type { CoreContext, CoreRuntime } from "./runtime.js";
import { workspaceById, type WorkspaceRow } from "./workspace-records.js";
import type { WorkspaceRole } from "./wire.js";

export interface WorkspaceAccessRow {
  id: string;
  org_id: string | null;
  owner_membership_id: string | null;
}

export function canControlWorkspace(
  principal: Principal,
  workspace: WorkspaceAccessRow,
): boolean {
  return principal.orgId !== null
    && principal.membershipId !== null
    && workspace.org_id === principal.orgId
    && (
      principal.role === "admin"
      || workspace.owner_membership_id === principal.membershipId
    );
}

export function workspaceRole(
  principal: Principal,
  workspace: WorkspaceAccessRow & {
    grant_role?: "editor" | "viewer" | null;
    org_share_role?: "editor" | "viewer" | null;
  },
): WorkspaceRole | null {
  if (principal.orgId === null || workspace.org_id !== principal.orgId) return null;
  if (workspace.owner_membership_id === principal.membershipId) return "owner";
  if (principal.role === "admin") return "admin";
  // A personal grant and org-wide sharing combine to the stronger role.
  const grant = workspace.grant_role ?? null;
  const orgWide = workspace.org_share_role ?? null;
  if (grant === "editor" || orgWide === "editor") return "editor";
  return grant ?? orgWide;
}

export interface WebAppWorkspaceAccess {
  workspace: WorkspaceRow;
  userId: string;
  membershipId: string;
  role: WorkspaceRole;
}

/** Resolves session, membership, workspace, and editor grant in one D1 read on
 * every authenticated webApp request. The ordinary principal lookup is only a
 * miss-path fallback needed to preserve the 401 response contract. */
export async function webAppWorkspaceForRequest(
  runtime: CoreRuntime,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
  context: CoreContext,
  id: string,
): Promise<WebAppWorkspaceAccess> {
  const token = cookieValue(context.req.raw, SESSION_COOKIE);
  if (token !== null) {
    const hash = await hashSecret(token);
    // SAFETY: sessions are selected by exact equality on the deterministic,
    // unsalted SHA-256 of the presented token (`s.token_hash = ?1`), so a
    // returned row's stored hash IS the recomputed hash — re-verifying it
    // could never reject. Row presence is the authentication result.
    const row = await first<WorkspaceRow & {
      session_principal_id: string;
      session_membership_id: string;
      session_org_id: string;
      session_member_role: "admin" | "member";
    }>(runtime.db, {
      q: `SELECT w.*, s.principal_id AS session_principal_id,
                 m.id AS session_membership_id, m.org_id AS session_org_id,
                 m.role AS session_member_role, grant.role AS grant_role,
                 owner_user.name AS owner_name,
                 owner_user.avatar_url AS owner_avatar_url
          FROM sessions s
          JOIN memberships m
            ON m.id = s.membership_id
           AND m.user_id = s.principal_id
           AND m.status = 'active'
          JOIN workspaces w ON w.id = ?3
          LEFT JOIN workspace_grants grant
            ON grant.workspace_id = w.id AND grant.membership_id = m.id
          LEFT JOIN memberships owner ON owner.id = w.owner_membership_id
          LEFT JOIN users owner_user ON owner_user.id = owner.user_id
          WHERE s.token_hash = ?1 AND s.expires_at > ?2
          LIMIT 1`,
      v: [hash, Date.now(), id],
    });
    if (row !== null) {
      const principal: Principal = {
        id: row.session_principal_id,
        unixName: "blitz",
        harnesses: [],
        membershipId: row.session_membership_id,
        orgId: row.session_org_id,
        role: row.session_member_role,
        platformOperator: false,
      };
      if (row.org_id !== principal.orgId) throw new HttpError(404, "workspace not found");
      const role = workspaceRole(principal, row);
      if (role === null) throw new HttpError(403, "forbidden");
      return {
        workspace: row,
        userId: principal.id,
        membershipId: row.session_membership_id,
        role,
      };
    }
  }
  const principal = await requirePrincipal(context);
  const row = await workspaceById(runtime.db, id);
  if (row === null || row.org_id !== principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  const role = workspaceRole(principal, row);
  if (role === null) throw new HttpError(403, "forbidden");
  if (principal.membershipId === null) throw new HttpError(403, "active membership required");
  return { workspace: row, userId: principal.id, membershipId: principal.membershipId, role };
}
