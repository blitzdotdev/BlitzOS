CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  template_id TEXT NOT NULL REFERENCES workspace_templates(id),
  harness TEXT NOT NULL CHECK (harness IN ('claude', 'codex', 'chat')),
  model TEXT,
  effort TEXT,
  prompt TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX recipes_org ON recipes(org_id, created_at);
CREATE INDEX recipes_template ON recipes(template_id);

-- provenance: which routine produced this workspace (accepted 2026-08-21)
ALTER TABLE workspaces ADD COLUMN recipe_id TEXT REFERENCES recipes(id);
ALTER TABLE orgs ADD COLUMN usage_capture INTEGER NOT NULL DEFAULT 0;
-- Deliberately no folders(id) reference: a deleted usage folder may leave a
-- dangling id, and that is fine — the usage-push leg inner-joins folders, so
-- a dangling org simply stops exporting.
ALTER TABLE orgs ADD COLUMN usage_folder_id TEXT;
