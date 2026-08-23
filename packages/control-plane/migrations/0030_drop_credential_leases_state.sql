-- Lease lifecycle becomes stored facts instead of a swept label. The five
-- revocation writers now stamp revoked_at (still NULLing token_hash); expiry
-- is what expires_at says at read time; and the sweep that synced 'expired'
-- into rows is deleted. Readers derive the old three answers: revoked_at →
-- 'revoked', else past expires_at → 'expired', else 'active'. Revoked wins
-- over expired, exactly as the old sweep — which only flipped active rows —
-- left revoked labels alone as they aged.
--
-- SQLite refuses to drop a column an index mentions, so the three
-- state-bearing indexes step aside. They return keyed on what the surviving
-- queries actually filter by: workspace_id (lease list, supersede-on-mint,
-- surface tombstones, workspace destroy) and grant_id (grant revocation).
-- No surviving query filters on expires_at alone — the proxy authorizes by
-- primary key — so leases_expiry, which existed for the deleted sweep, does
-- not come back. leases_token (partial, token_hash only) never mentioned
-- state and stays put.
DROP INDEX leases_workspace;
DROP INDEX leases_expiry;
DROP INDEX leases_grant;
ALTER TABLE credential_leases ADD COLUMN revoked_at INTEGER;
-- Backfill from the audit trail where it exists: the single-lease revoke
-- route logged each revocation as a credential_events row. Bulk revocations
-- (workspace destroy, connection delete, grant replace, supersede-on-mint)
-- wrote no event, so those rows get migration time — the closest true
-- epoch-ms fact, in the unit issued_at uses.
UPDATE credential_leases SET revoked_at = COALESCE(
  (SELECT MIN(event.created_at) FROM credential_events event
   WHERE event.lease_id = credential_leases.id AND event.event = 'revoked'),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
) WHERE state = 'revoked';
ALTER TABLE credential_leases DROP COLUMN state;
CREATE INDEX leases_workspace ON credential_leases(workspace_id);
CREATE INDEX leases_grant ON credential_leases(grant_id);
