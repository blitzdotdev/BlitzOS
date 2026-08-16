import type { Db } from "../db.js";
import { first } from "../db.js";
import { HttpError } from "../http.js";
import { authenticateBox } from "../oauth.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRuntime } from "../runtime.js";

export interface FilesActor {
  principal: Principal;
  editedBy: string;
  workspaceId: string | null;
}

interface BoxWorkspaceActorRow {
  workspace_id: string;
  org_id: string;
  membership_id: string;
  member_role: "admin" | "member";
  user_name: string;
}

interface FolderAccessRow {
  id: string;
  org_id: string;
  name: string;
  version: number;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
  grant_role: "editor" | "viewer" | null;
}

export type FolderRole = "owner" | "admin" | "editor" | "viewer";

export async function filesActorForRequest(
  runtime: CoreRuntime,
  context: CoreContext,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): Promise<FilesActor> {
  const box = await authenticateBox(context.req.raw, runtime.db);
  if (box !== null) {
    if (box.workspaceId === null) throw new HttpError(403, "workspace box required");
    const row = await first<BoxWorkspaceActorRow>(runtime.db, {
      q: `SELECT w.id AS workspace_id, w.org_id,
                 owner.id AS membership_id, owner.role AS member_role,
                 user.name AS user_name
          FROM workspaces w
          JOIN memberships owner
            ON owner.id = w.owner_membership_id
           AND owner.user_id = ?1
           AND owner.status = 'active'
          JOIN users user ON user.id = owner.user_id
          WHERE w.id = ?2 AND w.org_id = owner.org_id AND w.phase != 'destroyed'
          LIMIT 1`,
      v: [box.principalId, box.workspaceId],
    });
    if (row === null) throw new HttpError(403, "workspace owner membership required");
    return {
      principal: {
        id: box.principalId,
        unixName: "blitz",
        harnesses: [],
        membershipId: row.membership_id,
        orgId: row.org_id,
        role: row.member_role,
        platformOperator: box.platformOperator,
      },
      editedBy: row.user_name,
      workspaceId: row.workspace_id,
    };
  }

  const principal = await requirePrincipal(context);
  const user = await first<{ name: string }>(runtime.db, {
    q: "SELECT name FROM users WHERE id = ?1 LIMIT 1",
    v: [principal.id],
  });
  return {
    principal,
    editedBy: user?.name ?? principal.id,
    workspaceId: null,
  };
}

export function folderRole(
  principal: Principal,
  folder: Pick<FolderAccessRow, "org_id" | "created_by_membership_id" | "grant_role">,
): FolderRole | null {
  if (principal.orgId === null || folder.org_id !== principal.orgId) return null;
  if (folder.created_by_membership_id === principal.membershipId) return "owner";
  if (principal.role === "admin") return "admin";
  return folder.grant_role;
}

export async function requireFolderAccess(
  db: Db,
  id: string,
  actor: FilesActor,
  needed: "read" | "write" | "control",
): Promise<FolderAccessRow & { role: FolderRole }> {
  const folder = await first<FolderAccessRow>(db, {
    q: `SELECT f.id, f.org_id, f.name, f.version,
               f.created_by_membership_id, f.created_at, f.updated_at,
               grant.role AS grant_role
        FROM folders f
        LEFT JOIN folder_grants grant
          ON grant.folder_id = f.id AND grant.membership_id = ?2
        WHERE f.id = ?1 LIMIT 1`,
    v: [id, actor.principal.membershipId],
  });
  if (folder === null || folder.org_id !== actor.principal.orgId) {
    throw new HttpError(404, "folder not found");
  }
  const role = folderRole(actor.principal, folder);
  if (role === null) throw new HttpError(403, "forbidden");
  if (needed === "write" && role === "viewer") throw new HttpError(403, "forbidden");
  if (needed === "control" && role !== "owner" && role !== "admin") {
    throw new HttpError(403, "forbidden");
  }
  return { ...folder, role };
}
