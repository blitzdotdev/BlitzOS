ALTER TABLE folders ADD COLUMN org_role TEXT CHECK (org_role IN ('editor', 'viewer'));
ALTER TABLE workspaces ADD COLUMN org_share_role TEXT CHECK (org_share_role IN ('editor', 'viewer'));

CREATE TABLE workspace_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  machine_type_id TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspace_template_folders (
  template_id TEXT NOT NULL REFERENCES workspace_templates(id),
  folder_id TEXT NOT NULL REFERENCES folders(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, folder_id)
);

CREATE INDEX workspace_templates_org ON workspace_templates(org_id, created_at);
CREATE INDEX workspace_template_folders_folder ON workspace_template_folders(folder_id, template_id);
