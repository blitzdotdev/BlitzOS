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

async function createTemplate(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  name = "web analysis",
  folderIds: string[] = [],
): Promise<string> {
  const response = await appRequest(app, "/workspace-templates", {
    ...json({ name, machineTypeId: "small", folderIds }),
    headers: { Cookie: cookie, "Content-Type": "application/json" },
  });
  expect(response.status).toBe(201);
  return (await response.json<{ template: { id: string } }>()).template.id;
}

async function createRecipe(
  app: ReturnType<typeof harness>["app"],
  cookie: string,
  body: object,
): Promise<Response> {
  return appRequest(app, "/recipes", {
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

    const listed = await appRequest(app, "/recipes", { headers: { Cookie: cookie } });
    expect(listed.status).toBe(200);
    expect((await listed.json<{ recipes: RecipeView[] }>()).recipes).toEqual([recipe]);

    const read = await appRequest(app, `/recipes/${recipe.id}`, { headers: { Cookie: cookie } });
    expect((await read.json<RecipeEnvelope>()).recipe).toEqual(recipe);

    const updated = await appRequest(app, `/recipes/${recipe.id}`, {
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

    expect((await appRequest(app, `/recipes/${recipe.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    expect((await appRequest(app, `/recipes/${recipe.id}`, {
      headers: { Cookie: cookie },
    })).status).toBe(404);
  });

  it("serves the app shell to browser navigations and keeps JSON for fetch callers", async () => {
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

    // Every SPA recipes page serves the shell on an HTML accept — including
    // /recipes/new (swallowed by :id) and the SPA-only edit path. The branch
    // runs before auth, like /workspaces/:id, so a logged-out refresh works.
    const htmlAccept = "text/html,application/xhtml+xml";
    const pages = ["/recipes", "/recipes/new", `/recipes/${recipe.id}`, `/recipes/${recipe.id}/edit`];
    for (const path of pages) {
      const shell = await appRequest(app, path, {
        headers: { Cookie: cookie, Accept: htmlAccept },
      });
      expect(shell.status, path).toBe(200);
      expect(shell.headers.get("content-type"), path).toContain("text/html");
      expect(await shell.text(), path).toContain("webapp shell");
    }
    const loggedOut = await appRequest(app, "/recipes", { headers: { Accept: htmlAccept } });
    expect(loggedOut.headers.get("content-type")).toContain("text/html");

    // Without the HTML accept the API is untouched: list and read stay JSON,
    // /recipes/new stays the :id 404, and the edit path keeps the unrouted
    // notFound body.
    const listed = await appRequest(app, "/recipes", { headers: { Cookie: cookie } });
    expect(listed.headers.get("content-type")).toContain("application/json");
    expect((await listed.json<{ recipes: RecipeView[] }>()).recipes).toEqual([recipe]);
    const read = await appRequest(app, `/recipes/${recipe.id}`, { headers: { Cookie: cookie } });
    expect((await read.json<RecipeEnvelope>()).recipe).toEqual(recipe);
    const asNew = await appRequest(app, "/recipes/new", { headers: { Cookie: cookie } });
    expect(asNew.status).toBe(404);
    expect(await asNew.json()).toEqual({ error: "recipe not found", retryAction: null });
    const asEdit = await appRequest(app, `/recipes/${recipe.id}/edit`, {
      headers: { Cookie: cookie },
    });
    expect(asEdit.status).toBe(404);
    expect(await asEdit.json()).toEqual({ error: "not found", retryAction: null });
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
      [{ ...base, harness: "claude", model: "gpt-5" }, 400, "claude recipe with a codex model"],
      [{ ...base, harness: "codex", model: "claude-opus-5" }, 400, "codex recipe with a claude model"],
      [{ ...base, harness: "claude", effort: "hi gh" }, 400, "effort with whitespace"],
      [{ ...base, harness: "claude", effort: "x'high" }, 400, "effort with a quote"],
      [{ ...base, harness: "claude", templateId: "missing" }, 404, "unknown template"],
      [{ ...base, harness: "claude", prompt: "" }, 400, "empty prompt"],
    ];
    for (const [body, status, label] of cases) {
      expect((await createRecipe(app, cookie, body)).status, label).toBe(status);
    }

    // Valid pairings pass: harness-matching model, and codex/claude models on chat.
    expect((await createRecipe(app, cookie, { ...base, harness: "claude", model: "claude-opus-5" })).status).toBe(201);
    expect((await createRecipe(app, cookie, { ...base, harness: "codex", model: "gpt-5-codex", effort: "low" })).status).toBe(201);
    expect((await createRecipe(app, cookie, { ...base, harness: "chat", model: "gpt-5" })).status).toBe(201);

    // Another org can neither see this org's recipes nor build on its template.
    const stranger = await userSession("stranger");
    expect((await createRecipe(app, stranger, { ...base, harness: "claude" })).status).toBe(404);
    const listed = await appRequest(app, "/recipes", { headers: { Cookie: stranger } });
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

    expect((await appRequest(app, `/recipes/${id}`, {
      ...edit,
      headers: { Cookie: bystander.cookie, "Content-Type": "application/json" },
    })).status).toBe(403);
    expect((await appRequest(app, `/recipes/${id}`, {
      method: "DELETE",
      headers: { Cookie: bystander.cookie },
    })).status).toBe(403);
    expect((await appRequest(app, `/recipes/${id}`, {
      ...edit,
      headers: { Cookie: author.cookie, "Content-Type": "application/json" },
    })).status).toBe(200);
    expect((await appRequest(app, `/recipes/${id}`, {
      ...json({ name: "admin edit", templateId, harness: "claude", prompt: "Go.\n" }, "PUT"),
      headers: { Cookie: admin, "Content-Type": "application/json" },
    })).status).toBe(200);
  });

  it("refuses to delete a template that recipes still reference", async () => {
    const { app } = harness();
    const cookie = await operatorSession(app);
    const templateId = await createTemplate(app, cookie);
    const created = await createRecipe(app, cookie, {
      name: "holder",
      templateId,
      harness: "codex",
      prompt: "Go.\n",
    });
    const id = (await created.json<RecipeEnvelope>()).recipe.id;

    expect((await appRequest(app, `/workspace-templates/${templateId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(409);
    expect((await appRequest(app, `/recipes/${id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
    expect((await appRequest(app, `/workspace-templates/${templateId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    })).status).toBe(204);
  });

  it("launches through the existing create path and shapes the bootstrap", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const folderResponse = await appRequest(app, "/folders", {
      ...json({ name: "datasets" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const folderId = (await folderResponse.json<{ folder: { id: string } }>()).folder.id;
    const templateId = await createTemplate(app, cookie, "web analysis", [folderId]);
    const created = await createRecipe(app, cookie, {
      name: "chat routine",
      templateId,
      harness: "chat",
      model: "gpt-5-codex",
      effort: "low",
      prompt: "Summarize the datasets folder.\n",
    });
    const recipe = (await created.json<RecipeEnvelope>()).recipe;

    const launched = await appRequest(app, `/recipes/${recipe.id}/launch`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(launched.status).toBe(201);
    const workspace = (await launched.json<WorkspaceEnvelope>()).workspace;
    // Template flows: machine-type default and the template-derived name.
    expect(workspace.machineTypeId).toBe("small");
    expect(workspace.name).toBe("web analysis");
    expect(workspace.recipeId).toBe(recipe.id);

    // Provenance survives the poll view too.
    const read = await appRequest(app, `/workspaces/${workspace.id}`, {
      headers: { Cookie: cookie },
    });
    expect((await read.json<WorkspaceEnvelope>()).workspace.recipeId).toBe(recipe.id);

    // The launcher's readable template folders attach, launcher as principal.
    const attachments = await env.DB.prepare(
      "SELECT folder_id FROM folder_attachments WHERE workspace_id = ?1",
    ).bind(workspace.id).all<{ folder_id: string }>();
    expect(attachments.results.map(({ folder_id }) => folder_id)).toEqual([folderId]);

    // Bootstrap shaping: chat maps BLITZ_AGENT to the model's provider, the
    // invocation files land, and the sender is emitted.
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain("-e BLITZ_AGENT='codex' \\");
    expect(userData).toContain(
      `printf '%s' ${shellQuote("Summarize the datasets folder.\n")} >/var/lib/blitz/recipe/prompt.txt`,
    );
    expect(userData).toContain(
      `printf '%s' ${shellQuote(recipeInvocationEnvFile({
        harness: "chat",
        agentProvider: "codex",
        model: "gpt-5-codex",
        effort: "low",
        prompt: "",
      }))} >/var/lib/blitz/recipe/invocation.env`,
    );
    expect(userData).toContain("<<'RECIPE_SENDER'");

    // An ordinary create in the same org keeps the pre-recipe bytes.
    const plain = await appRequest(app, "/workspaces", {
      ...json({ machineTypeId: "small" }),
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    const plainWorkspace = (await plain.json<WorkspaceEnvelope>()).workspace;
    expect("recipeId" in plainWorkspace).toBe(false);
    const plainUserData = providers.userData.get(plainWorkspace.id) ?? "";
    expect(plainUserData).not.toContain("BLITZ_AGENT");
    expect(plainUserData).not.toContain("/var/lib/blitz/recipe");
  });

  it("emits no sender for TUI harnesses and passes the vm_limit 409 through", async () => {
    const { app, providers } = harness();
    const cookie = await operatorSession(app);
    const templateId = await createTemplate(app, cookie);
    const created = await createRecipe(app, cookie, {
      name: "tui routine",
      templateId,
      harness: "claude",
      prompt: "Refactor the repo.\n",
    });
    const recipe = (await created.json<RecipeEnvelope>()).recipe;

    const launched = await appRequest(app, `/recipes/${recipe.id}/launch`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(launched.status).toBe(201);
    const workspace = (await launched.json<WorkspaceEnvelope>()).workspace;
    const userData = providers.userData.get(workspace.id) ?? "";
    expect(userData).toContain("-e BLITZ_AGENT='claude' \\");
    expect(userData).toContain(
      `printf '%s' ${shellQuote(recipeInvocationEnvFile({
        harness: "claude",
        agentProvider: "claude",
        prompt: "",
      }))} >/var/lib/blitz/recipe/invocation.env`,
    );
    expect(userData).not.toContain("RECIPE_SENDER");

    await env.DB.prepare("UPDATE orgs SET vm_limit = 1 WHERE id = 'personal'").run();
    const refused = await appRequest(app, `/recipes/${recipe.id}/launch`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(refused.status).toBe(409);
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

    // Deleting the usage folder turns capture off with it.
    expect((await appRequest(app, `/folders/${state.folderId}`, {
      method: "DELETE",
      headers: { Cookie: admin },
    })).status).toBe(204);
    const after = await appRequest(app, "/orgs/self/usage-capture", {
      headers: { Cookie: admin },
    });
    expect(await after.json()).toEqual({ enabled: false, folderId: null });
  });
});
