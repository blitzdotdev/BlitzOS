-- MEMBER MACHINES, build 1 (plans/MEMBER-MACHINES.md §1).
--
-- The workspace stops being a VM record and becomes the durable, configurable
-- thing. Every VM column moves onto `machines`, one row per (workspace,
-- member). Sharing stops being computed from `workspace_grants` +
-- `org_share_role` and becomes a stored role in `workspace_members`.
--
-- Numbering starts at 0041 because 0040 is claimed by the unmerged trials PR.
--
-- NOTHING DEPLOYED MAY BREAK. Three invariants this file has to hold:
--   1. Every live workspace keeps its VM: one machine row carries vm_id,
--      volume_id, ssh_*, phone_home_*, tunnel_*, and the credential source.
--   2. Every live guest keeps authenticating: the machine row REUSES the id of
--      the `boxes` row it already has, and its token family is copied across
--      hash-for-hash. A box that holds an access token keeps holding a valid
--      one, and `POST /boxes/:id/keys` still names the same id.
--   3. Every broker keeps its member accounts: `broker_keys` is re-keyed onto
--      machines with the same ids, so the feed serves the same key lines.

-- The membership plane. `admin` here is WORKSPACE admin, which is not the org
-- role of the same name (plans/MEMBER-MACHINES.md §3).
CREATE TABLE workspace_members (
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
  membership_id           TEXT NOT NULL REFERENCES memberships(id),
  role                    TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  added_by_membership_id  TEXT REFERENCES memberships(id),
  added_at                INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, membership_id)
);

CREATE INDEX workspace_members_membership
  ON workspace_members(membership_id, workspace_id);

-- One VM per (workspace, member). The volume is the durable half: a machine
-- type change destroys the VM incarnation and keeps the disk, which is what
-- makes `machine_type_id` a per-machine mutable column rather than a workspace
-- setting (§1a).
--
-- `compute_credential_source` is NOT NULL here where the workspace column was
-- nullable: every reader already coalesced a NULL to 'deployment', so the
-- backfill below writes that value and the column stops carrying a state no
-- caller could act on.
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
  -- The broker box this machine's member is homed on. It was boxes.broker_box_id.
  broker_box_id              TEXT REFERENCES broker_boxes(box_id) ON DELETE SET NULL,
  box_update_requested       INTEGER NOT NULL DEFAULT 0 CHECK (box_update_requested IN (0, 1)),
  box_image_reported         TEXT,
  error                      TEXT,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  UNIQUE (workspace_id, membership_id)
);

CREATE INDEX machines_workspace ON machines(workspace_id, created_at);
CREATE INDEX machines_membership ON machines(membership_id, workspace_id);
CREATE INDEX machines_state ON machines(state, updated_at);
CREATE INDEX machines_broker ON machines(broker_box_id);

-- `box_token_families` renamed and re-keyed. `vm_id` is the stamp: a token
-- family is minted for one VM incarnation, so a guest that outlives its VM
-- (stop, recreate, SetMachineType) presents a family whose stamp no longer
-- matches and is fenced out. `box_token_families` survives for the boxes that
-- are still boxes — brokers and device-code enrolments.
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

-- The workspace's own config columns. `machine_type_id` keeps its data and
-- gains "default" semantics: it is what a new machine takes when nothing else
-- is named, never a restriction on what a machine may be (§1a).
ALTER TABLE workspaces ADD COLUMN default_machine_type_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE workspaces ADD COLUMN auto_provision INTEGER NOT NULL DEFAULT 1
  CHECK (auto_provision IN (0, 1));
-- The workspace has no phase; it is always present. This is the tombstone the
-- old `phase = 'destroyed'` carried, set once the last machine is gone.
ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER;

UPDATE workspaces SET default_machine_type_id = machine_type_id;
UPDATE workspaces SET deleted_at = updated_at WHERE phase = 'destroyed';

-- The creator is the first workspace admin.
INSERT OR IGNORE INTO workspace_members
  (workspace_id, membership_id, role, added_by_membership_id, added_at)
SELECT id, owner_membership_id, 'admin', owner_membership_id, created_at
FROM workspaces
WHERE owner_membership_id IS NOT NULL;

-- A personal grant converts first, so it wins over the org-wide default when
-- one member holds both. editor → member, viewer → viewer.
INSERT OR IGNORE INTO workspace_members
  (workspace_id, membership_id, role, added_by_membership_id, added_at)
SELECT g.workspace_id, g.membership_id,
       CASE g.role WHEN 'editor' THEN 'member' ELSE 'viewer' END,
       g.granted_by_membership_id, g.created_at
