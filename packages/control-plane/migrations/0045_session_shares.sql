-- Opt-in per-session sharing (plans/LODY-SHARING.md §1.1, plans/LODY-SESSIONS.md
-- §0.1). A Lody session is private to the member whose box runs it; a row here
-- is one deliberate grant of read-only or read-write access to one other member
-- of the same workspace.
--
-- `session_id` is NOT validated and NOT a foreign key. The daemon on the owner's
-- box is the only thing that knows which sessions exist, and a mirror here would
-- be a second source of truth that goes stale the moment a session is archived
-- on a box the control plane cannot reach. A row naming a session that does not
-- exist grants access to nothing: the relay's ACL is an intersection with what
-- the daemon actually holds.
--
-- A workspace admin's implicit read-only over every session is deliberately NOT
-- rows here. It is a role, computed at ticket-mint time, because writing it down
-- would mean one row per session — see the paragraph above — and revoking admin
-- would mean deleting them.
CREATE TABLE session_shares (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id),
  session_id               TEXT NOT NULL,
  -- Whose machine serves this session. The caller's own membership when an
  -- owner shares; an explicitly named member when a workspace admin grants on
  -- someone else's behalf.
  owner_membership_id      TEXT NOT NULL REFERENCES memberships(id),
  grantee_membership_id    TEXT NOT NULL REFERENCES memberships(id),
  level                    TEXT NOT NULL CHECK (level IN ('ro', 'rw')),
  created_at               INTEGER NOT NULL,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  UNIQUE (workspace_id, session_id, grantee_membership_id)
);

-- The grantee index serves the mint path, which runs on every proxied request
-- to a shared box and must not table-scan.
CREATE INDEX session_shares_by_grantee ON session_shares (workspace_id, grantee_membership_id);
CREATE INDEX session_shares_by_owner ON session_shares (workspace_id, owner_membership_id);
