-- Per-user grants go live. `user_oauth_grants` arrived dead in 0003 (zero
-- readers, zero writers, zero rows) and 0017 only cleared its name, so this
-- rebuild drops nothing that was ever written. The key becomes
-- (user_id, provider): a grant is one person's authorization of one provider,
-- not a row hanging off an org connection row.
DROP TABLE user_oauth_grants;

CREATE TABLE user_oauth_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES principals(id),
  provider TEXT NOT NULL,                    -- connection name a box asks for
  manifest_id TEXT NOT NULL,                 -- catalog entry that interprets this grant
  kind TEXT NOT NULL CHECK (kind IN ('pat', 'oauth')),
  label TEXT,                                -- what the person called it
  config TEXT NOT NULL DEFAULT '{}',         -- non-secret: env names, base URL, header shape
  access_ciphertext TEXT,                    -- base64(12-byte IV ‖ AES-256-GCM access token)
  access_expires_at INTEGER,
  refresh_ciphertext TEXT,                   -- refresh token, or the pasted key (it does not expire)
  scopes TEXT NOT NULL,                      -- frozen at consent; the outer bound
  rotation INTEGER NOT NULL DEFAULT 0,       -- CAS counter; strict single-use refresh serializes on it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- One live grant per person per provider; revoked rows stay for the audit.
CREATE UNIQUE INDEX user_oauth_grants_live
  ON user_oauth_grants(user_id, provider) WHERE revoked_at IS NULL;
CREATE INDEX user_oauth_grants_provider ON user_oauth_grants(provider, user_id);

-- The grant a lease was minted from. NULL marks the legacy org-root mints that
-- 0003 shipped; the product path always sets it.
ALTER TABLE credential_leases ADD COLUMN grant_id TEXT REFERENCES user_oauth_grants(id);
CREATE INDEX leases_grant ON credential_leases(grant_id, state);
