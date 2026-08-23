-- The evals branch reserves 0028-0030 and creates recipe_runs. Keeping this
-- fallback definition makes 0031 testable against main before that branch
-- lands; CREATE is a no-op once the reserved migrations precede it.
CREATE TABLE IF NOT EXISTS recipe_runs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  owner_membership_id TEXT NOT NULL REFERENCES memberships(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE recipes ADD COLUMN fire_token_hash TEXT
  CHECK (fire_token_hash IS NULL OR length(fire_token_hash) = 64);
ALTER TABLE recipe_runs ADD COLUMN delivery_blob TEXT;
ALTER TABLE recipe_runs ADD COLUMN dedup_key TEXT;
CREATE UNIQUE INDEX recipe_runs_recipe_dedup
  ON recipe_runs(recipe_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
