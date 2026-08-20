CREATE TABLE agent_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (org_id, name)
);

ALTER TABLE workspace_templates ADD COLUMN agent_rule_id TEXT REFERENCES agent_rules(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN agent_rule_id TEXT REFERENCES agent_rules(id) ON DELETE SET NULL;
