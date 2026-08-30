import {
  AGENT_MODELS,
  agentEffortsForModel,
  RECIPE_HARNESSES,
  type CreateRecipeRequest,
  type RecipeHarness,
  type RecipeView,
  type WorkspaceTemplateView,
} from '@blitzos/schema';
import { useEffect, useState } from 'react';
import type { ControlPlaneClient } from '../api';
import { recipeHarnessLabel } from './RecipesHome';

/** Dedicated screen for building a recipe: name it, pick the template its
 * workspaces launch from, and pin the invocation — harness, model, effort,
 * prompt. A harness is a TUI provider, so its own catalog supplies the model
 * and effort choices. */
export function CreateRecipeScreen({
  client,
  editRecipeId,
  onSaved,
  onCancel,
}: {
  client: ControlPlaneClient;
  /** When set, the screen edits this recipe instead of creating one. */
  editRecipeId?: string;
  onSaved: (recipe: RecipeView) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<WorkspaceTemplateView[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [harness, setHarness] = useState<RecipeHarness>('claude');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void client.listWorkspaceTemplates()
      .then(({ templates: loaded }) => {
        if (!mounted) return;
        setTemplates(loaded);
        setLoading(false);
      })
      .catch((caught: Error) => {
        if (!mounted) return;
        setError(caught.message);
        setLoading(false);
      });
    return () => { mounted = false; };
  }, [client]);

  useEffect(() => {
    if (editRecipeId === undefined) return;
    let mounted = true;
    void client.getRecipe(editRecipeId).then(({ recipe }) => {
      if (!mounted) return;
      setName(recipe.name);
      setTemplateId(recipe.templateId);
      setHarness(recipe.harness);
      setModel(recipe.model ?? '');
      setEffort(recipe.effort ?? '');
      setPrompt(recipe.prompt);
    }).catch((caught: Error) => setError(caught.message));
    return () => { mounted = false; };
  }, [client, editRecipeId]);

  // The effort list follows the pinned model (AGENT_MODEL_EFFORTS); with no
  // model pinned it falls back to the harness base.
  const efforts = agentEffortsForModel(harness, model);
  const ready = name.trim() !== '' && templateId !== '' && prompt.trim() !== '';

  const pickHarness = (next: RecipeHarness) => {
    setHarness(next);
    // Keep the model only where the new harness accepts it. The effort list
    // follows the harness, so an orphaned choice resets with it.
    const nextModel = AGENT_MODELS[next].some((candidate) => candidate === model) ? model : '';
    setModel(nextModel);
    if (!agentEffortsForModel(next, nextModel).some((candidate) => candidate === effort)) {
      setEffort('');
    }
  };

  const pickModel = (next: string) => {
    setModel(next);
    if (!agentEffortsForModel(harness, next).some((candidate) => candidate === effort)) {
      setEffort('');
    }
  };

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const request: CreateRecipeRequest = {
        name: name.trim(),
        templateId,
        harness,
        prompt,
      };
      if (model !== '') request.model = model;
      if (effort !== '') request.effort = effort;
      const { recipe } = editRecipeId === undefined
        ? await client.createRecipe(request)
        : await client.updateRecipe(editRecipeId, request);
      onSaved(recipe);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The recipe could not be saved.');
      setBusy(false);
    }
  };

  const storedTemplateMissing = templateId !== ''
    && !templates.some(({ id }) => id === templateId);

  return (
    <div className="create-workspace-screen" role="presentation">
      <form
        className="create-workspace-dialog"
        aria-label={editRecipeId === undefined ? 'Create recipe' : 'Edit recipe'}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="create-workspace-header">
          <div className="create-workspace-header__title"><h1>{editRecipeId === undefined ? 'New recipe' : 'Edit recipe'}</h1></div>
          <button type="button" aria-label="Close" disabled={busy} onClick={onCancel}>×</button>
        </header>

        <div className="create-workspace-main">
          {error && (
            <div className="create-workspace-notices">
              <p className="webapp-form-message" role="alert">{error}</p>
            </div>
          )}

          <section className="blueprint-selection">
            <div className="cfg-section-head">
              <h2 className="cfg-title">Name</h2>
              <p className="cfg-desc">Everyone in your organization sees this recipe on the Recipes page.</p>
            </div>
            <label className="cfg-field">
              Recipe name
              <input
                aria-label="Recipe name"
                maxLength={64}
                placeholder="e.g. nightly dependency audit"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
          </section>

          <section className="blueprint-selection">
            <div className="cfg-section-head">
              <h2 className="cfg-title">Template</h2>
              <p className="cfg-desc">Every run launches a workspace from this template — its machine, folders, environment, and agent rules.</p>
            </div>
            <label className="cfg-field">
              Workspace template
              <select
                aria-label="Workspace template"
                value={templateId}
                onChange={(event) => setTemplateId(event.currentTarget.value)}
              >
                <option value="">Choose a template…</option>
                {storedTemplateMissing && (
                  <option value={templateId}>{templateId} (unavailable)</option>
                )}
                {templates.map((template) => (
                  <option value={template.id} key={template.id}>{template.name}</option>
                ))}
              </select>
            </label>
            {templates.length === 0 && !loading && (
              <div className="blueprint-selection__empty">
                No templates yet — create one on the Templates page first.
              </div>
            )}
          </section>

          <section className="blueprint-selection">
            <div className="cfg-section-head">
              <h2 className="cfg-title">Invocation</h2>
              <p className="cfg-desc">The agent every run starts with, in a terminal tab of the launched workspace.</p>
            </div>
            <label className="cfg-field">
              Harness
              <select
                aria-label="Harness"
                value={harness}
                onChange={(event) => {
                  const next = RECIPE_HARNESSES.find(
                    (candidate) => candidate === event.currentTarget.value,
                  );
                  if (next !== undefined) pickHarness(next);
                }}
              >
                {RECIPE_HARNESSES.map((candidate) => (
                  <option value={candidate} key={candidate}>{recipeHarnessLabel(candidate)}</option>
                ))}
              </select>
            </label>
            <label className="cfg-field">
              Model
              <select
                aria-label="Model"
                value={model}
                onChange={(event) => pickModel(event.currentTarget.value)}
              >
                <option value="">Harness default</option>
                {AGENT_MODELS[harness].map((candidate) => (
                  <option value={candidate} key={candidate}>{candidate}</option>
                ))}
              </select>
            </label>
            <label className="cfg-field">
              Effort
              <select
                aria-label="Effort"
                value={effort}
                onChange={(event) => setEffort(event.currentTarget.value)}
              >
                <option value="">Default</option>
                {efforts.map((candidate) => (
                  <option value={candidate} key={candidate}>{candidate}</option>
                ))}
              </select>
            </label>
          </section>

          <section className="blueprint-selection">
            <div className="cfg-section-head">
              <h2 className="cfg-title">Prompt</h2>
              <p className="cfg-desc">Delivered to the agent when the workspace boots. Runs are unattended by default — you can still open one and take over.</p>
            </div>
            <div className="blueprint-setup-script">
              <textarea
                aria-label="Prompt"
                placeholder={'e.g. Read /workspace/shared/reports/, summarize the week, and write summary.md into /workspace/shared/out/.'}
                value={prompt}
                onChange={(event) => setPrompt(event.currentTarget.value)}
              />
            </div>
          </section>
        </div>

        <footer className="create-workspace-actions create-workspace-actions--blueprint">
          <button className="blueprint-cancel" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button
            className="create-workspace-primary"
            type="submit"
            disabled={busy || loading || !ready}
          >
            {editRecipeId === undefined
              ? busy ? 'Creating…' : 'Create recipe'
              : busy ? 'Saving…' : 'Save recipe'}
          </button>
        </footer>
      </form>
    </div>
  );
}
