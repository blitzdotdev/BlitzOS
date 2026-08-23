CREATE TABLE recipe_runs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  owner_membership_id TEXT NOT NULL REFERENCES memberships(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  error TEXT,
  delivery_blob TEXT,
  dedup_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE recipes ADD COLUMN fire_token_hash TEXT
  CHECK (fire_token_hash IS NULL OR length(fire_token_hash) = 64);
CREATE UNIQUE INDEX recipe_runs_recipe_dedup
  ON recipe_runs(recipe_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
