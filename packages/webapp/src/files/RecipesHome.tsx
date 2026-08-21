import { useCallback, useEffect, useState } from 'react';
import type { RecipeHarness, RecipeView } from '@blitzos/schema';
import type { ControlPlaneClient } from '../api';
import { ConfirmationDialog } from '../ConfirmationDialog';
import { NewWorkspaceIcon } from '../WebAppIcons';
import {
  KebabGlyph,
  PencilGlyph,
  PlusGlyph,
  TemplateGlyph,
  TrashGlyph,
} from './DriveIcons';
import { RecipeDuoIcon } from '../files-icons';

export function recipeHarnessLabel(harness: RecipeHarness): string {
  if (harness === 'claude') return 'Claude Code';
  if (harness === 'codex') return 'Codex';
  return 'Chat';
}

/** The Recipes surface: saved invocations (template + harness + model + prompt)
 * as cards, mirroring the Templates page. Run launches a normal workspace. */
export function RecipesHome({
  client,
  launching,
  onNewRecipe,
  onEditRecipe,
  onRunRecipe,
  onOpenRail,
}: {
  client: ControlPlaneClient;
  launching: boolean;
  onNewRecipe: () => void;
  onEditRecipe: (recipe: RecipeView) => void;
  onRunRecipe: (recipe: RecipeView) => void;
  onOpenRail: () => void;
}) {
  const [recipes, setRecipes] = useState<RecipeView[] | null>(null);
  const [templateNames, setTemplateNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RecipeView | null>(null);

  const load = useCallback(async () => {
    try {
      const [{ recipes: loaded }, { templates }] = await Promise.all([
        client.listRecipes(),
        client.listWorkspaceTemplates(),
      ]);
      setRecipes(loaded);
      setTemplateNames(new Map(templates.map(({ id, name }) => [id, name])));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load recipes.');
    }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="drive-content drive-content--full">
      <div className="drive-page">
        <div className="tpl-head">
          <button
            className="drive-icon-button drive-topbar-menu"
            type="button"
            aria-label="Open navigation"
            onClick={onOpenRail}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
            </svg>
          </button>
          <h1 className="drive-title">Recipes</h1>
          <button className="drive-new-button" type="button" onClick={onNewRecipe}>
            <PlusGlyph /><span>New recipe</span>
          </button>
        </div>
        <p className="tpl-sub">
          Saved agent invocations — a template plus a harness, model, and prompt. Run starts a normal workspace you can join and watch.
        </p>

        {error && <p className="webapp-form-message" role="alert">{error}</p>}

        {recipes === null ? (
          <div className="drive-empty" role="status">Loading…</div>
        ) : (
          <div className="tpl-grid">
            {recipes.map((recipe) => (
              <article className="tpl-card" key={recipe.id}>
                <div className="tpl-card-head">
                  <RecipeDuoIcon />
                  <span className="tpl-card-name">{recipe.name}</span>
                  <span className="drive-new-wrap">
                    <button
                      className="tpl-kebab"
                      type="button"
                      aria-label={`Actions for ${recipe.name}`}
                      aria-haspopup="menu"
                      aria-expanded={menuFor === recipe.id}
                      onClick={() => setMenuFor((open) => open === recipe.id ? null : recipe.id)}
                    ><KebabGlyph /></button>
                    {menuFor === recipe.id && (
                      <>
                        <button
                          type="button"
                          aria-label="Close menu"
                          className="drive-new-scrim"
                          onClick={() => setMenuFor(null)}
                        />
                        <div className="drive-menu drive-new-menu" role="menu">
                          <button
                            className="drive-menu-item"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              onEditRecipe(recipe);
                            }}
                          >
                            <PencilGlyph /><span>Edit recipe</span>
                          </button>
                          <button
                            className="drive-menu-item drive-menu-item--danger"
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              setDeleting(recipe);
                            }}
                          >
                            <TrashGlyph /><span>Delete recipe</span>
                          </button>
                        </div>
                      </>
                    )}
                  </span>
                </div>
                <div className="tpl-meta">
                  <span className="tpl-machine">{recipeHarnessLabel(recipe.harness)}</span>
                  <span className="tpl-machine">{recipe.model ?? 'default model'}</span>
                </div>
                <div className="tpl-folders">
                  <span className="tpl-folder" title="Workspaces launch from this template">
                    <TemplateGlyph />
                    <span>{templateNames.get(recipe.templateId) ?? recipe.templateId}</span>
                  </span>
                </div>
                <div className="tpl-foot">
                  <button
                    className="tpl-use"
                    type="button"
                    disabled={launching}
                    onClick={() => onRunRecipe(recipe)}
                  >
                    <NewWorkspaceIcon /><span>Run</span>
                  </button>
                </div>
              </article>
            ))}
            <button className="tpl-ghost" type="button" onClick={onNewRecipe}>
              <span><PlusGlyph />New recipe</span>
            </button>
          </div>
        )}
      </div>

      {deleting !== null && (
        <ConfirmationDialog
          title="Delete recipe?"
          description={`Are you sure you want to delete “${deleting.name}”? Workspaces it already launched keep running.`}
          confirmLabel="Yes, delete"
          cancelLabel="No"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting;
            setDeleting(null);
            void client.deleteRecipe(target.id)
              .then(load)
              .catch((caught: Error) => setError(caught.message));
          }}
        />
      )}
    </div>
  );
}
