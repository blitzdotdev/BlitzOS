-- A box refresh token is single-use: redeeming it rotates the family and the
-- old hash stops matching. The box only writes the new pair to its disk AFTER
-- the control plane has already rotated, so a box that dies inside that window
-- holds a token this table no longer knows. There was no way back: one hash
-- per box, no history, and re-enrolment needs a human at a device code.
--
-- These two columns are the way back. The hash a rotation retires stays
-- redeemable for a bounded grace period, so a box that lost the write can
-- present what it still holds and get a working pair.
ALTER TABLE box_token_families ADD COLUMN previous_refresh_hash TEXT;
ALTER TABLE box_token_families ADD COLUMN previous_rotated_at INTEGER;
