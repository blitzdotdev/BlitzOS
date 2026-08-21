-- Credential roaming (plans/CREDENTIAL-ROAMING.md § Provisioning): the
-- blast-radius cap production carries as `broker_boxes.member_cap`.
--
-- It is NOT a capacity number and it is not a performance knob. It is how many
-- identities ONE broker-box compromise takes with it, and a broker box holds
-- the only copy of every member's vendor refresh token. 25 is the production
-- value.
--
-- Reaching the cap is not an error condition to engineer around: `POST
-- /boxes/:id/keys` returns 409 `no_broker_capacity`, the workspace removes its
-- stale broker wiring and exits 0 (signed-out is a workspace a human can fix),
-- and a second broker box is a human running packages/broker/deploy/OPS.md.
-- There is deliberately no autoscaler: an automatic create path on a box class
-- outside every reaper, with no drain and no delete path, is a leak generator.
ALTER TABLE broker_boxes
  ADD COLUMN member_cap INTEGER NOT NULL DEFAULT 25 CHECK (member_cap > 0);
