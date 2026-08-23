-- Invite lifecycle becomes stored facts instead of a synced label. Redemption
-- already stamps redeemed_at; revocation now stamps revoked_at; expiry was
-- never a decision at all, just what expires_at says at read time. Readers
-- derive the old four answers (revoked_at → 'revoked', else redeemed_at →
-- 'redeemed', else past expires_at → 'expired', else 'ready'), so the state
-- column has no writer or reader left. Rows the old write-on-read sync had
-- flipped to 'expired' derive the same answer from their expires_at.
--
-- SQLite refuses to drop a column an index mentions, so invites_org steps
-- aside and returns without state: the surviving list query filters by org
-- and orders by created_at.
DROP INDEX invites_org;
ALTER TABLE invites ADD COLUMN revoked_at INTEGER;
-- Revocation predates the timestamp, so the exact moment is gone; migration
-- time is the closest true epoch-ms fact, in the unit created_at uses.
UPDATE invites SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE state = 'revoked';
ALTER TABLE invites DROP COLUMN state;
CREATE INDEX invites_org ON invites(target_org_id, created_at);
