import { agentRuleIdForOrg } from "./agent-rules.js";
import type { Db } from "./db.js";
import { first, rows } from "./db.js";
import {
  parseWorkspaceEnvironment,
  workspaceEnvironmentFromJson,
  storedWorkspaceEnvironment,
  WORKSPACE_REQUEST_MAX_BYTES,
} from "./environment.js";
import { filesActorForRequest, folderRole, requireFolderAccess } from "./files/access.js";
import {
  HttpError,
  isRecord,
  isString,
  readJson,
  requiredString,
  type JsonValue,
} from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type { TemplateConnectionView, WorkspaceEnvironment, WorkspaceTemplateView } from "./wire.js";

export interface WorkspaceTemplateRow {
  id: string;
  org_id: string;
  name: string;
  machine_type_id: string;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
  environment: string | null;
  agent_rule_id: string | null;
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
  connections: TemplateConnectionView[];
  environment?: WorkspaceEnvironment;
  agentRuleId?: string | null;
}

interface TemplateConnectionRow {
  template_id: string;
  provider: string;
  required: number;
}

const MAX_TEMPLATE_FOLDERS = 16;
const MAX_TEMPLATE_CONNECTIONS = 16;

function parseTemplateConnections(value: JsonValue | undefined): TemplateConnectionView[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "connections must be an array");
  const byProvider = new Map<string, TemplateConnectionView>();
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      throw new HttpError(400, `connections[${String(index)}] must be an object`);
    }
    const provider = requiredString(entry.provider, `connections[${String(index)}].provider`, 64);
    if (entry.required !== undefined && entry.required !== true && entry.required !== false) {
      throw new HttpError(400, `connections[${String(index)}].required must be a boolean`);
    }
    byProvider.set(provider, { provider, required: entry.required === true });
  }
  if (byProvider.size > MAX_TEMPLATE_CONNECTIONS) {
    throw new HttpError(
      400,
      `connections must have at most ${String(MAX_TEMPLATE_CONNECTIONS)} entries`,
    );
  }
  return [...byProvider.values()];
}

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
  const result: CreateTemplateInput = {
    name,
    machineTypeId,
    folderIds,
    connections: parseTemplateConnections(value.connections),
  };
  if (value.environment !== undefined) {
    result.environment = parseWorkspaceEnvironment(value.environment);
  }
  if (value.agentRuleId !== undefined) {
    if (!(value.agentRuleId === null || isString(value.agentRuleId))) {
      throw new HttpError(400, "agentRuleId must be a string or null");
    }
    result.agentRuleId = value.agentRuleId;
  }
  return result;
}

async function templateConnectionRows(
  db: Db,
  templateIds: string[],
): Promise<TemplateConnectionRow[]> {
  if (templateIds.length === 0) return [];
  return rows<TemplateConnectionRow>(db, {
    q: `SELECT template_id, provider, required
        FROM workspace_template_connections
        WHERE template_id IN (${templateIds.map((_id, index) => `?${String(index + 1)}`).join(",")})
        ORDER BY created_at, provider`,
    v: templateIds,
  });
}

/** Template connections referenced by name; the creator supplies the identity
 * at instantiate. Full replacement matches the folder set's edit semantics. */
async function replaceTemplateConnections(
  db: Db,
  templateId: string,
  connections: readonly TemplateConnectionView[],
  now: number,
): Promise<void> {
  await rows(db, {
    q: "DELETE FROM workspace_template_connections WHERE template_id = ?1",
    v: [templateId],
  });
  for (const connection of connections) {
    await rows(db, {
      q: `INSERT INTO workspace_template_connections
          (template_id, provider, required, created_at)
          VALUES (?1, ?2, ?3, ?4)`,
      v: [templateId, connection.provider, connection.required ? 1 : 0, now],
    });
  }
}

