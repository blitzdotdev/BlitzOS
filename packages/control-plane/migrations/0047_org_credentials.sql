-- ORG CREDENTIALS (plans/ORG-CREDENTIALS.md §5) — and the DELIBERATE deletion
-- of the workspace credential store (§3).
--
-- One static plane remains: `org_credentials`, sealed like everything else
-- (AAD `orgcred:<orgId>:<name>`), with an explicit allowlist in
-- `org_credential_grants`. The `workspace_credentials` table is DROPPED and
-- its values are NOT migrated: the AAD reseal cannot run in SQL, same-name
-- collisions across workspaces make an automatic lift ambiguous, the store is
-- days old (migration 0042, 2026-08-28), and the org-level dotenv import
-- re-creates a workspace's worth of keys in one paste. This is a stated data
-- deletion, not an accident.
CREATE TABLE org_credentials (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES orgs(id),
  -- The environment variable name an agent asks for:
  -- ^[A-Za-z][A-Za-z0-9_]{0,127}$
  name                      TEXT NOT NULL,
  -- What the key is FOR; survives rotation (tri-state write semantics).
  comment                   TEXT,
  -- base64(12-byte IV ‖ AES-256-GCM) under CRED_MASTER_KEY, with AAD
  -- `orgcred:<orgId>:<name>` — bound to the row it belongs to so a
  -- ciphertext cannot be moved to another org or renamed and still open.
  ciphertext                TEXT NOT NULL,
  created_by_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  revoked_at                INTEGER
);

-- One live row per name. A revoked row stays as rotation history, so the
-- uniqueness is partial rather than a plain UNIQUE.
CREATE UNIQUE INDEX org_credentials_live
  ON org_credentials(org_id, name) WHERE revoked_at IS NULL;
CREATE INDEX org_credentials_org ON org_credentials(org_id, created_at);

-- The allowlist. Subjects are the whole org (subject_id NULL), a workspace,
-- or a membership; access is read or write (write ⊇ read). Org admins hold
-- both implicitly and never need a row. Grant rows hard-delete on revoke —
-- they are ACL state, not audit; audit lives in `credential_events`.
-- `subject_kind` is TEXT-open on purpose: 'team' slots in later without a
-- migration.
CREATE TABLE org_credential_grants (
  id                        TEXT PRIMARY KEY,
  credential_id             TEXT NOT NULL REFERENCES org_credentials(id),
  subject_kind              TEXT NOT NULL CHECK (subject_kind IN ('org','workspace','membership')),
  subject_id                TEXT,            -- NULL for 'org'; workspaces.id / memberships.id otherwise
  access                    TEXT NOT NULL CHECK (access IN ('read','write')),
  created_by_membership_id  TEXT NOT NULL REFERENCES memberships(id),
  created_at                INTEGER NOT NULL
);

CREATE UNIQUE INDEX org_credential_grants_subject
  ON org_credential_grants(credential_id, subject_kind, coalesce(subject_id, ''));

-- The workspace store goes with the box credential wire that served it
-- (plans/ORG-CREDENTIALS.md §3). See the header: values are deleted, not
-- migrated, by decision.
DROP TABLE workspace_credentials;
