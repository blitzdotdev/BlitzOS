import type { Db } from "./db.js";
import { first, rows } from "./db.js";
import { filesActorForRequest, folderRole, requireFolderAccess } from "./files/access.js";
import { HttpError, isRecord, readJson, requiredString, type JsonValue } from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type { WorkspaceTemplateView } from "./wire.js";

export interface WorkspaceTemplateRow {
  id: string;
  org_id: string;
  name: string;
  machine_type_id: string;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
}

interface TemplateListRow extends WorkspaceTemplateRow {
  creator_name: string;
  creator_avatar_url: string | null;
}

interface TemplateFolderRow {
  template_id: string;
  folder_id: string;
  org_id: string;
  name: string;
  created_by_membership_id: string;
  grant_role: "editor" | "viewer" | null;
  org_role: "editor" | "viewer" | null;
}

interface CreateTemplateInput {
  name: string;
  machineTypeId: string;
  folderIds: string[];
}

const MAX_TEMPLATE_FOLDERS = 16;

function parseCreateTemplate(value: JsonValue): CreateTemplateInput {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", 64).trim();
  if (name === "") throw new HttpError(400, "name is required");
  const machineTypeId = requiredString(value.machineTypeId, "machineTypeId", 256);
  if (!Array.isArray(value.folderIds)) {
    throw new HttpError(400, "folderIds must be an array");
  }
  const folderIds = [...new Set(value.folderIds.map((entry, index) =>
    requiredString(entry, `folderIds[${String(index)}]`, 256)))];
  if (folderIds.length > MAX_TEMPLATE_FOLDERS) {
    throw new HttpError(400, `folderIds must have at most ${String(MAX_TEMPLATE_FOLDERS)} entries`);
  }
  return { name, machineTypeId, folderIds };
}

export async function workspaceTemplateForCreate(
  db: Db,
  id: string,
  orgId: string,
): Promise<WorkspaceTemplateRow> {
  const template = await first<WorkspaceTemplateRow>(db, {
    q: "SELECT * FROM workspace_templates WHERE id = ?1 LIMIT 1",
    v: [id],
  });
  if (template === null || template.org_id !== orgId) {
    throw new HttpError(404, "workspace template not found");
  }
  return template;
}

async function templateFolderRows(
  db: Db,
  templateIds: string[],
  membershipId: string | null,
): Promise<TemplateFolderRow[]> {
  if (templateIds.length === 0) return [];
  return rows<TemplateFolderRow>(db, {
    q: `SELECT tf.template_id, tf.folder_id, f.org_id, f.name,
               f.created_by_membership_id, f.org_role, grant.role AS grant_role
        FROM workspace_template_folders tf
        JOIN folders f ON f.id = tf.folder_id
        LEFT JOIN folder_grants grant
          ON grant.folder_id = f.id AND grant.membership_id = ?1
        WHERE tf.template_id IN (${templateIds.map((_, index) => `?${String(index + 2)}`).join(",")})
        ORDER BY tf.created_at, tf.folder_id`,
    v: [membershipId, ...templateIds],
  });
}

/** Attaches the template's folders the creating member can actually access;
 * the sync tick re-checks access on every pass, so an attachment never
 * outlives a revocation. */
export async function attachTemplateFolders(
  db: Db,
  templateId: string,
  workspaceId: string,
  principal: Principal,
  now: number,
): Promise<void> {
  const folders = await templateFolderRows(db, [templateId], principal.membershipId);
  for (const folder of folders) {
    if (folderRole(principal, folder) === null) continue;
    await rows(db, {
      q: `INSERT INTO folder_attachments
          (workspace_id, folder_id, attached_by_membership_id, created_at, guest_path)
          VALUES (?1, ?2, ?3, ?4, NULL)
          ON CONFLICT(workspace_id, folder_id) DO NOTHING`,
      v: [workspaceId, folder.folder_id, principal.membershipId, now],
    });
  }
}

function templateView(
  row: TemplateListRow,
  principal: Principal,
  folders: TemplateFolderRow[],
): WorkspaceTemplateView {
  return {
    id: row.id,
    name: row.name,
    machineTypeId: row.machine_type_id,
    createdAt: row.created_at,
    createdBy: { name: row.creator_name, avatarUrl: row.creator_avatar_url },
    folders: folders.map((folder) => ({
      id: folder.folder_id,
      name: folder.name,
      role: folderRole(principal, folder),
    })),
  };
}

export function addWorkspaceTemplateRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/workspace-templates", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const templates = await rows<TemplateListRow>(runtime.db, {
      q: `SELECT t.*, creator_user.name AS creator_name,
                 creator_user.avatar_url AS creator_avatar_url
          FROM workspace_templates t
          JOIN memberships creator ON creator.id = t.created_by_membership_id
          JOIN users creator_user ON creator_user.id = creator.user_id
          WHERE t.org_id = ?1
          ORDER BY t.created_at, t.id`,
      v: [principal.orgId],
    });
    const folders = await templateFolderRows(
      runtime.db,
      templates.map(({ id }) => id),
      principal.membershipId,
    );
    const byTemplate = new Map<string, TemplateFolderRow[]>();
    for (const folder of folders) {
      const existing = byTemplate.get(folder.template_id) ?? [];
      existing.push(folder);
      byTemplate.set(folder.template_id, existing);
    }
    return context.json({
      templates: templates.map((row) =>
        templateView(row, principal, byTemplate.get(row.id) ?? [])),
    });
  });

  router.post("/workspace-templates", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const principal = actor.principal;
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const input = parseCreateTemplate(await readJson(context.req.raw));
    // Fails loudly on machine types no provider claims, same as create.
    runtime.providers.vmRegistry.forMachineType(input.machineTypeId);
    for (const folderId of input.folderIds) {
      await requireFolderAccess(runtime.db, folderId, actor, "read");
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    await rows(runtime.db, {
      q: `INSERT INTO workspace_templates
          (id, org_id, name, machine_type_id, created_by_membership_id, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
      v: [id, principal.orgId, input.name, input.machineTypeId, principal.membershipId, now],
    });
    for (const folderId of input.folderIds) {
      await rows(runtime.db, {
        q: `INSERT INTO workspace_template_folders (template_id, folder_id, created_at)
            VALUES (?1, ?2, ?3)`,
        v: [id, folderId, now],
      });
    }
    const creator = await first<{ name: string; avatar_url: string | null }>(runtime.db, {
      q: "SELECT name, avatar_url FROM users WHERE id = ?1 LIMIT 1",
      v: [principal.id],
    });
    const template = templateView(
      {
        id,
        org_id: principal.orgId,
        name: input.name,
        machine_type_id: input.machineTypeId,
        created_by_membership_id: principal.membershipId,
        created_at: now,
        updated_at: now,
        creator_name: creator?.name ?? principal.id,
        creator_avatar_url: creator?.avatar_url ?? null,
      },
      principal,
      await templateFolderRows(runtime.db, [id], principal.membershipId),
    );
    return context.json({ template }, 201);
  });

  router.delete("/workspace-templates/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const template = await workspaceTemplateForCreate(
      runtime.db,
      context.req.param("id"),
      principal.orgId,
    );
    if (
      principal.role !== "admin"
      && template.created_by_membership_id !== principal.membershipId
    ) {
      throw new HttpError(403, "forbidden");
    }
    await rows(runtime.db, {
      q: "DELETE FROM workspace_template_folders WHERE template_id = ?1",
      v: [template.id],
    });
    await rows(runtime.db, {
      q: "DELETE FROM workspace_templates WHERE id = ?1",
      v: [template.id],
    });
    return context.body(null, 204);
  });
}
