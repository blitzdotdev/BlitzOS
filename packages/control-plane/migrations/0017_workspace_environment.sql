ALTER TABLE workspaces ADD COLUMN environment TEXT;
ALTER TABLE workspaces ADD COLUMN files_ready INTEGER NOT NULL DEFAULT 0
  CHECK (files_ready IN (0, 1));
ALTER TABLE workspace_templates ADD COLUMN environment TEXT;
