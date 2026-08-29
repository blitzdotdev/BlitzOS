-- The workspace is its own template (plans/MEMBER-MACHINES.md §0).
--
-- A workspace now carries the config a template used to carry — default
-- machine type, agent rules, repos, credentials — and "new workspace from
-- existing" clones that config. There is no separate template object, so the
-- four template tables go.
--
-- Recipes lose their launch source. `recipes.template_id` referenced a table
-- that is being dropped, and there is no mapping from a template to a
-- workspace, so the column is rebuilt as a nullable `source_workspace_id` and
-- every existing row gets NULL. `POST /workspace-recipes/:id/launch` refuses
-- with 400 until the workspace-clone launch lands; see the TODO in
-- core/recipes.ts. Recipe CRUD keeps working, and the UI for it is already
-- hidden (#103).

-- `workspaces.recipe_id` references `recipes`, so the rebuild below cannot run
-- while those rows point at it. The provenance is parked here and restored
-- once the new table is in place.
CREATE TABLE recipe_provenance_tmp (
  workspace_id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL
);

INSERT INTO recipe_provenance_tmp (workspace_id, recipe_id)
SELECT id, recipe_id FROM workspaces WHERE recipe_id IS NOT NULL;

UPDATE workspaces SET recipe_id = NULL WHERE recipe_id IS NOT NULL;

CREATE TABLE recipes_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  -- The workspace a launch clones. NULL on every row this migration carries
  -- across, because the template it used to name no longer exists.
  source_workspace_id TEXT REFERENCES workspaces(id),
  harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'chat')),
  model TEXT,
  effort TEXT,
  prompt TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO recipes_new (
  id, org_id, name, source_workspace_id, harness, model, effort, prompt,
  created_by_membership_id, created_at, updated_at
)
SELECT id, org_id, name, NULL, harness, model, effort, prompt,
       created_by_membership_id, created_at, updated_at
FROM recipes;

DROP TABLE recipes;
ALTER TABLE recipes_new RENAME TO recipes;

CREATE INDEX recipes_org ON recipes(org_id, created_at);
CREATE INDEX recipes_source_workspace ON recipes(source_workspace_id);

UPDATE workspaces
SET recipe_id = (
  SELECT recipe_id FROM recipe_provenance_tmp t WHERE t.workspace_id = workspaces.id
)
WHERE EXISTS (SELECT 1 FROM recipe_provenance_tmp t WHERE t.workspace_id = workspaces.id);

DROP TABLE recipe_provenance_tmp;

DROP TABLE workspace_template_connections;
DROP TABLE workspace_template_repos;
DROP TABLE workspace_template_folders;
DROP TABLE workspace_templates;

-- The org pointer at a template that no longer exists. No FK ever held it
-- (0026 says so), so it is cleared here rather than cascaded.
UPDATE orgs SET default_template_id = NULL WHERE default_template_id IS NOT NULL;
