CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_user_id TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name TEXT NOT NULL,
  avatar_url TEXT,
  platform_operator INTEGER NOT NULL DEFAULT 0 CHECK (platform_operator IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  vm_limit INTEGER NOT NULL CHECK (vm_limit > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
  UNIQUE (user_id, org_id)
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 43),
  email TEXT CHECK (email IS NULL OR email = lower(email)),
  target_org_id TEXT NOT NULL REFERENCES orgs(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  state TEXT NOT NULL CHECK (state IN ('ready', 'redeemed', 'revoked', 'expired')),
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  redeemed_by_user_id TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER
);

CREATE TABLE workspace_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  membership_id TEXT NOT NULL REFERENCES memberships(id),
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  granted_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, membership_id)
);

ALTER TABLE sessions ADD COLUMN membership_id TEXT REFERENCES memberships(id);
ALTER TABLE workspaces ADD COLUMN org_id TEXT REFERENCES orgs(id);
ALTER TABLE workspaces ADD COLUMN owner_membership_id TEXT REFERENCES memberships(id);
