-- The credential-integration product noun becomes "connection".
-- Renames only: no table rebuilds, no data rewrites. Stored enum VALUES
-- (kind/custody/mode/state/event) and CHECK constraints are untouched.
ALTER TABLE integrations RENAME TO connections;

-- Dead table from 0003 (zero code references). Its old name now collides
-- with the product noun, so it moves out of the way.
ALTER TABLE user_connections RENAME TO user_oauth_grants;
ALTER TABLE user_oauth_grants RENAME COLUMN integration_id TO connection_id;

ALTER TABLE credential_leases RENAME COLUMN integration_id TO connection_id;
ALTER TABLE credential_requests RENAME COLUMN integration_name TO connection_name;
