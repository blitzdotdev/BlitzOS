-- A standing read-only credential for operators.
--
-- Until now the only credential this app accepts is the `blitz_session`
-- cookie, which carries full account access and is obtainable only through a
-- Google browser login. During an incident that forced a human to paste that
-- cookie into a chat transcript so a tool could look at the control plane.
--
-- An operator token replaces it with a credential that cannot do damage:
-- core/operator-tokens.ts refuses every request outside a GET of the
-- workspace list, one workspace, or the box files port.
--
-- Only the SHA-256 of the token is stored, so the plaintext exists once, in
-- the response to the mint call. `created_by_membership_id` is both the
-- access the token carries and the operator it is attributed to, through
-- memberships.user_id.
CREATE TABLE operator_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by_membership_id TEXT NOT NULL REFERENCES memberships(id),
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
