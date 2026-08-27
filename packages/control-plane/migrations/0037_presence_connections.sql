CREATE TABLE presence_connections (
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 128),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  view_json TEXT NOT NULL,
  focused INTEGER NOT NULL CHECK (focused IN (0, 1)),
  visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (membership_id, client_id)
);

CREATE INDEX presence_connections_expiry
  ON presence_connections(last_seen_at, membership_id, client_id);

CREATE INDEX presence_connections_workspace
  ON presence_connections(workspace_id, last_seen_at, membership_id);
