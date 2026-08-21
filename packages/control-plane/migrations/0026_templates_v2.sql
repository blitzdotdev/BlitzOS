-- TEMPLATES V2 (plans/TEMPLATES-V2.md): org-default template + template repos.

-- The org's single default template. No FK — mirrors the orgs.usage_folder_id
-- precedent (FK dropped by ruling in PR #8); dangling pointers are prevented
-- by the template DELETE handler, which clears the pointer in the same
-- request, not by the schema.
ALTER TABLE orgs ADD COLUMN default_template_id TEXT;

-- Repos ("owner/name") a template clones into /workspace/<name> on first
-- boot. Auth is the box's baked git credential helper minting through the
-- org's github connection; nothing secret lives here.
CREATE TABLE workspace_template_repos (
  template_id TEXT NOT NULL REFERENCES workspace_templates(id),
  repo TEXT NOT NULL,            -- "owner/name"
  PRIMARY KEY (template_id, repo)
);