export async function templateConnections(
  db: Db,
  templateId: string,
): Promise<TemplateConnectionView[]> {
  return (await templateConnectionRows(db, [templateId])).map((row) => ({
    provider: row.provider,
    required: row.required === 1,
  }));
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

/** Workspaces created from a template are named after it; live name twins in
 * the org get a numbered suffix so the rail stays tellable-apart. Purely a
 * display convention — names are not unique, and a racing create may repeat
 * a suffix. */
export async function templateWorkspaceName(
  db: Db,
  orgId: string,
  templateName: string,
): Promise<string> {
  const base = templateName.slice(0, 59).trim();
  const candidates = [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${String(i + 2)}`)];
  const taken = new Set(
    (await rows<{ name: string }>(db, {
      q: `SELECT name FROM workspaces
          WHERE org_id = ?1 AND phase != 'destroyed'
            AND name IN (${candidates.map((_, i) => `?${String(i + 2)}`).join(",")})`,
      v: [orgId, ...candidates],
    })).map(({ name }) => name),
  );
  return candidates.find((candidate) => !taken.has(candidate))
    ?? `${base}-${crypto.randomUUID().slice(0, 4)}`;
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
  connections: TemplateConnectionRow[],
): WorkspaceTemplateView {
  return {
    id: row.id,
    name: row.name,
    machineTypeId: row.machine_type_id,
    createdAt: row.created_at,
    createdBy: { name: row.creator_name, avatarUrl: row.creator_avatar_url },
    environment: workspaceEnvironmentFromJson(row.environment),
    agentRuleId: row.agent_rule_id,
    folders: folders.map((folder) => ({
      id: folder.folder_id,
      name: folder.name,
      role: folderRole(principal, folder),
    })),
    connections: connections.map((connection) => ({
      provider: connection.provider,
      required: connection.required === 1,
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
    const connections = await templateConnectionRows(
      runtime.db,
      templates.map(({ id }) => id),
    );
    const connectionsByTemplate = new Map<string, TemplateConnectionRow[]>();
    for (const connection of connections) {
      const existing = connectionsByTemplate.get(connection.template_id) ?? [];
      existing.push(connection);
      connectionsByTemplate.set(connection.template_id, existing);
    }
    return context.json({
      templates: templates.map((row) => templateView(
        row,
        principal,
        byTemplate.get(row.id) ?? [],
        connectionsByTemplate.get(row.id) ?? [],
      )),
    });
  });

  router.post("/workspace-templates", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const principal = actor.principal;
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    const input = parseCreateTemplate(await readJson(context.req.raw, WORKSPACE_REQUEST_MAX_BYTES));
    // Fails loudly on machine types no provider claims, same as create.
    runtime.providers.vmRegistry.forMachineType(input.machineTypeId);
    for (const folderId of input.folderIds) {
      await requireFolderAccess(runtime.db, folderId, actor, "read");
    }
    const agentRuleId = await agentRuleIdForOrg(runtime.db, input.agentRuleId, principal.orgId);
    const id = crypto.randomUUID();
    const now = Date.now();
    await rows(runtime.db, {
      q: `INSERT INTO workspace_templates
          (id, org_id, name, machine_type_id, created_by_membership_id,
           created_at, updated_at, environment, agent_rule_id)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)`,
      v: [
        id,
        principal.orgId,
        input.name,
        input.machineTypeId,
        principal.membershipId,
        now,
        storedWorkspaceEnvironment(input.environment),
        agentRuleId,
      ],
    });
    for (const folderId of input.folderIds) {
      await rows(runtime.db, {
        q: `INSERT INTO workspace_template_folders (template_id, folder_id, created_at)
            VALUES (?1, ?2, ?3)`,
        v: [id, folderId, now],
      });
    }
    await replaceTemplateConnections(runtime.db, id, input.connections, now);
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
        environment: storedWorkspaceEnvironment(input.environment),
        agent_rule_id: agentRuleId,
        creator_name: creator?.name ?? principal.id,
        creator_avatar_url: creator?.avatar_url ?? null,
      },
      principal,
      await templateFolderRows(runtime.db, [id], principal.membershipId),
      await templateConnectionRows(runtime.db, [id]),
    );
    return context.json({ template }, 201);
  });

  router.put("/workspace-templates/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const actor = await filesActorForRequest(runtime, context, requirePrincipal);
    const principal = actor.principal;
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
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
    // Full replacement with the create shape: the edit form always submits
    // name, machine, the complete folder set, and the environment, so an edit
    // that cleared the environment sends the empty one rather than dropping it.
    // Only newly added folders need read access — an admin may edit a template
    // whose existing folders were never shared with them, and keeping those
    // must not fail or drop. `agentRuleId` is replaced only when the request
    // actually carries the key: the edit form does not render the picker and
    // omits it, and blanking a stored rule because a field was absent is not an
    // edit anyone asked for. A request that does send it — including an explicit
    // null to clear it — gets what it asked for rather than a silent drop.
    const input = parseCreateTemplate(await readJson(context.req.raw, WORKSPACE_REQUEST_MAX_BYTES));
    runtime.providers.vmRegistry.forMachineType(input.machineTypeId);
    const existingFolderIds = new Set(
      (await templateFolderRows(runtime.db, [template.id], principal.membershipId))
        .map(({ folder_id }) => folder_id),
    );
    for (const folderId of input.folderIds) {
      if (existingFolderIds.has(folderId)) continue;
      await requireFolderAccess(runtime.db, folderId, actor, "read");
    }
    // Resolved before the first write so an unknown rule 404s the whole edit
    // rather than half-applying it.
    const agentRuleId = input.agentRuleId === undefined
      ? undefined
      : await agentRuleIdForOrg(runtime.db, input.agentRuleId, principal.orgId);
    const now = Date.now();
    await rows(runtime.db, {
      q: `UPDATE workspace_templates
          SET name = ?2, machine_type_id = ?3, updated_at = ?4, environment = ?5
          WHERE id = ?1`,
      v: [
        template.id,
        input.name,
        input.machineTypeId,
        now,
        storedWorkspaceEnvironment(input.environment),
      ],
    });
    if (agentRuleId !== undefined) {
      await rows(runtime.db, {
        q: "UPDATE workspace_templates SET agent_rule_id = ?2 WHERE id = ?1",
        v: [template.id, agentRuleId],
      });
    }
    await rows(runtime.db, {
      q: "DELETE FROM workspace_template_folders WHERE template_id = ?1",
      v: [template.id],
    });
    for (const folderId of input.folderIds) {
      await rows(runtime.db, {
        q: `INSERT INTO workspace_template_folders (template_id, folder_id, created_at)
            VALUES (?1, ?2, ?3)`,
        v: [template.id, folderId, now],
      });
    }
    await replaceTemplateConnections(runtime.db, template.id, input.connections, now);
    const updated = await first<TemplateListRow>(runtime.db, {
      q: `SELECT t.*, creator_user.name AS creator_name,
                 creator_user.avatar_url AS creator_avatar_url
          FROM workspace_templates t
          JOIN memberships creator ON creator.id = t.created_by_membership_id
          JOIN users creator_user ON creator_user.id = creator.user_id
          WHERE t.id = ?1 LIMIT 1`,
      v: [template.id],
    });
    if (updated === null) throw new HttpError(404, "workspace template not found");
    return context.json({
      template: templateView(
        updated,
        principal,
        await templateFolderRows(runtime.db, [template.id], principal.membershipId),
        await templateConnectionRows(runtime.db, [template.id]),
      ),
    });
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
    // Recipes hold a NOT NULL reference to their template; deleting it out
    // from under them would leave routines that can never launch (and D1
    // enforces the key). Refuse loudly instead of cascading a delete the
    // caller did not ask for — and name the blockers so the caller can act.
    const referencingRecipes = await rows<{ name: string }>(runtime.db, {
      q: "SELECT name FROM recipes WHERE template_id = ?1 ORDER BY created_at, id",
      v: [template.id],
    });
    if (referencingRecipes.length > 0) {
      const count = referencingRecipes.length;
      const names = referencingRecipes.map(({ name }) => name).join(", ");
      throw new HttpError(
        409,
        `delete the ${String(count)} recipe${count === 1 ? "" : "s"} using this template first: ${names}`,
      );
    }
    await rows(runtime.db, {
      q: "DELETE FROM workspace_template_folders WHERE template_id = ?1",
      v: [template.id],
    });
    await rows(runtime.db, {
      q: "DELETE FROM workspace_template_connections WHERE template_id = ?1",
      v: [template.id],
    });
    await rows(runtime.db, {
      q: "DELETE FROM workspace_templates WHERE id = ?1",
      v: [template.id],
    });
    return context.body(null, 204);
  });
}
