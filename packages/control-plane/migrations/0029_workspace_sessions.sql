CREATE TABLE workspace_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('claude', 'codex', 'opencode', 'pi', 'kimi', 'prime', 'terminal', 'chat')
  ),
  title TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_by_membership_id TEXT REFERENCES memberships(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE INDEX workspace_sessions_workspace
  ON workspace_sessions(workspace_id, archived_at, created_at, id);

CREATE TABLE workspace_member_views (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  doc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, membership_id)
);

CREATE INDEX workspace_member_views_membership
  ON workspace_member_views(membership_id, updated_at);
