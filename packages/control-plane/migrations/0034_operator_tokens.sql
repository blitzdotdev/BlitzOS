-- A standing read-only credential for operators, so that diagnosing an
-- incident no longer needs somebody's `blitz_session` cookie. What it may
-- reach, and why, is in core/operator-tokens.ts.
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
