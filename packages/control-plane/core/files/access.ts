import type { Db } from "../db.js";
import { first } from "../db.js";
import { HttpError } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRuntime } from "../runtime.js";

export interface FilesActor {
  principal: Principal;
  editedBy: string;
}

interface FolderAccessRow {
  id: string;
  org_id: string;
  name: string;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
  grant_role: "editor" | "viewer" | null;
  org_role: "editor" | "viewer" | null;
}

export type FolderRole = "owner" | "admin" | "editor" | "viewer";

export async function filesActorForRequest(
  runtime: CoreRuntime,
  context: CoreContext,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): Promise<FilesActor> {
  const principal = await requirePrincipal(context);
  const user = await first<{ name: string }>(runtime.db, {
    q: "SELECT name FROM users WHERE id = ?1 LIMIT 1",
    v: [principal.id],
  });
  return {
    principal,
    editedBy: user?.name ?? principal.id,
  };
}

export function folderRole(
  principal: Principal,
  folder: Pick<FolderAccessRow, "org_id" | "created_by_membership_id" | "grant_role" | "org_role">,
): FolderRole | null {
  if (principal.orgId === null || folder.org_id !== principal.orgId) return null;
  if (folder.created_by_membership_id === principal.membershipId) return "owner";
  if (principal.role === "admin") return "admin";
  // A personal grant and org-wide sharing combine to the stronger role.
  if (folder.grant_role === "editor" || folder.org_role === "editor") return "editor";
  return folder.grant_role ?? folder.org_role;
}

export async function requireFolderAccess(
  db: Db,
  id: string,
  actor: FilesActor,
  needed: "read" | "write" | "control",
): Promise<FolderAccessRow & { role: FolderRole }> {
  const folder = await first<FolderAccessRow>(db, {
    q: `SELECT f.id, f.org_id, f.name,
               f.created_by_membership_id, f.created_at, f.updated_at,
               f.org_role, grant.role AS grant_role
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
