-- A workspace that picks its own repositories needs somewhere to keep them.
-- Until now the list existed only inside the bootstrap script, written once at
-- create, so nothing in the database knew what a workspace holds: no UI could
-- show it, no failed clone could be retried, and no later member could be
-- seeded. Mirrors workspace_template_repos, private column included, because
-- the create-time gate reads the same server-derived probe verdict either way.
-- Existing workspaces keep no rows here; the boxes they already booted are
-- unaffected.
CREATE TABLE workspace_repos (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repo TEXT NOT NULL,            -- "owner/name"
  private INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, repo)
);
