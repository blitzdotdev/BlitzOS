import { first, rows } from "../db.js";
import {
  HttpError,
  isRecord,
  readJson,
  requiredString,
  type JsonValue,
} from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { canControlWorkspace } from "../workspace-access.js";
import type {
  FolderAttachmentView,
  ListFolderAttachmentsResponse,
} from "../wire.js";
import {
  filesActorForRequest,
  folderRole,
  requireFolderAccess,
  type FilesActor,
} from "./access.js";
import { runWorkspaceFileSync, scheduleSync } from "./sync.js";

interface AttachmentWorkspaceRow {
  id: string;
  org_id: string;
  owner_membership_id: string;
}

interface AttachmentRow {
  id: string;
  org_id: string;
  name: string;
  created_by_membership_id: string;
  grant_role: "editor" | "viewer" | null;
  org_role: "editor" | "viewer" | null;
  guest_path: string | null;
  attached_at: number;
}

/** Published directories sync at their original /workspace-relative path; it
 * must stay a safe relative path that MKCOL/PUT can address. */
function parseGuestPath(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const path = requiredString(value, "guestPath", 512).replace(/^\/+|\/+$/gu, "");
  if (
    path === ""
    || path.includes("\\")
    || path.includes("\u0000")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new HttpError(400, "guestPath must be a safe workspace-relative path");
  return path;
}

async function controlledWorkspace(
  runtime: ReturnType<RuntimeFactory>,
  id: string,
  actor: FilesActor,
): Promise<AttachmentWorkspaceRow> {
  const workspace = await first<AttachmentWorkspaceRow>(runtime.db, {
    q: `SELECT id, org_id, owner_membership_id
        FROM workspaces WHERE id = ?1 AND phase != 'destroyed' LIMIT 1`,
    v: [id],
  });
  if (workspace === null || workspace.org_id !== actor.principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  if (!canControlWorkspace(actor.principal, workspace)) {
    throw new HttpError(403, "forbidden");
  }
  return workspace;
}

export function addFolderAttachmentRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/workspaces/:id/folders", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const workspace = await controlledWorkspace(runtime, context.req.param("id"), actor);
    const attached = await rows<AttachmentRow>(runtime.db, {
      q: `SELECT folder.id, folder.org_id, folder.name,
                 folder.created_by_membership_id, folder.org_role,
                 grant.role AS grant_role,
                 attachment.guest_path, attachment.created_at AS attached_at
          FROM folder_attachments attachment
          JOIN folders folder ON folder.id = attachment.folder_id
          LEFT JOIN folder_grants grant
            ON grant.folder_id = folder.id AND grant.membership_id = ?2
          WHERE attachment.workspace_id = ?1
          ORDER BY attachment.created_at, folder.id`,
      v: [workspace.id, actor.principal.membershipId],
    });
    const folders: FolderAttachmentView[] = attached.flatMap((folder) => {
      const role = folderRole(actor.principal, folder);
      return role === null ? [] : [{
        id: folder.id,
        name: folder.name,
        role,
        guestPath: folder.guest_path,
        attachedAt: folder.attached_at,
      }];
    });
    const response: ListFolderAttachmentsResponse = { folders };
    return context.json(response);
  });

  router.post("/workspaces/:id/folders", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requirePrincipal(context);
    const actor: FilesActor = {
      principal,
      editedBy: principal.id,
    };
    const workspace = await controlledWorkspace(runtime, context.req.param("id"), actor);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const folderId = requiredString(value.folderId, "folderId", 256);
    const guestPath = parseGuestPath(value.guestPath);
    const folder = await requireFolderAccess(runtime.db, folderId, actor, "read");
    if (folder.org_id !== workspace.org_id) throw new HttpError(404, "folder not found");
    const now = Date.now();
    await rows(runtime.db, {
      q: `INSERT INTO folder_attachments
          (workspace_id, folder_id, attached_by_membership_id, created_at, guest_path)
          VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(workspace_id, folder_id) DO UPDATE SET
            guest_path = excluded.guest_path`,
      v: [workspace.id, folder.id, principal.membershipId, now, guestPath],
    });
    scheduleSync(runtime, (syncRuntime) => runWorkspaceFileSync(syncRuntime, workspace.id));
    return context.json({
      folder: {
        id: folder.id,
        name: folder.name,
        role: folder.role,
        guestPath,
        attachedAt: now,
      } satisfies FolderAttachmentView,
    }, 201);
  });

  router.delete("/workspaces/:id/folders/:folderId", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requirePrincipal(context);
    const actor: FilesActor = {
      principal,
      editedBy: principal.id,
    };
    const workspace = await controlledWorkspace(runtime, context.req.param("id"), actor);
    const deleted = await rows<{ folder_id: string }>(runtime.db, {
      q: `DELETE FROM folder_attachments
          WHERE workspace_id = ?1 AND folder_id = ?2 RETURNING folder_id`,
      v: [workspace.id, context.req.param("folderId")],
    });
    if (deleted.length === 0) throw new HttpError(404, "folder attachment not found");
    return context.body(null, 204);
  });
}
