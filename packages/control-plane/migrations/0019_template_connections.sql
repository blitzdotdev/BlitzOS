-- Templates reference providers by name and nothing else. No grant and no
-- secret can live here: create-from-template prompts the creator for their
-- own SSO, and they become the workspace owner.
CREATE TABLE workspace_template_connections (
  template_id TEXT NOT NULL REFERENCES workspace_templates(id),
  provider TEXT NOT NULL,                    -- connection name, matching user_oauth_grants.provider
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (template_id, provider)
);

CREATE INDEX workspace_template_connections_provider
  ON workspace_template_connections(provider, template_id);
