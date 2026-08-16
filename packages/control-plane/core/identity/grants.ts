import { first, rows } from "../db.js";
import { HttpError, isRecord, type JsonValue, readJson, requiredString } from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "../runtime.js";
import { canControlWorkspace, type WorkspaceAccessRow } from "../workspace-access.js";
import { requireWorkspaceWebAppAuth, WEBAPP_TOKEN_HEADER } from "../webapp-tickets.js";

interface GrantWorkspaceRow extends WorkspaceAccessRow {
  vm_id: string | null;
  tunnel_hostname: string | null;
}

interface GrantRow {
  id: string;
  membership_id: string;
  role: "editor" | "viewer";
  created_at: number;
  name: string;
  email: string;
  avatar_url: string | null;
}

interface CreateGrantInput {
  membershipId: string;
  role: "editor" | "viewer";
}

function parseCreateGrant(value: JsonValue): CreateGrantInput {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const membershipId = requiredString(value.membershipId, "membershipId", 256);
  if (value.role !== "editor" && value.role !== "viewer") {
    throw new HttpError(400, "role must be editor or viewer");
  }
  return { membershipId, role: value.role };
}

async function controlledWorkspace(
  runtime: CoreRuntime,
  id: string,
  principal: Principal,
): Promise<GrantWorkspaceRow> {
  const workspace = await first<GrantWorkspaceRow>(runtime.db, {
    q: `SELECT id, org_id, owner_membership_id, vm_id, tunnel_hostname
        FROM workspaces WHERE id = ?1 AND phase != 'destroyed' LIMIT 1`,
    v: [id],
  });
  if (workspace === null || workspace.org_id !== principal.orgId) {
    throw new HttpError(404, "workspace not found");
  }
  if (!canControlWorkspace(principal, workspace)) throw new HttpError(403, "forbidden");
  return workspace;
}

function grantView(row: GrantRow) {
  return {
    id: row.id,
    membershipId: row.membership_id,
    role: row.role,
    createdAt: row.created_at,
    member: { name: row.name, email: row.email, avatarUrl: row.avatar_url },
  };
}

async function requireDrainResponse(response: Response | null): Promise<void> {
  if (response === null || !response.ok) {
    throw new Error(`workspace drain failed with status ${response?.status ?? "unavailable"}`);
  }
}

function drainRequest(token: string, membershipId: string): Request {
  return new Request("https://control-plane.invalid/admin/drain", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [WEBAPP_TOKEN_HEADER]: token,
    },
    body: JSON.stringify({ membershipId }),
  });
}

async function drainWorkspace(
  runtime: CoreRuntime,
  workspace: GrantWorkspaceRow,
  membershipId: string,
): Promise<void> {
  if (workspace.vm_id === null) return;
  const provider = runtime.providers.vmRegistry.forVmId(workspace.vm_id);
  const token = await requireWorkspaceWebAppAuth(runtime.providers.webAppAuth).tokenFor(workspace.id);
  if (provider?.proxyWebApp !== undefined) {
    const drains = [provider.proxyWebApp(
      workspace.vm_id,
      7445,
      "/admin/drain",
      drainRequest(token, membershipId),
    )];
    if (provider.capabilities().webAppActorBypassesGateway === true) {
      drains.push(provider.proxyWebApp(
        workspace.vm_id,
        7444,
        "/admin/drain",
        drainRequest(token, membershipId),
      ));
    }
    const settled = await Promise.allSettled(drains);
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      await requireDrainResponse(result.value);
    }
    return;
  }
  const tunnels = runtime.providers.workspaceTunnels;
  if (tunnels === undefined || workspace.tunnel_hostname === null) {
    throw new Error("workspace drain has no gateway proxy path");
  }
  await requireDrainResponse(await tunnels.proxy(
    workspace.tunnel_hostname,
    workspace.id,
    7445,
    "/admin/drain",
    drainRequest(token, membershipId),
    token,
  ));
}

export function addGrantRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/workspaces/:id/grants", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await controlledWorkspace(runtime, context.req.param("id"), principal);
    const grants = await rows<GrantRow>(runtime.db, {
      q: `SELECT grant.id, grant.membership_id, grant.role, grant.created_at,
                 user.name, user.email, user.avatar_url
          FROM workspace_grants grant
          JOIN memberships member ON member.id = grant.membership_id
          JOIN users user ON user.id = member.user_id
          WHERE grant.workspace_id = ?1
          ORDER BY grant.created_at, grant.id`,
      v: [workspace.id],
    });
    return context.json({ grants: grants.map(grantView) });
  });

  router.post("/workspaces/:id/grants", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await controlledWorkspace(runtime, context.req.param("id"), principal);
    const input = parseCreateGrant(await readJson(context.req.raw));
    const grantee = await first<{ id: string }>(runtime.db, {
      q: `SELECT id FROM memberships
          WHERE id = ?1 AND org_id = ?2 AND status = 'active' LIMIT 1`,
      v: [input.membershipId, workspace.org_id],
    });
    if (grantee === null) throw new HttpError(400, "grantee must be an active organization member");
    if (grantee.id === workspace.owner_membership_id) {
      throw new HttpError(400, "workspace owner does not need a grant");
    }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    await rows(runtime.db, {
      q: `INSERT INTO workspace_grants
          (id, workspace_id, membership_id, role, granted_by_membership_id, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(workspace_id, membership_id) DO UPDATE SET
            role = excluded.role, granted_by_membership_id = excluded.granted_by_membership_id,
            created_at = excluded.created_at`,
      v: [id, workspace.id, input.membershipId, input.role, principal.membershipId, createdAt],
    });
    const grant = await first<GrantRow>(runtime.db, {
      q: `SELECT grant.id, grant.membership_id, grant.role, grant.created_at,
                 user.name, user.email, user.avatar_url
          FROM workspace_grants grant
          JOIN memberships member ON member.id = grant.membership_id
          JOIN users user ON user.id = member.user_id
          WHERE grant.workspace_id = ?1 AND grant.membership_id = ?2 LIMIT 1`,
      v: [workspace.id, input.membershipId],
    });
    if (grant === null) throw new Error("workspace grant disappeared after creation");
    return context.json({ grant: grantView(grant) }, 201);
  });

  router.delete("/workspaces/:id/grants/:grantId", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await controlledWorkspace(runtime, context.req.param("id"), principal);
    const deleted = await rows<{ id: string; membership_id: string }>(runtime.db, {
      q: `DELETE FROM workspace_grants
          WHERE id = ?1 AND workspace_id = ?2 RETURNING id, membership_id`,
      v: [context.req.param("grantId"), workspace.id],
    });
    if (deleted.length === 0) throw new HttpError(404, "workspace grant not found");
    const target = deleted[0];
    if (target === undefined) throw new Error("deleted workspace grant did not return a target");
    const draining = drainWorkspace(runtime, workspace, target.membership_id).catch((caught) => {
      const error = caught instanceof Error ? caught : new Error("workspace drain failed");
      runtime.reportError("workspace_grant_drain_failed", error);
    });
    try {
      runtime.waitUntil(draining);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error("workspace drain scheduling failed");
      runtime.reportError("workspace_grant_drain_schedule_failed", error);
    }
    return context.body(null, 204);
  });
}
