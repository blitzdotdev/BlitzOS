CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                    -- instance name the user picks ("github-prod")
  provider TEXT NOT NULL,                       -- the member: 'github', 'google', 'slack', 'anthropic', 'hetzner', … open set
  kind TEXT NOT NULL,                           -- mechanism: 'app-jwt' | 'oauth' | 'static'
  custody TEXT NOT NULL DEFAULT 'cp',           -- 'cp' | 'broker' | 'proxy'
  config TEXT NOT NULL DEFAULT '{}',       -- non-secret: app id, install id, descriptor, placement template
  root_ciphertext TEXT,                         -- base64(12-byte IV ‖ AES-256-GCM root)
  usable_by TEXT,                              -- who may use it: {"owners":[…]}; NULL = any workspace
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE user_connections (                 -- inherit mode: Alice's own grants
  user_id TEXT NOT NULL REFERENCES principals(id),
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  refresh_ciphertext TEXT NOT NULL,             -- her refresh token, AES-256-GCM sealed
  scopes TEXT NOT NULL,                         -- frozen at consent; the outer bound
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, integration_id)
);

CREATE TABLE credential_leases (                -- one row per mint; rows are NEVER deleted
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  box_id TEXT REFERENCES boxes(id) ON DELETE SET NULL,  -- audit: which box received it; survives the box hard-delete on destroy
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  user_id TEXT,                                 -- set when minted from a user_connection
  scopes TEXT NOT NULL,                         -- the scopes actually GRANTED, verified at mint (§3.8)
  mode TEXT NOT NULL CHECK (mode IN ('inject','proxy')),
  token_hash TEXT UNIQUE,                       -- set only when mode='proxy'; NULLed by revoke/expiry (phone_home_hash idiom)
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','revoked','expired'))
);
CREATE INDEX leases_workspace ON credential_leases(workspace_id, state);
CREATE INDEX leases_expiry   ON credential_leases(state, expires_at);
CREATE INDEX leases_token    ON credential_leases(token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE credential_events (                -- append-only; never UPDATE, never a value
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id TEXT REFERENCES credential_leases(id),   -- NULL for denied mints
  event TEXT NOT NULL CHECK (event IN ('minted','revoked','denied','approved')),
  detail TEXT,                                  -- JSON: integration, scopes, box id, reason; no secrets
  created_at INTEGER NOT NULL
);

CREATE TABLE credential_requests (              -- the approval loop (§3.13); a state machine, so not an event
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  integration_name TEXT NOT NULL,               -- integrations.name is UNIQUE; the row may not exist yet
  requested_scopes TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','denied')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX requests_pending ON credential_requests(state, created_at);
CREATE UNIQUE INDEX requests_dedup
  ON credential_requests(workspace_id, integration_name, requested_scopes)
  WHERE state = 'pending';

ALTER TABLE workspaces ADD COLUMN manifest TEXT;   -- ceiling snapshot at create
