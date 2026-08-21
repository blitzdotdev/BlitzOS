import { HARNESSES } from "./broker.js";

/** A recipe is one row: a template reference plus an invocation — harness,
 * model, effort, prompt. Launching one creates a normal workspace from the
 * template and delivers the invocation to the box (plans/RECIPES.md).
 * The harness choices are the TUI harnesses plus the headless chat run. */
export const RECIPE_HARNESSES = [...HARNESSES, "chat"] as const;

export type RecipeHarness = (typeof RECIPE_HARNESSES)[number];

export interface RecipeView {
  id: string;
  name: string;
  templateId: string;
  harness: RecipeHarness;
  /** A catalog model (see agent-catalog.ts); absent means the harness default.
   * Required for `chat`, whose model also selects the adapter provider. */
  model?: string;
  effort?: string;
  prompt: string;
}

export interface ListRecipesResponse {
  recipes: RecipeView[];
}

/** POST /workspace-recipes and PUT /workspace-recipes/:id share this
 * full-replacement shape, exactly like workspace templates. */
export interface CreateRecipeRequest {
  name: string;
  templateId: string;
  harness: RecipeHarness;
  model?: string;
  effort?: string;
  prompt: string;
}

/** Envelope for GET /workspace-recipes/:id, POST /workspace-recipes (201),
 * and PUT /workspace-recipes/:id. POST /workspace-recipes/:id/launch answers
 * with CreateWorkspaceResponse instead. */
export interface RecipeResponse {
  recipe: RecipeView;
}

/** Admin switch for org-wide agent-usage capture (GET and PUT
 * /orgs/self/usage-capture). The folder is lazy-created on first enable and
 * survives a disable, so re-enabling keeps the corpus in one place. */
export interface OrgUsageCaptureResponse {
  enabled: boolean;
  folderId: string | null;
}