FROM workspace_grants g
JOIN workspaces w ON w.id = g.workspace_id;

-- `org_share_role` was a workspace-wide default for every active member of the
-- org, so it converts to one row per active member.
INSERT OR IGNORE INTO workspace_members
  (workspace_id, membership_id, role, added_by_membership_id, added_at)
SELECT w.id, m.id,
       CASE w.org_share_role WHEN 'editor' THEN 'member' ELSE 'viewer' END,
       w.owner_membership_id, w.updated_at
FROM workspaces w
JOIN memberships m ON m.org_id = w.org_id AND m.status = 'active'
WHERE w.org_share_role IS NOT NULL;

-- One machine per existing workspace, owned by the workspace owner. It takes
-- the `boxes` row's id where one exists so every deployed guest keeps the id
-- it already presents on /boxes/:id/keys and carries in its token file.
INSERT INTO machines (
  id, workspace_id, membership_id, state, machine_type_id,
  compute_credential_source, vm_id, volume_id,
  ssh_host, ssh_port, ssh_user, ssh_host_public_key,
  phone_home_hash, phone_home_used,
  tunnel_id, tunnel_hostname, dns_record_id, broker_box_id,
  box_update_requested, box_image_reported, error, created_at, updated_at
)
SELECT
  COALESCE(b.id, 'machine-' || w.id),
  w.id,
  w.owner_membership_id,
  CASE w.phase
    WHEN 'creating'   THEN 'provisioning'
    WHEN 'ready'      THEN 'running'
    WHEN 'destroying' THEN 'destroying'
    WHEN 'destroyed'  THEN 'destroyed'
    ELSE 'error'
  END,
  w.machine_type_id,
  COALESCE(w.compute_credential_source, 'deployment'),
  w.vm_id, w.volume_id,
  w.ssh_host, w.ssh_port, w.ssh_user, w.ssh_host_public_key,
  w.phone_home_hash, w.phone_home_used,
  w.tunnel_id, w.tunnel_hostname, w.dns_record_id, b.broker_box_id,
  w.box_update_requested, w.box_image_reported, w.error, w.created_at, w.updated_at
FROM workspaces w
LEFT JOIN boxes b ON b.workspace_id = w.id
WHERE w.owner_membership_id IS NOT NULL;

-- Live box credentials, hash for hash. The stamp is the VM the family was
-- minted against, which is the VM the workspace still names.
INSERT INTO machine_token_families (
  machine_id, vm_id, access_hash, refresh_hash,
  previous_refresh_hash, previous_rotated_at, access_issued_at, generation
)
SELECT f.box_id, w.vm_id, f.access_hash, f.refresh_hash,
       f.previous_refresh_hash, f.previous_rotated_at, f.access_issued_at, f.generation
FROM box_token_families f
JOIN boxes b ON b.id = f.box_id
JOIN workspaces w ON w.id = b.workspace_id
JOIN machines m ON m.id = b.id;

-- Lease audit follows the machine. The column is added rather than renamed so
-- `credential_events.lease_id` never has to survive a table rebuild; rows
-- written before this migration keep `box_id` as their historical record.
ALTER TABLE credential_leases ADD COLUMN machine_id TEXT REFERENCES machines(id);
UPDATE credential_leases
SET machine_id = box_id
WHERE box_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM machines WHERE machines.id = credential_leases.box_id);

-- broker_keys is re-keyed onto machines. Only workspace boxes ever registered
-- keys (`POST /boxes/:id/keys` refuses a broker), so every row maps one to one
-- and the ids do not change — the broker feed serves the same bytes.
CREATE TABLE broker_keys_new (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  pubkey TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('mint', 'deposit')),
  UNIQUE (machine_id, pubkey, operation)
);

INSERT INTO broker_keys_new (id, machine_id, pubkey, operation)
SELECT k.id, k.box_id, k.pubkey, k.operation
FROM broker_keys k
JOIN machines m ON m.id = k.box_id;

DROP TABLE broker_keys;
ALTER TABLE broker_keys_new RENAME TO broker_keys;
CREATE INDEX broker_keys_machine ON broker_keys(machine_id);

-- The workspace boxes are machines now. Their token families moved above, so
-- deleting them here removes the second row, not the credential.
DELETE FROM box_token_families
WHERE box_id IN (SELECT id FROM boxes WHERE workspace_id IS NOT NULL);
DELETE FROM boxes WHERE workspace_id IS NOT NULL;
