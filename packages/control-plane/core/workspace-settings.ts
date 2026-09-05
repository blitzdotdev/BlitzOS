import { agentRuleIdForOrg } from "./agent-rules.js";
import { probedRepos } from "./connections/github-repo-check.js";
import { githubCallerCredential } from "./connections/github-repositories.js";
import { rows, type Query } from "./db.js";
import {
  HttpError,
  isBoolean,
  isRecord,
  readJson,
  requiredString,
  type JsonValue,
} from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, CoreRuntime, RuntimeFactory } from "./runtime.js";
import {
  MAX_WORKSPACE_REPOS,
  WORKSPACE_REPO_PATTERN,
  insertWorkspaceRepos,
  workspaceRepos,
} from "./workspace-repos.js";
import {
  legacyRole,
  workspaceAccess,
  workspaceForAdminWrite,
} from "./workspace-access.js";
import { projectWorkspace } from "./workspace-projection.js";
import { workspaceById, type WorkspaceRow } from "./workspace-records.js";
import type {
  AddWorkspaceRepoRequest,
  CreateWorkspaceResponse,
  ListWorkspaceReposResponse,
  UpdateWorkspaceRequest,
} from "./wire.js";

const WORKSPACE_NAME_MAX_LENGTH = 256;

export function parseUpdateWorkspace(value: JsonValue): UpdateWorkspaceRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const result: UpdateWorkspaceRequest = {};
  if (value.name !== undefined) {
    result.name = requiredString(value.name, "name", WORKSPACE_NAME_MAX_LENGTH);
  }
  if (value.defaultMachineTypeId !== undefined) {
    result.defaultMachineTypeId = requiredString(
      value.defaultMachineTypeId,
      "defaultMachineTypeId",
      256,
    );
  }
  if (value.autoProvision !== undefined) {
    if (!isBoolean(value.autoProvision)) {
      throw new HttpError(400, "autoProvision must be a boolean");
    }
    result.autoProvision = value.autoProvision;
  }
  // An explicit null is the way back to the built-in doc, so it is a value
  // here and not the same thing as an absent field.
  if (value.agentRuleId !== undefined) {
    result.agentRuleId = value.agentRuleId === null
      ? null
      : requiredString(value.agentRuleId, "agentRuleId", 256);
  }
  return result;
}

function parseAddWorkspaceRepo(value: JsonValue): AddWorkspaceRepoRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const repo = requiredString(value.repo, "repo", 256);
  if (!WORKSPACE_REPO_PATTERN.test(repo)) {
    throw new HttpError(400, `repo must be "owner/name": ${repo}`);
  }
  return { repo };
}

/** The settings write as one UPDATE, built from the fields the body carried.
 *
 * An absent field is left alone rather than reset, so the four controls on the
 * settings tab can each write on their own. The revision bump is what makes a
 * poller notice: a workspace has no lifecycle of its own, and this is the
 * counter its clients already watch. */
function updateWorkspaceQuery(
  id: string,
  input: UpdateWorkspaceRequest,
  agentRuleId: string | null,
): Query {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  if (input.name !== undefined) {
    values.push(input.name);
    assignments.push(`name = ?${String(values.length)}`);
  }
  if (input.defaultMachineTypeId !== undefined) {
    values.push(input.defaultMachineTypeId);
    assignments.push(`default_machine_type_id = ?${String(values.length)}`);
  }
  if (input.autoProvision !== undefined) {
    values.push(input.autoProvision ? 1 : 0);
    assignments.push(`auto_provision = ?${String(values.length)}`);
  }
  if (input.agentRuleId !== undefined) {
    values.push(agentRuleId);
    assignments.push(`agent_rule_id = ?${String(values.length)}`);
  }
  values.push(Date.now());
  assignments.push(`revision = revision + 1`, `updated_at = ?${String(values.length)}`);
  values.push(id);
  return {
    q: `UPDATE workspaces SET ${assignments.join(", ")} WHERE id = ?${String(values.length)}`,
    v: values,
  };
}

/** The workspace a repo read names, for anybody who can open it. Reading the
 * clone list is not an administrative act: it describes what the box holds,
 * which every member of the workspace already sees on their own machine. */
async function workspaceForRepoRead(
  runtime: CoreRuntime,
  principal: Principal,
  id: string,
): Promise<WorkspaceRow> {
  const workspace = await workspaceById(runtime.db, id);
  if (
    workspace === null
    || workspace.org_id !== principal.orgId
    || workspace.deleted_at !== null
  ) {
    throw new HttpError(404, "workspace not found");
  }
  const access = await workspaceAccess(runtime.db, principal, workspace);
  if (legacyRole(access) === null) throw new HttpError(403, "forbidden");
  return workspace;
}

