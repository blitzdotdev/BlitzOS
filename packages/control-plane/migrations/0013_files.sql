CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE folder_grants (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  granted_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  UNIQUE (folder_id, membership_id)
);

CREATE INDEX folders_org ON folders(org_id, created_at);
CREATE INDEX folder_grants_membership ON folder_grants(membership_id, folder_id);
