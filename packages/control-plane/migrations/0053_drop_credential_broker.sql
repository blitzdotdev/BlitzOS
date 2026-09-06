-- Remove the credential custody schema after the fleet reached zero rows.
-- Parent rebuilds preserve device and machine authentication data.
PRAGMA defer_foreign_keys = ON;

-- These tables do not contain data that survives retirement.
DROP TABLE broker_keys;
DROP TABLE broker_members;

-- Rename child tables first. SQLite then keeps their foreign keys attached
-- to the retired parent tables during the rebuild.
ALTER TABLE credential_events RENAME TO credential_events_broker_retired;
ALTER TABLE machine_token_families RENAME TO machine_token_families_broker_retired;
ALTER TABLE box_token_families RENAME TO box_token_families_broker_retired;
ALTER TABLE credential_leases RENAME TO credential_leases_broker_retired;
ALTER TABLE machines RENAME TO machines_broker_retired;
ALTER TABLE boxes RENAME TO boxes_broker_retired;

-- Rebuild machines without its foreign key into the retired table.
CREATE TABLE machines (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id),
  membership_id              TEXT NOT NULL REFERENCES memberships(id),
  state                      TEXT NOT NULL CHECK (state IN
                               ('provisioning', 'running', 'stopped', 'error',
                                'destroying', 'destroyed')),
  machine_type_id            TEXT NOT NULL,
  compute_credential_source  TEXT NOT NULL DEFAULT 'deployment'
                               CHECK (compute_credential_source IN ('org', 'deployment')),
  vm_id                      TEXT,
  volume_id                  TEXT,
  ssh_host                   TEXT,
  ssh_port                   INTEGER,
  ssh_user                   TEXT,
  ssh_host_public_key        TEXT,
  phone_home_hash            TEXT,
  phone_home_used            INTEGER NOT NULL DEFAULT 0 CHECK (phone_home_used IN (0, 1)),
  tunnel_id                  TEXT,
  tunnel_hostname            TEXT,
  dns_record_id              TEXT,
  box_update_requested       INTEGER NOT NULL DEFAULT 0 CHECK (box_update_requested IN (0, 1)),
  box_image_reported         TEXT,
  disk_used_percent          INTEGER
                               CHECK (disk_used_percent IS NULL OR
                                      disk_used_percent BETWEEN 0 AND 100),
  disk_reported_at           INTEGER,
  payload_reported           TEXT,
  daemon_reported            TEXT,
  payload_outcome            TEXT
                               CHECK (payload_outcome IS NULL OR payload_outcome IN
                                 ('booted', 'applied', 'deferred', 'rolled-back',
                                  'unsupported', 'fetch-failed', 'verify-failed',
                                  'start-failed', 'up-to-date')),
  payload_reported_at        INTEGER,
  payload_hold               INTEGER NOT NULL DEFAULT 0 CHECK (payload_hold IN (0, 1)),
  created_by_plane           TEXT NOT NULL DEFAULT 'session'
                               CHECK (created_by_plane IN ('session', 'machine')),
  destroy_keeps_row          INTEGER NOT NULL DEFAULT 0 CHECK (destroy_keeps_row IN (0, 1)),
  error                      TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  UNIQUE (workspace_id, membership_id)
);

INSERT INTO machines (
  id, workspace_id, membership_id, state, machine_type_id,
  compute_credential_source, vm_id, volume_id, ssh_host, ssh_port, ssh_user,
  ssh_host_public_key, phone_home_hash, phone_home_used, tunnel_id,
  tunnel_hostname, dns_record_id, box_update_requested, box_image_reported,
  disk_used_percent, disk_reported_at, payload_reported, daemon_reported,
  payload_outcome, payload_reported_at, payload_hold, created_by_plane,
  destroy_keeps_row, error, created_at, updated_at
)
SELECT
  id, workspace_id, membership_id, state, machine_type_id,
  compute_credential_source, vm_id, volume_id, ssh_host, ssh_port, ssh_user,
  ssh_host_public_key, phone_home_hash, phone_home_used, tunnel_id,
  tunnel_hostname, dns_record_id, box_update_requested, box_image_reported,
  disk_used_percent, disk_reported_at, payload_reported, daemon_reported,
  payload_outcome, payload_reported_at, payload_hold, created_by_plane,
  destroy_keeps_row, error, created_at, updated_at
FROM machines_broker_retired;

