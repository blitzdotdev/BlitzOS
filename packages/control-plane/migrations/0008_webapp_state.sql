CREATE TABLE webapp_state (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  workspace_id TEXT REFERENCES workspaces(id),
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (principal_id, workspace_id)
);
