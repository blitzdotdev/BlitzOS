import type { FolderGrantView, FolderView } from "../wire.js";
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
import {
  filesActorForRequest,
  folderRole,
  requireFolderAccess,
} from "./access.js";
import { folderObjectPrefix } from "./keys.js";

interface FolderListRow {
  id: string;
  org_id: string;
  name: string;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
  grant_role: "editor" | "viewer" | null;
  org_role: "editor" | "viewer" | null;
  owner_name: string;
  owner_avatar_url: string | null;
}

interface AttachmentIdRow {
  folder_id: string;
  workspace_id: string;
}

interface GrantRow {
  id: string;
  folder_id: string;
  membership_id: string;
  role: "editor" | "viewer";
  created_at: number;
  name: string;
  email: string;
  avatar_url: string | null;
}

interface CreateFolderInput { name: string }
interface CreateGrantInput { membershipId: string; role: "editor" | "viewer" }
interface UpdateFolderInput {
  name?: string;
  orgRole?: "editor" | "viewer" | null;
}

function parseUpdateFolder(value: JsonValue): UpdateFolderInput {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const input: UpdateFolderInput = {};
  if (value.name !== undefined) input.name = parseCreateFolder({ name: value.name }).name;
  if (value.orgRole !== undefined) {
    if (value.orgRole !== null && value.orgRole !== "editor" && value.orgRole !== "viewer") {
      throw new HttpError(400, "orgRole must be editor, viewer, or null");
    }
    input.orgRole = value.orgRole;
  }
  if (input.name === undefined && input.orgRole === undefined) {
    throw new HttpError(400, "name or orgRole is required");
  }
  return input;
}

function parseCreateFolder(value: JsonValue): CreateFolderInput {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", 128).trim();
  if (
    name === ""
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || name.includes("\u0000")
  ) throw new HttpError(400, "name must be safe for workspace materialization");
  return { name };
}

function parseCreateGrant(value: JsonValue): CreateGrantInput {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const membershipId = requiredString(value.membershipId, "membershipId", 256);
  if (value.role !== "editor" && value.role !== "viewer") {
    throw new HttpError(400, "role must be editor or viewer");
  }
  return { membershipId, role: value.role };
}

function grantView(row: GrantRow): FolderGrantView {
  return {
    id: row.id,
    membershipId: row.membership_id,
    role: row.role,
    createdAt: row.created_at,
    member: { name: row.name, email: row.email, avatarUrl: row.avatar_url },
  };
}

async function deleteFolderObjects(bucket: R2Bucket, prefix: string): Promise<void> {
  while (true) {
    const page = await bucket.list({ prefix, limit: 1_000 });
    if (page.objects.length === 0) return;
    await bucket.delete(page.objects.map(({ key }) => key));
  }
}

