CREATE TABLE volume_ownership (
  volume_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL
);

ALTER TABLE integrations ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE integrations ADD COLUMN created_by_membership_id TEXT REFERENCES memberships(id);
ALTER TABLE integrations ADD COLUMN scoped_name TEXT;

UPDATE integrations
SET created_by = (
      SELECT id FROM users WHERE platform_operator = 1 ORDER BY created_at LIMIT 1
    )
WHERE created_by = 'operator'
  AND EXISTS (SELECT 1 FROM users WHERE platform_operator = 1);

UPDATE integrations
SET created_by_membership_id = (
      SELECT id FROM memberships
      WHERE user_id = integrations.created_by AND status = 'active'
      ORDER BY rowid LIMIT 1
    ),
    org_id = (
      SELECT org_id FROM memberships
      WHERE user_id = integrations.created_by AND status = 'active'
      ORDER BY rowid LIMIT 1
    )
WHERE org_id IS NULL;
UPDATE integrations SET scoped_name = name WHERE scoped_name IS NULL;

INSERT OR IGNORE INTO volume_ownership
  (volume_id, org_id, created_by_membership_id, created_at)
SELECT DISTINCT volume_id, org_id, owner_membership_id, created_at
FROM workspaces
WHERE volume_id IS NOT NULL AND org_id IS NOT NULL AND owner_membership_id IS NOT NULL;

CREATE UNIQUE INDEX integrations_org_name ON integrations(org_id, scoped_name);
CREATE INDEX integrations_org ON integrations(org_id, created_at, scoped_name);

CREATE INDEX workspaces_org ON workspaces(org_id, created_at);
CREATE INDEX grants_membership ON workspace_grants(membership_id, workspace_id);
CREATE INDEX memberships_org ON memberships(org_id, status);
CREATE INDEX invites_org ON invites(target_org_id, state, created_at);
