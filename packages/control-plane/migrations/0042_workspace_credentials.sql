-- WORKSPACE CREDENTIALS (plans/MEMBER-MACHINES.md §1, "workspace_credentials").
--
-- One store, one read. `workspaces.environment` was per-workspace but
-- plaintext and delivered ambiently into every shell through
-- `creds/env.d/*.sh`; `connections` is sealed but org-scoped. This table is the
-- workspace-scoped sealed store, and `blitz-cred` is its only door.
--
-- This deliberately reverses migration 0028's ruling ("ad-hoc secrets are a
-- workspace file or .env"). The reversal is intended and recorded in the plan.
CREATE TABLE workspace_credentials (
  id                        TEXT PRIMARY KEY,
  workspace_id              TEXT NOT NULL REFERENCES workspaces(id),
  -- The environment variable name an agent asks for: STRIPE_API_KEY, ...
  name                      TEXT NOT NULL,
  label                     TEXT,
  -- base64(12-byte IV ‖ AES-256-GCM ciphertext) under CRED_MASTER_KEY, with
  -- AAD `wscred:<workspaceId>:<name>` — the same envelope shape connections
  -- use, bound to the row it belongs to so a ciphertext cannot be moved.
  ciphertext                TEXT NOT NULL,
  created_by_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  revoked_at                INTEGER
);

-- One live row per name. A revoked row stays for the audit trail, so the
-- uniqueness is partial rather than a plain UNIQUE.
CREATE UNIQUE INDEX workspace_credentials_live
  ON workspace_credentials(workspace_id, name)
  WHERE revoked_at IS NULL;

CREATE INDEX workspace_credentials_workspace
  ON workspace_credentials(workspace_id, created_at);

-- Existing `workspaces.environment` variables become rows here.
--
-- SQL cannot run AES-GCM, so the migration cannot produce a sealed value. It
-- writes the legacy envelope `plaintext:v0:<value>` instead, which
-- `core/workspace-credentials.ts` opens and every WRITE replaces with a real
-- sealed value. This is not a downgrade: the column being read here is
-- plaintext today, and it was delivered into a world-readable file on the box
-- on every boot. A rotate through the new routes seals it for good.
--
-- `json_each` walks the stored `{"env":{...},"startupScript":...}` document.
-- The startup script does NOT migrate: it is a boot hook, not a secret, and
-- nothing in the new model runs one.
INSERT OR IGNORE INTO workspace_credentials
  (id, workspace_id, name, label, ciphertext,
   created_by_membership_id, created_at, updated_at)
SELECT
  'wc-' || w.id || '-' || env.key,
  w.id,
  env.key,
  NULL,
  'plaintext:v0:' || env.value,
  w.owner_membership_id,
  w.updated_at,
  w.updated_at
FROM workspaces w
JOIN json_each(json_extract(w.environment, '$.env')) env
WHERE w.environment IS NOT NULL
  AND w.owner_membership_id IS NOT NULL
  AND json_valid(w.environment)
  AND json_type(w.environment, '$.env') = 'object'
  AND env.key GLOB '[A-Za-z]*';
