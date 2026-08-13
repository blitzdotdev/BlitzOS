ALTER TABLE sessions
ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;

UPDATE sessions
SET expires_at = created_at + 2592000000
WHERE expires_at = 0;

CREATE INDEX sessions_expires_at ON sessions(expires_at);
