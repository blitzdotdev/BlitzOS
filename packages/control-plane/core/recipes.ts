import type { RecipeBootstrap } from "./bootstrap.js";
import type { Db } from "./db.js";
import { first, rows, transaction } from "./db.js";
import { WORKSPACE_REQUEST_MAX_BYTES } from "./environment.js";
import {
  HttpError,
  isBoolean,
  isRecord,
  readJson,
  requiredString,
  type JsonValue,
} from "./http.js";
import type { Principal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import {
  AGENT_MODELS,
  AGENT_PROVIDERS,
  RECIPE_HARNESSES,
  type AgentProvider,
  type CreateRecipeRequest,
  type CreateWorkspaceResponse,
  type ListRecipesResponse,
  type OrgUsageCaptureResponse,
  type RecipeHarness,
  type RecipeResponse,
  type RecipeView,
} from "./wire.js";
import { workspaceView } from "./workspace-records.js";
import { workspaceTemplateForCreate } from "./workspace-templates.js";
import { performWorkspaceCreate } from "./workspaces.js";

export interface RecipeRow {
  id: string;
  org_id: string;
  name: string;
  template_id: string;
  harness: RecipeHarness;
  model: string | null;
  effort: string | null;
  prompt: string;
  created_by_membership_id: string;
  created_at: number;
  updated_at: number;
}

const RECIPE_NAME_MAX = 64;
/** Efforts stay one shell-safe token: they land on an invocation.env line and,
 * in Phase 2, on the harness argv, so no quotes, spaces, or control bytes. */
const RECIPE_EFFORT_PATTERN = /^[A-Za-z0-9._-]{1,32}$/u;
/** Same ceiling as a startup script: the prompt rides the bootstrap payload. */
export const RECIPE_PROMPT_MAX_BYTES = 64 * 1024;

/** The org's Drive folder that receives captured agent usage. Created lazily
 * on first enable; admin-only through normal folder grants (no org_role). */
export const USAGE_FOLDER_NAME = "Agent usage";

function isRecipeHarness(value: JsonValue | undefined): value is RecipeHarness {
  return RECIPE_HARNESSES.some((harness) => harness === value);
}

export function agentProviderForModel(model: string): AgentProvider | null {
  return AGENT_PROVIDERS.find((provider) => AGENT_MODELS[provider].includes(model)) ?? null;
}

function parseRecipe(value: JsonValue): CreateRecipeRequest {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  const name = requiredString(value.name, "name", RECIPE_NAME_MAX).trim();
  if (name === "") throw new HttpError(400, "name is required");
  const templateId = requiredString(value.templateId, "templateId", 256);
  if (!isRecipeHarness(value.harness)) {
    throw new HttpError(400, "harness must be claude, codex, or chat");
  }
  const prompt = requiredString(value.prompt, "prompt", RECIPE_PROMPT_MAX_BYTES);
  if (new TextEncoder().encode(prompt).byteLength > RECIPE_PROMPT_MAX_BYTES) {
    throw new HttpError(
      400,
      `prompt must be at most ${String(RECIPE_PROMPT_MAX_BYTES)} UTF-8 bytes`,
    );
  }
  const result: CreateRecipeRequest = { name, templateId, harness: value.harness, prompt };
  if (value.model !== undefined && value.model !== null) {
    result.model = requiredString(value.model, "model", 256);
  }
  if (value.effort !== undefined && value.effort !== null) {
    const effort = requiredString(value.effort, "effort", 32);
    if (!RECIPE_EFFORT_PATTERN.test(effort)) {
      throw new HttpError(
        400,
        "effort must be letters, digits, dots, dashes, or underscores",
      );
    }
    result.effort = effort;
  }
  // Write-time harness ↔ model pairing (plans/RECIPES.md): a claude recipe
  // pins a claude model, codex a codex model; chat pins any catalog model and
  // must pin one, because that model selects the adapter provider at launch.
  const provider = result.model === undefined ? null : agentProviderForModel(result.model);
  if (result.model !== undefined && provider === null) {
    throw new HttpError(400, "model is not in the agent catalog");
  }
  if (result.harness === "chat") {
    if (provider === null) {
      throw new HttpError(400, "a chat recipe must pin a catalog model to select its provider");
    }
  } else if (provider !== null && provider !== result.harness) {
    throw new HttpError(400, `a ${result.harness} recipe may only pin a ${result.harness} model`);
  }
  return result;
}

function recipeView(row: RecipeRow): RecipeView {
  const view: RecipeView = {
    id: row.id,
    name: row.name,
    templateId: row.template_id,
    harness: row.harness,
    prompt: row.prompt,
  };
  if (row.model !== null) view.model = row.model;
  if (row.effort !== null) view.effort = row.effort;
  return view;
}

async function recipeForOrg(db: Db, id: string, orgId: string): Promise<RecipeRow> {
  const recipe = await first<RecipeRow>(db, {
    q: "SELECT * FROM recipes WHERE id = ?1 LIMIT 1",
    v: [id],
  });
  if (recipe === null || recipe.org_id !== orgId) {
    throw new HttpError(404, "recipe not found");
  }
  return recipe;
}

/** Edit rights match templates: the org admin or the creator. */
function requireRecipeEditRights(principal: Principal, recipe: RecipeRow): void {
  if (
    principal.role !== "admin"
    && recipe.created_by_membership_id !== principal.membershipId
  ) {
    throw new HttpError(403, "forbidden");
  }
}

/** The launch's bootstrap additions, derived from a validated row. Rows are
 * validated at write time, but a chat model can leave the catalog later, so
 * the launch re-derives the provider and refuses loudly instead of booting a
 * box whose BLITZ_AGENT nobody chose. */
function recipeBootstrap(recipe: RecipeRow): RecipeBootstrap {
  const agentProvider = recipe.harness === "chat"
    ? (recipe.model === null ? null : agentProviderForModel(recipe.model))
    : recipe.harness;
  if (agentProvider === null) {
    throw new HttpError(409, "recipe model is no longer in the agent catalog; edit the recipe");
  }
  const bootstrap: RecipeBootstrap = {
    harness: recipe.harness,
    agentProvider,
    prompt: recipe.prompt,
  };
  if (recipe.model !== null) bootstrap.model = recipe.model;
  if (recipe.effort !== null) bootstrap.effort = recipe.effort;
  return bootstrap;
}

export function addRecipeRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  async function memberFor(context: CoreContext): Promise<Principal & { orgId: string }> {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null) {
      throw new HttpError(403, "active membership required");
    }
    // SAFETY: orgId was null-checked immediately above; the intersection only narrows that one property.
    return principal as Principal & { orgId: string };
  }

  router.get("/recipes", async (context) => {
    // The SPA's recipes page shares this path. A browser refresh navigates
    // here with an HTML accept; serve the app shell and keep JSON for fetch
    // callers (same pattern as GET /workspaces/:id).
    const runtime = runtimeFactory(context);
    if (
      runtime.assets !== undefined
      && (context.req.header("accept") ?? "").includes("text/html")
    ) {
      return runtime.assets.fetch(context.req.raw);
    }
    const principal = await memberFor(context);
    const recipes = await rows<RecipeRow>(runtime.db, {
      q: "SELECT * FROM recipes WHERE org_id = ?1 ORDER BY created_at, id",
      v: [principal.orgId],
    });
    return context.json<ListRecipesResponse>({ recipes: recipes.map(recipeView) });
  });

  router.post("/recipes", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await memberFor(context);
    const input = parseRecipe(await readJson(context.req.raw, WORKSPACE_REQUEST_MAX_BYTES));
    // 404s unknown or foreign templates before anything is written.
    await workspaceTemplateForCreate(runtime.db, input.templateId, principal.orgId);
    const id = crypto.randomUUID();
    const now = Date.now();
    await rows(runtime.db, {
      q: `INSERT INTO recipes
          (id, org_id, name, template_id, harness, model, effort, prompt,
           created_by_membership_id, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
      v: [
        id,
        principal.orgId,
        input.name,
        input.templateId,
        input.harness,
        input.model ?? null,
        input.effort ?? null,
        input.prompt,
        principal.membershipId,
        now,
      ],
    });
    return context.json<RecipeResponse>({
      recipe: recipeView(await recipeForOrg(runtime.db, id, principal.orgId)),
    }, 201);
  });

  router.get("/recipes/:id", async (context) => {
    // Browser navigations land here too — including /recipes/new, which this
    // :id route swallows. Serve the app shell for HTML accepts; JSON callers
    // keep the API (and "new" stays the recipe-not-found 404 it always was).
    const runtime = runtimeFactory(context);
    if (
      runtime.assets !== undefined
      && (context.req.header("accept") ?? "").includes("text/html")
    ) {
      return runtime.assets.fetch(context.req.raw);
    }
    const principal = await memberFor(context);
    const recipe = await recipeForOrg(runtime.db, context.req.param("id"), principal.orgId);
    return context.json<RecipeResponse>({ recipe: recipeView(recipe) });
  });

  router.get("/recipes/:id/edit", async (context) => {
    // SPA-only path with no API twin: a browser refresh on the edit page gets
    // the app shell; non-HTML callers get the same body the unrouted path
    // produced before this route existed (the notFound JSON, byte-identical).
    const runtime = runtimeFactory(context);
    if (
      runtime.assets !== undefined
      && (context.req.header("accept") ?? "").includes("text/html")
    ) {
      return runtime.assets.fetch(context.req.raw);
    }
    throw new HttpError(404, "not found");
  });

  router.put("/recipes/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await memberFor(context);
    const recipe = await recipeForOrg(runtime.db, context.req.param("id"), principal.orgId);
    requireRecipeEditRights(principal, recipe);
    // Full replacement with the create shape, like template edits.
    const input = parseRecipe(await readJson(context.req.raw, WORKSPACE_REQUEST_MAX_BYTES));
    await workspaceTemplateForCreate(runtime.db, input.templateId, principal.orgId);
    await rows(runtime.db, {
      q: `UPDATE recipes
          SET name = ?2, template_id = ?3, harness = ?4, model = ?5,
              effort = ?6, prompt = ?7, updated_at = ?8
          WHERE id = ?1`,
      v: [
        recipe.id,
        input.name,
        input.templateId,
        input.harness,
        input.model ?? null,
        input.effort ?? null,
        input.prompt,
        Date.now(),
      ],
    });
    return context.json<RecipeResponse>({
      recipe: recipeView(await recipeForOrg(runtime.db, recipe.id, principal.orgId)),
    });
  });

  router.delete("/recipes/:id", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await memberFor(context);
    const recipe = await recipeForOrg(runtime.db, context.req.param("id"), principal.orgId);
    requireRecipeEditRights(principal, recipe);
    // Workspaces keep running when their recipe goes; provenance nulls out
    // first so the delete cannot trip the foreign key (same pattern as
    // agent-rules deletion).
    await transaction(runtime.db, [
      { q: "UPDATE workspaces SET recipe_id = NULL WHERE recipe_id = ?1", v: [recipe.id] },
      { q: "DELETE FROM recipes WHERE id = ?1", v: [recipe.id] },
    ]);
    return context.body(null, 204);
  });

  router.post("/recipes/:id/launch", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await memberFor(context);
    const recipe = await recipeForOrg(runtime.db, context.req.param("id"), principal.orgId);
    const template = await workspaceTemplateForCreate(
      runtime.db,
      recipe.template_id,
      principal.orgId,
    );
    // The existing create path does everything else: template machine-type
    // default, environment and agent-rule inheritance, folder attach with the
    // launcher as principal (unreadable folders are skipped, not leaked), and
    // the vm_limit 409, which passes straight through to the caller.
    const row = await performWorkspaceCreate(
      runtime,
      principal,
      new URL(context.req.url).origin,
      { templateId: template.id },
      { recipeId: recipe.id, bootstrap: recipeBootstrap(recipe) },
    );
    return context.json<CreateWorkspaceResponse>({ workspace: workspaceView(row, "owner") }, 201);
  });

  async function requireAdmin(context: CoreContext): Promise<Principal & { orgId: string }> {
    const principal = await memberFor(context);
    if (principal.role !== "admin") throw new HttpError(403, "organization admin required");
    return principal;
  }

  interface OrgUsageRow {
    usage_capture: number;
    usage_folder_id: string | null;
  }

  async function orgUsageRow(db: Db, orgId: string): Promise<OrgUsageRow> {
    const org = await first<OrgUsageRow>(db, {
      q: "SELECT usage_capture, usage_folder_id FROM orgs WHERE id = ?1 LIMIT 1",
      v: [orgId],
    });
    if (org === null) throw new HttpError(404, "organization not found");
    return org;
  }

  router.get("/orgs/self/usage-capture", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requireAdmin(context);
    const org = await orgUsageRow(runtime.db, principal.orgId);
    return context.json<OrgUsageCaptureResponse>({
      enabled: org.usage_capture === 1,
      folderId: org.usage_folder_id,
    });
  });

  router.put("/orgs/self/usage-capture", async (context) => {
    const runtime = runtimeFactory(context);
    const principal = await requireAdmin(context);
    const value = await readJson(context.req.raw);
    if (!isRecord(value) || !isBoolean(value.enabled)) {
      throw new HttpError(400, "enabled must be a boolean");
    }
    const org = await orgUsageRow(runtime.db, principal.orgId);
    let folderId = org.usage_folder_id;
    if (value.enabled && folderId === null) {
      // First enable: lazy-create the org usage Drive folder, owned by the
      // enabling admin and deliberately without an org_role — transcripts
      // stay private to explicit grants, and the push leg never materializes
      // this folder into member workspaces.
      folderId = crypto.randomUUID();
      const now = Date.now();
      await rows(runtime.db, {
        q: `INSERT INTO folders
            (id, org_id, name, created_by_membership_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
        v: [folderId, principal.orgId, USAGE_FOLDER_NAME, principal.membershipId, now],
      });
    }
    // A disable keeps the folder and its id so a re-enable appends to the
    // same corpus instead of scattering it.
    await rows(runtime.db, {
      q: "UPDATE orgs SET usage_capture = ?2, usage_folder_id = ?3, updated_at = ?4 WHERE id = ?1",
      v: [principal.orgId, value.enabled ? 1 : 0, folderId, Date.now()],
    });
    return context.json<OrgUsageCaptureResponse>({
      enabled: value.enabled,
      folderId,
    });
  });
}
