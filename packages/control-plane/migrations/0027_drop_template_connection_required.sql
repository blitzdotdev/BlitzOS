-- Drop workspace_template_connections.required. The flag has been dead since
-- workspace creation stopped blocking on connections (the 409 gate is gone):
-- the workspace connections panel reads needs-you status off the lease list,
-- so nothing reads the column and the webapp no longer writes it. SQLite
-- drops a column by table rebuild: create the new shape, copy, swap.
CREATE TABLE workspace_template_connections_new (
  template_id TEXT NOT NULL REFERENCES workspace_templates(id),
  provider TEXT NOT NULL,                    -- connection name, matching user_oauth_grants.provider
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, provider)
);

INSERT INTO workspace_template_connections_new (template_id, provider, created_at)
  SELECT template_id, provider, created_at FROM workspace_template_connections;

DROP TABLE workspace_template_connections;

ALTER TABLE workspace_template_connections_new RENAME TO workspace_template_connections;

CREATE INDEX workspace_template_connections_provider
  ON workspace_template_connections(provider, template_id);
