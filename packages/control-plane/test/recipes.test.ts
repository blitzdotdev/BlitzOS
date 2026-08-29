import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { RecipeView, WorkspaceView } from "@blitzos/schema";
import { recipeInvocationEnvFile, shellQuote } from "../core/bootstrap.js";
import {
  appRequest,
  harness,
  operatorSession,
  resetDatabase,
  sameOrgSession,
  userSession,
} from "./helpers.js";

interface RecipeEnvelope {
  recipe: RecipeView;
}

interface WorkspaceEnvelope {
  workspace: WorkspaceView;
}

function json(body: object, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** A recipe's launch source is a WORKSPACE now (migration 0043). The wire
 * field keeps its legacy `templateId` name and carries a workspace id. */
async function createTemplate(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name = "web analysis",
): Promise<string> {
  const response = await appRequest(app, "/workspaces", {
    ...json({ name, machineTypeId: "small" }),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
  expect(response.status).toBe(201);
  return (await response.json<{ workspace: { id: string } }>()).workspace.id;
}

async function createRecipe(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  body: object,
): Promise<Response> {
  return appRequest(app, "/workspace-recipes", {
    ...json(body),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
}

describe("recipes", () => {
  beforeEach(resetDatabase);

  it("creates, lists, reads, updates, and deletes a recipe", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const templateId = await createTemplate(app, cookie);

    const created = await createRecipe(app, cookie, {
      name: "nightly evals",
      templateId,
      harness: "chat",
      model: "claude-sonnet-5",
      effort: "xhigh",
      prompt: "Aggregate usage and write evals.\n",
    });
    expect(created.status).toBe(201);
    const recipe = (await created.json<RecipeEnvelope>()).recipe;
    expect(recipe).toEqual({
      id: recipe.id,
      name: "nightly evals",
      templateId,
      harness: "chat",
      model: "claude-sonnet-5",
      effort: "xhigh",
      prompt: "Aggregate usage and write evals.\n",
    });

    const listed = await appRequest(app, "/workspace-recipes", { headers: { Cookie: cookie } });
    expect(listed.status).toBe(200);
    expect((await listed.json<{ recipes: RecipeView[] }>()).recipes).toEqual([recipe]);

    const read = await appRequest(app, `/workspace-recipes/${recipe.id}`, {
      headers: { Cookie: cookie },
    });
    expect((await read.json<RecipeEnvelope>()).recipe).toEqual(recipe);

    const updated = await appRequest(app, `/workspace-recipes/${recipe.id}`, {
      ...json({
        name: "weekly evals",
        templateId,
        harness: "claude",
        prompt: "Write evals.\n",
      }, "PUT"),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(updated.status).toBe(200);
    const replaced = (await updated.json<RecipeEnvelope>()).recipe;
    expect(replaced.name).toBe("weekly evals");
    expect(replaced.harness).toBe("claude");
    // Full replacement: the cleared model and effort disappear from the view.
    expect("model" in replaced).toBe(false);
    expect("effort" in replaced).toBe(false);

    expect((await appRequest(app, `/workspace-recipes/${recipe.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    expect((await appRequest(app, `/workspace-recipes/${recipe.id}`, {
      headers: { Cookie: cookie },
    })).status).toBe(404);
  });

  it("leaves the SPA's /recipes paths unrouted, exactly like /templates", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const templateId = await createTemplate(app, cookie);
    const created = await createRecipe(app, cookie, {
      name: "shell check",
      templateId,
      harness: "claude",
      prompt: "Go.\n",
    });
    const recipe = (await created.json<RecipeEnvelope>()).recipe;

    // The API lives under /workspace-recipes; the SPA keeps /recipes,
    // /recipes/new, and /recipes/:id/edit as pure UI paths. In production
    // those fall through to the asset layer's SPA fallback (they are not in
    // run_worker_first / API_PREFIXES); this harness has no asset layer, so
    // the observable contract is that the router does not claim them — every
    // one produces the same unrouted notFound body /templates does.
    const htmlAccept = "text/html,application/xhtml+xml";
    const templatesPage = await appRequest(app, "/templates", {
      headers: { Cookie: cookie, Accept: htmlAccept },
    });
    expect(templatesPage.status).toBe(404);
    const unroutedBody = await templatesPage.text();
    const pages = ["/recipes", "/recipes/new", `/recipes/${recipe.id}`, `/recipes/${recipe.id}/edit`];
    for (const path of pages) {
      const response = await appRequest(app, path, {
        headers: { Cookie: cookie, Accept: htmlAccept },
      });
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe(unroutedBody);
    }

    // The JSON API answers JSON regardless of the Accept header — no shell
    // branches survive on the API namespace.
    const listed = await appRequest(app, "/workspace-recipes", {
      headers: { Cookie: cookie, Accept: htmlAccept },
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("content-type")).toContain("application/json");
    expect((await listed.json<{ recipes: RecipeView[] }>()).recipes).toEqual([recipe]);
    const read = await appRequest(app, `/workspace-recipes/${recipe.id}`, {
      headers: { Cookie: cookie, Accept: htmlAccept },
    });
    expect(read.headers.get("content-type")).toContain("application/json");
    expect((await read.json<RecipeEnvelope>()).recipe).toEqual(recipe);
    // "new" is just an unknown :id on the API namespace.
    const asNew = await appRequest(app, "/workspace-recipes/new", {
      headers: { Cookie: cookie },
    });
    expect(asNew.status).toBe(404);
    expect(await asNew.json()).toEqual({ error: "recipe not found", retryAction: null });
  });

  it("enforces the write-time harness, model, and effort gates", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const templateId = await createTemplate(app, cookie);
    const base = { name: "gated", templateId, prompt: "Go.\n" };

    const cases: Array<[object, number, string]> = [
      [{ ...base, harness: "vim" }, 400, "unknown harness"],
      [{ ...base, harness: "chat" }, 400, "chat requires a model"],
      [{ ...base, harness: "chat", model: "claude-opus-99" }, 400, "model outside the catalog"],
      [{ ...base, harness: "claude", model: "gpt-5.6-sol" }, 400, "claude recipe with a codex model"],
      [{ ...base, harness: "codex", model: "claude-opus-5" }, 400, "codex recipe with a claude model"],
      [{ ...base, harness: "claude", effort: "hi gh" }, 400, "effort with whitespace"],
      [{ ...base, harness: "claude", effort: "x'high" }, 400, "effort with a quote"],
      // Shell-safe but outside the catalog: agentEffortsForModel gates the
      // value against the pinned model, or the provider base without one.
      [{ ...base, harness: "claude", effort: "ultra" }, 400, "no claude model has ultra"],
      [{ ...base, harness: "codex", effort: "max" }, 400, "max needs a gpt-5.6 model pinned"],
      [{ ...base, harness: "codex", model: "gpt-5.5", effort: "ultra" }, 400, "ultra outside gpt-5.5's efforts"],
      [{ ...base, harness: "codex", model: "gpt-5.6-luna", effort: "ultra" }, 400, "ultra is sol/terra only"],
      [{ ...base, harness: "chat", model: "gpt-5.6-luna", effort: "ultra" }, 400, "chat gates on the pinned model too"],
      [{ ...base, harness: "claude", templateId: "missing" }, 404, "unknown source workspace"],
      [{ ...base, harness: "claude", prompt: "" }, 400, "empty prompt"],
    ];
    for (const [body, status, label] of cases) {
      expect((await createRecipe(app, cookie, body)).status, label).toBe(status);
    }

    // Valid pairings pass: harness-matching model, and codex/claude models on chat.
    expect((await createRecipe(app, cookie, { ...base, harness: "claude", model: "claude-fable-5" })).status).toBe(201);
    expect((await createRecipe(app, cookie, { ...base, harness: "claude", model: "claude-opus-5" })).status).toBe(201);
    expect((await createRecipe(app, cookie, { ...base, harness: "codex", model: "gpt-5.6-sol", effort: "low" })).status).toBe(201);
    expect((await createRecipe(app, cookie, { ...base, harness: "chat", model: "gpt-5.6-sol" })).status).toBe(201);
    // Extended tiers pass exactly where the model grants them.
    expect((await createRecipe(app, cookie, { ...base, harness: "codex", effort: "xhigh" })).status).toBe(201);
    expect((await createRecipe(app, cookie, { ...base, harness: "codex", model: "gpt-5.6-terra", effort: "ultra" })).status).toBe(201);
    expect((await createRecipe(app, cookie, { ...base, harness: "chat", model: "gpt-5.6-luna", effort: "max" })).status).toBe(201);

    // Another org can neither see this org's recipes nor build on its workspace.
    const stranger = await userSession("stranger");
    expect((await createRecipe(app, stranger, { ...base, harness: "claude" })).status).toBe(404);
    const listed = await appRequest(app, "/workspace-recipes", { headers: { Cookie: stranger } });
    expect((await listed.json<{ recipes: RecipeView[] }>()).recipes).toEqual([]);
  });

  it("limits edits to the admin or the creator, like templates", async () => {
    const { app } = harness();
    const admin = await operatorSession(app);
    const author = await sameOrgSession("author");
    const bystander = await sameOrgSession("bystander");
    const templateId = await createTemplate(app, admin);

    const created = await createRecipe(app, author.cookie, {
      name: "mine",
      templateId,
      harness: "claude",
      prompt: "Go.\n",
    });
    expect(created.status).toBe(201);
    const id = (await created.json<RecipeEnvelope>()).recipe.id;
    const edit = json({ name: "hijack", templateId, harness: "claude", prompt: "Go.\n" }, "PUT");

    expect((await appRequest(app, `/workspace-recipes/${id}`, {
      ...edit,
      headers: { Cookie: bystander.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, `/workspace-recipes/${id}`, {
      method: "DELETE",
      headers: { Cookie: bystander.cookie },
    })).status).toBe(403);
    expect((await appRequest(app, `/workspace-recipes/${id}`, {
      ...edit,
      headers: { Cookie: author.cookie, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect((await appRequest(app, `/workspace-recipes/${id}`, {
      ...json({ name: "admin edit", templateId, harness: "claude", prompt: "Go.\n" }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    })).status).toBe(200);
  });

  // Launch is parked. A recipe used to launch a workspace from a template;
  // templates are gone and the replacement — clone the source workspace, then
  // deliver the invocation to the clone's machine — is a bigger change than
  // the retirement it rides on. The route says so rather than launching from a
  // source it can no longer resolve. See the TODO in core/recipes.ts.
  it("refuses a launch while recipes re-point from templates to workspace clones", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const templateId = await createTemplate(app, cookie);
    const created = await createRecipe(app, cookie, {
      name: "chat routine",
      templateId,
      harness: "chat",
      model: "gpt-5.6-sol",
      effort: "low",
      prompt: "Summarize the datasets folder.\n",
    });
    const recipe = (await created.json<RecipeEnvelope>()).recipe;
    expect(recipe.templateId).toBe(templateId);

    const launched = await appRequest(app, `/workspace-recipes/${recipe.id}/launch`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(launched.status).toBe(400);
    await expect(launched.json()).resolves.toMatchObject({
      error: expect.stringContaining("workspace clones"),
    });

    // An unknown recipe is still a 404, so the park does not swallow the
    // ordinary not-found answer.
    expect((await appRequest(app, "/workspace-recipes/missing/launch", {
      method: "POST",
      headers: { Cookie: cookie },
    })).status).toBe(404);
  });

  it("gates usage capture behind the org admin and lazy-creates the folder once", async () => {
    const { app, providers } = harness();
    const admin = await operatorSession(app);
    const member = await sameOrgSession("plain-member");

    expect((await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: true }, "PUT"),
      headers: { Cookie: member.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, "/orgs/self/usage-capture", {
      headers: { Cookie: member.cookie },
    })).status).toBe(403);

    const before = await appRequest(app, "/orgs/self/usage-capture", {
      headers: { Cookie: admin },
    });
    expect(await before.json()).toEqual({ enabled: false, folderId: null });

    const enabled = await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: true }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    expect(enabled.status).toBe(200);
    const state = await enabled.json<{ enabled: boolean; folderId: string | null }>();
    expect(state.enabled).toBe(true);
    expect(state.folderId).not.toBeNull();

    // Owned by the enabling admin, grant-private (no org_role).
    const folder = await env.DB.prepare(
      "SELECT name, org_role, created_by_membership_id FROM folders WHERE id = ?1",
    ).bind(state.folderId).first<{ name: string; org_role: string | null; created_by_membership_id: string }>();
    expect(folder?.name).toBe("Agent usage");
    expect(folder?.org_role).toBeNull();
    expect(folder?.created_by_membership_id).toBe("personal");

    // Disable keeps the folder; re-enable reuses it instead of minting another.
    const disabled = await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: false }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    expect(await disabled.json()).toEqual({ enabled: false, folderId: state.folderId });
    const reEnabled = await appRequest(app, "/orgs/self/usage-capture", {
      ...json({ enabled: true }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    expect(await reEnabled.json()).toEqual({ enabled: true, folderId: state.folderId });
    const folders = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM folders WHERE name = 'Agent usage'",
    ).first<{ total: number }>();
    expect(folders?.total).toBe(1);

    // Every create in a capturing org boots with the read-only usage mounts.
    const createdWorkspace = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    });
    const workspace = (await createdWorkspace.json<WorkspaceEnvelope>()).workspace;
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain(
      "--mount type=bind,src=/var/lib/blitz/home/.claude/projects,dst=/workspace/shared/agent-usage/claude,readonly \\",
    );
    expect(userData).toContain(
      "--mount type=bind,src=/var/lib/blitz/home/.codex/sessions,dst=/workspace/shared/agent-usage/codex,readonly \\",
    );

    // Deleting the usage folder leaves the org columns alone — a dangling
    // usage_folder_id is accepted (no foreign key, no cascade); the push leg
    // inner-joins folders and simply stops exporting (pinned in
    // usage-push.test.ts).
    expect((await appRequest(app, `/folders/${state.folderId}`, {
      method: "DELETE",
      headers: { Cookie: admin },
    })).status).toBe(204);
    const after = await appRequest(app, "/orgs/self/usage-capture", {
      headers: { Cookie: admin },
    });
    expect(await after.json()).toEqual({ enabled: true, folderId: state.folderId });
  });
});