-- Rebuild boxes without the role and placement columns.
-- Former custody hosts do not become device-code boxes after retirement.
CREATE TABLE boxes (
  id            TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(id),
  workspace_id  TEXT UNIQUE REFERENCES workspaces(id),
  created_at    INTEGER NOT NULL
);

INSERT INTO boxes (id, principal_id, workspace_id, created_at)
SELECT id, principal_id, workspace_id, created_at
FROM boxes_broker_retired
WHERE is_broker = 0;

-- Rebuild the child tables against the new parents.
CREATE TABLE machine_token_families (
  machine_id             TEXT PRIMARY KEY REFERENCES machines(id) ON DELETE CASCADE,
  vm_id                  TEXT,
  access_hash            TEXT NOT NULL UNIQUE,
  refresh_hash           TEXT NOT NULL UNIQUE,
  previous_refresh_hash  TEXT,
  previous_rotated_at    INTEGER,
  access_issued_at       INTEGER NOT NULL,
  generation             INTEGER NOT NULL
);

INSERT INTO machine_token_families
SELECT * FROM machine_token_families_broker_retired;

CREATE TABLE box_token_families (
  box_id                 TEXT PRIMARY KEY REFERENCES boxes(id) ON DELETE CASCADE,
  access_hash            TEXT NOT NULL UNIQUE,
  refresh_hash           TEXT NOT NULL UNIQUE,
  access_issued_at       INTEGER NOT NULL,
  generation             INTEGER NOT NULL,
  previous_refresh_hash  TEXT,
  previous_rotated_at    INTEGER
);

INSERT INTO box_token_families
  (box_id, access_hash, refresh_hash, access_issued_at, generation,
   previous_refresh_hash, previous_rotated_at)
SELECT
  family.box_id, family.access_hash, family.refresh_hash,
  family.access_issued_at, family.generation,
  family.previous_refresh_hash, family.previous_rotated_at
FROM box_token_families_broker_retired family
JOIN boxes ON boxes.id = family.box_id;

-- Lease rows are audit records. Rebuild their references without deleting
-- those records or changing their values.
CREATE TABLE credential_leases (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  box_id         TEXT REFERENCES boxes(id) ON DELETE SET NULL,
  connection_id  TEXT NOT NULL REFERENCES connections(id),
  user_id        TEXT,
  scopes         TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('inject','proxy')),
  token_hash     TEXT UNIQUE,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
  grant_id       TEXT REFERENCES user_oauth_grants(id),
  machine_id     TEXT REFERENCES machines(id)
);

INSERT INTO credential_leases
  (id, workspace_id, box_id, connection_id, user_id, scopes, mode,
   token_hash, issued_at, expires_at, state, grant_id, machine_id)
SELECT
  lease.id, lease.workspace_id,
  CASE WHEN boxes.id IS NULL THEN NULL ELSE lease.box_id END,
  lease.connection_id, lease.user_id, lease.scopes, lease.mode,
  lease.token_hash, lease.issued_at, lease.expires_at, lease.state,
  lease.grant_id, lease.machine_id
FROM credential_leases_broker_retired lease
LEFT JOIN boxes ON boxes.id = lease.box_id;

-- Events are append-only audit records. Rebuild their lease reference and
-- preserve every recorded result.
CREATE TABLE credential_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lease_id    TEXT REFERENCES credential_leases(id),
  event       TEXT NOT NULL CHECK (event IN ('minted','revoked','denied','approved')),
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

INSERT INTO credential_events (id, lease_id, event, detail, created_at)
SELECT id, lease_id, event, detail, created_at
FROM credential_events_broker_retired;

-- Remove old children before their parents. This prevents cascade data loss.
DROP TABLE credential_events_broker_retired;
DROP TABLE machine_token_families_broker_retired;
DROP TABLE box_token_families_broker_retired;
DROP TABLE credential_leases_broker_retired;
DROP TABLE machines_broker_retired;
DROP TABLE boxes_broker_retired;

-- No remaining table references this target now.
DROP TABLE broker_boxes;

CREATE INDEX machines_workspace ON machines(workspace_id, created_at);
CREATE INDEX machines_membership ON machines(membership_id, workspace_id);
CREATE INDEX machines_state ON machines(state, updated_at);
CREATE INDEX boxes_principal ON boxes(principal_id);
CREATE INDEX leases_workspace ON credential_leases(workspace_id, state);
CREATE INDEX leases_expiry ON credential_leases(state, expires_at);
CREATE INDEX leases_token ON credential_leases(token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX leases_grant ON credential_leases(grant_id, state);

PRAGMA foreign_key_check;