/**
 * Workspace settings and the workspace's own repository list.
 *
 * Split out of `core/workspaces.ts` rather than added to it: that file is over
 * the 700-line warn and the house rule is to split on touch. Every route here
 * is workspace-admin work (plans/MEMBER-MACHINES.md §3, first matrix row),
 * except the repo read, which any member of the workspace may make.
 *
 * Registered ahead of `addWorkspaceRoutes`, because `/workspaces/:id/repos` is
 * a literal path under the same prefix as its parameterised routes.
 */
export function addWorkspaceSettingsRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  /**
   * The settings write of §3.
   *
   * `defaultMachineTypeId` is validated against the machine-type registry the
   * moment it is written, so a workspace cannot hold a type no provider claims
   * and fail later at every provision instead. It changes what a FUTURE
   * machine takes and nothing else: an existing machine carries its own type,
   * and moving one is `SetMachineType` (§1a).
   */
  router.patch("/workspaces/:id", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForAdminWrite(
      runtime.db,
      principal,
      context.req.param("id"),
    );
    const input = parseUpdateWorkspace(await readJson(context.req.raw, 4 * 1024));
    if (input.defaultMachineTypeId !== undefined) {
      // Throws 400 for an unknown or ambiguously-claimed type. The registry is
      // the only authority on what a type id means (VM provider architecture).
      runtime.providers.vmRegistry.forMachineType(input.defaultMachineTypeId);
    }
    const agentRuleId = input.agentRuleId === undefined
      ? null
      : await agentRuleIdForOrg(runtime.db, input.agentRuleId, workspace.org_id);
    await rows(runtime.db, updateWorkspaceQuery(workspace.id, input, agentRuleId));
    const updated = await workspaceById(runtime.db, workspace.id);
    if (updated === null) throw new Error("workspace disappeared during update");
    return context.json<CreateWorkspaceResponse>({
      workspace: await projectWorkspace(runtime.db, principal, updated),
    });
  });

  router.get("/workspaces/:id/repos", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForRepoRead(runtime, principal, context.req.param("id"));
    return context.json<ListWorkspaceReposResponse>({
      repos: await workspaceRepos(runtime.db, workspace.id),
    });
  });

  /**
   * Adds one repo to the list.
   *
   * Privacy is derived here with the caller's own GitHub credential, exactly
   * as create derives it, and a private repo without an App grant is refused:
   * a clone that cannot authenticate waits 600 seconds before it records the
   * failure, so the refusal belongs at save time.
   *
   * The list takes effect at the next provision. The box clones at boot, so a
   * machine that is already running keeps what it cloned until it recreates.
   */
  router.post("/workspaces/:id/repos", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForAdminWrite(
      runtime.db,
      principal,
      context.req.param("id"),
    );
    const { repo } = parseAddWorkspaceRepo(await readJson(context.req.raw, 4 * 1024));
    const existing = await workspaceRepos(runtime.db, workspace.id);
    if (existing.some((entry) => entry.repo === repo)) {
      throw new HttpError(409, `repository ${repo} is already in this workspace`);
    }
    if (existing.length >= MAX_WORKSPACE_REPOS) {
      throw new HttpError(
        400,
        `a workspace holds at most ${String(MAX_WORKSPACE_REPOS)} repositories`,
      );
    }
    // Every repo clones into /workspace/<name>, so two repos sharing a name
    // would fight over one directory. The same rule create validates the whole
    // list against, applied to the one row being added.
    const basename = repo.slice(repo.indexOf("/") + 1);
    const twin = existing.find((entry) =>
      entry.repo.slice(entry.repo.indexOf("/") + 1) === basename);
    if (twin !== undefined) {
      throw new HttpError(400, `repos ${twin.repo} and ${repo} clone into the same directory`);
    }
    const credential = await githubCallerCredential(runtime, principal.id);
    const [probed] = await probedRepos([repo], credential?.token ?? null);
    if (probed === undefined) throw new Error("repository probe produced no verdict");
    if (probed.private && credential?.kind !== "oauth") {
      throw new HttpError(
        409,
        "connect GitHub through the App before adding a private repository",
      );
    }
    await insertWorkspaceRepos(runtime.db, workspace.id, [probed]);
    return context.json<ListWorkspaceReposResponse>({
      repos: await workspaceRepos(runtime.db, workspace.id),
    }, 201);
  });

  /** Removes one repo. The path carries "owner/name" as its own two segments,
   * because a slash inside one path parameter is not a thing a router can
   * hand back intact. */
  router.delete("/workspaces/:id/repos/:owner/:name", async (context) => {
    const principal = await requirePrincipal(context);
    const runtime = runtimeFactory(context);
    const workspace = await workspaceForAdminWrite(
      runtime.db,
      principal,
      context.req.param("id"),
    );
    const repo = `${context.req.param("owner")}/${context.req.param("name")}`;
    const removed = await rows<{ repo: string }>(runtime.db, {
      q: `DELETE FROM workspace_repos WHERE workspace_id = ?1 AND repo = ?2
          RETURNING repo`,
      v: [workspace.id, repo],
    });
    if (removed.length === 0) throw new HttpError(404, "workspace repository not found");
    return context.body(null, 204);
  });
}