export function addFolderRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/folders", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    if (actor.principal.membershipId === null || actor.principal.orgId === null) {
      throw new HttpError(403, "active membership required");
    }
    const input = parseCreateFolder(await readJson(context.req.raw));
    const now = Date.now();
    const id = crypto.randomUUID();
    await rows(runtime.db, {
      q: `INSERT INTO folders
          (id, org_id, name, created_by_membership_id, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      v: [id, actor.principal.orgId, input.name, actor.principal.membershipId, now],
    });
    const creator = await first<{ name: string; avatar_url: string | null }>(runtime.db, {
      q: "SELECT name, avatar_url FROM users WHERE id = ?1 LIMIT 1",
      v: [actor.principal.id],
    });
    const folder: FolderView = {
      id,
      name: input.name,
      role: "owner",
      orgRole: null,
      owner: {
        name: creator?.name ?? actor.editedBy,
        avatarUrl: creator?.avatar_url ?? null,
      },
      attachedWorkspaceIds: [],
      createdAt: now,
      updatedAt: now,
      grants: [],
    };
    return context.json({ folder }, 201);
  });

  router.get("/folders", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folderRows = await rows<FolderListRow>(runtime.db, {
      q: `SELECT f.id, f.org_id, f.name,
                 f.created_by_membership_id, f.created_at, f.updated_at,
                 f.org_role, grant.role AS grant_role,
                 owner_user.name AS owner_name,
                 owner_user.avatar_url AS owner_avatar_url
          FROM folders f
          JOIN memberships owner ON owner.id = f.created_by_membership_id
          JOIN users owner_user ON owner_user.id = owner.user_id
          LEFT JOIN folder_grants grant
            ON grant.folder_id = f.id AND grant.membership_id = ?2
          WHERE f.org_id = ?1
          ORDER BY f.created_at, f.id`,
      v: [actor.principal.orgId, actor.principal.membershipId],
    });
    const attachmentRows = folderRows.length === 0 ? [] : await rows<AttachmentIdRow>(runtime.db, {
      q: `SELECT attachment.folder_id, attachment.workspace_id
          FROM folder_attachments attachment
          JOIN workspaces workspace
            ON workspace.id = attachment.workspace_id
           AND workspace.phase != 'destroyed'
          WHERE attachment.folder_id IN (${folderRows.map((_, index) => `?${index + 1}`).join(",")})
          ORDER BY attachment.created_at, attachment.workspace_id`,
      v: folderRows.map(({ id }) => id),
    });
    const attachmentsByFolder = new Map<string, string[]>();
    for (const row of attachmentRows) {
      const existing = attachmentsByFolder.get(row.folder_id) ?? [];
      existing.push(row.workspace_id);
      attachmentsByFolder.set(row.folder_id, existing);
    }
    const controlledIds = folderRows
      .filter((row) => {
        const role = folderRole(actor.principal, row);
        return role === "owner" || role === "admin";
      })
      .map(({ id }) => id);
    const grantRows = controlledIds.length === 0 ? [] : await rows<GrantRow>(runtime.db, {
      q: `SELECT grant.id, grant.folder_id, grant.membership_id, grant.role,
                 grant.created_at, user.name, user.email, user.avatar_url
          FROM folder_grants grant
          JOIN memberships member ON member.id = grant.membership_id
          JOIN users user ON user.id = member.user_id
          WHERE grant.folder_id IN (${controlledIds.map((_, index) => `?${index + 1}`).join(",")})
          ORDER BY grant.created_at, grant.id`,
      v: controlledIds,
    });
    const grantsByFolder = new Map<string, FolderGrantView[]>();
    for (const row of grantRows) {
      const existing = grantsByFolder.get(row.folder_id) ?? [];
      existing.push(grantView(row));
      grantsByFolder.set(row.folder_id, existing);
    }
    const folders: FolderView[] = folderRows.map((row) => {
      const role = folderRole(actor.principal, row);
      const folder: FolderView = {
        id: row.id,
        name: row.name,
        role,
        orgRole: row.org_role,
        owner: { name: row.owner_name, avatarUrl: row.owner_avatar_url },
        attachedWorkspaceIds: attachmentsByFolder.get(row.id) ?? [],
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      if (role === "owner" || role === "admin") {
        folder.grants = grantsByFolder.get(row.id) ?? [];
      }
      return folder;
    });
    return context.json({ folders });
  });

  router.patch("/folders/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(
      runtime.db,
      context.req.param("id"),
      actor,
      "control",
    );
    const input = parseUpdateFolder(await readJson(context.req.raw));
    await rows(runtime.db, {
      q: `UPDATE folders
          SET name = COALESCE(?1, name),
              org_role = CASE WHEN ?2 THEN ?3 ELSE org_role END,
              updated_at = ?4
          WHERE id = ?5`,
      v: [
        input.name ?? null,
        input.orgRole === undefined ? 0 : 1,
        input.orgRole ?? null,
        Date.now(),
        folder.id,
      ],
    });
    return context.body(null, 204);
  });

  router.delete("/folders/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(
      runtime.db,
      context.req.param("id"),
      actor,
      "control",
    );
    await rows(runtime.db, {
      q: "DELETE FROM folder_grants WHERE folder_id = ?1",
      v: [folder.id],
    });
    await rows(runtime.db, {
      q: "DELETE FROM folder_attachments WHERE folder_id = ?1",
      v: [folder.id],
    });
    await rows(runtime.db, {
      q: "DELETE FROM workspace_template_folders WHERE folder_id = ?1",
      v: [folder.id],
    });
    // Deleting the org's usage folder turns capture off with it: the columns
    // must clear before the row goes (D1 enforces the foreign key), and a
    // capture flag pointing at nothing would mount transcript dirs no sweep
    // ever drains.
    await rows(runtime.db, {
      q: "UPDATE orgs SET usage_capture = 0, usage_folder_id = NULL WHERE usage_folder_id = ?1",
      v: [folder.id],
    });
    await deleteFolderObjects(
      runtime.fileObjects,
      folderObjectPrefix(folder.org_id, folder.id),
    );
    await rows(runtime.db, { q: "DELETE FROM folders WHERE id = ?1", v: [folder.id] });
    return context.body(null, 204);
  });

  router.post("/folders/:id/grants", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(
      runtime.db,
      context.req.param("id"),
      actor,
      "control",
    );
    const input = parseCreateGrant(await readJson(context.req.raw));
    const member = await first<{ id: string }>(runtime.db, {
      q: `SELECT id FROM memberships
          WHERE id = ?1 AND org_id = ?2 AND status = 'active' LIMIT 1`,
      v: [input.membershipId, folder.org_id],
    });
    if (member === null) {
      throw new HttpError(400, "grantee must be an active organization member");
    }
    if (member.id === folder.created_by_membership_id) {
      throw new HttpError(400, "folder owner does not need a grant");
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    await rows(runtime.db, {
      q: `INSERT INTO folder_grants
          (id, folder_id, membership_id, role, granted_by_membership_id, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(folder_id, membership_id) DO UPDATE SET
            role = excluded.role,
            granted_by_membership_id = excluded.granted_by_membership_id,
            created_at = excluded.created_at`,
      v: [id, folder.id, input.membershipId, input.role, actor.principal.membershipId, now],
    });
    const grant = await first<GrantRow>(runtime.db, {
      q: `SELECT grant.id, grant.folder_id, grant.membership_id, grant.role,
                 grant.created_at, user.name, user.email, user.avatar_url
          FROM folder_grants grant
          JOIN memberships membership ON membership.id = grant.membership_id
          JOIN users user ON user.id = membership.user_id
          WHERE grant.folder_id = ?1 AND grant.membership_id = ?2 LIMIT 1`,
      v: [folder.id, input.membershipId],
    });
    if (grant === null) throw new Error("folder grant disappeared after creation");
    return context.json({ grant: grantView(grant) }, 201);
  });

  router.delete("/folders/:id/grants/:grantId", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const folder = await requireFolderAccess(
      runtime.db,
      context.req.param("id"),
      actor,
      "control",
    );
    const deleted = await rows<{ id: string }>(runtime.db, {
      q: `DELETE FROM folder_grants
          WHERE id = ?1 AND folder_id = ?2 RETURNING id`,
      v: [context.req.param("grantId"), folder.id],
    });
    if (deleted.length !== 1) throw new HttpError(404, "folder grant not found");
    return context.body(null, 204);
  });
}
