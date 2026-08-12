PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  unix_name TEXT NOT NULL,
  harnesses TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES principals(id),
  phase TEXT NOT NULL CHECK (phase IN ('creating', 'ready', 'destroying', 'destroyed', 'error')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  vm_id TEXT,
  volume_id TEXT,
  ssh_host TEXT,
  ssh_port INTEGER,
  ssh_user TEXT,
  ssh_host_public_key TEXT,
  error TEXT,
  phone_home_hash TEXT,
  phone_home_used INTEGER NOT NULL DEFAULT 0 CHECK (phone_home_used IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX workspaces_owner ON workspaces(owner_id, created_at);
CREATE INDEX workspaces_phase ON workspaces(phase, updated_at);

CREATE TABLE device_authorizations (
  device_hash TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  principal_id TEXT REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  consumed_at INTEGER
);

CREATE TABLE boxes (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  workspace_id TEXT UNIQUE REFERENCES workspaces(id),
  broker_box_id TEXT REFERENCES broker_boxes(box_id) ON DELETE SET NULL,
  is_broker INTEGER NOT NULL DEFAULT 0 CHECK (is_broker IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE INDEX boxes_broker ON boxes(broker_box_id);
CREATE INDEX boxes_principal ON boxes(principal_id);

CREATE TABLE box_token_families (
  box_id TEXT PRIMARY KEY REFERENCES boxes(id) ON DELETE CASCADE,
  access_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  access_issued_at INTEGER NOT NULL,
  generation INTEGER NOT NULL
);

CREATE TABLE broker_boxes (
  box_id TEXT PRIMARY KEY REFERENCES boxes(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  ssh_host_public_key TEXT NOT NULL
);

CREATE TABLE broker_keys (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  pubkey TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('mint', 'deposit')),
  UNIQUE (box_id, pubkey, operation)
);

CREATE INDEX broker_keys_box ON broker_keys(box_id);
