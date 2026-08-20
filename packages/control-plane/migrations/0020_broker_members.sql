-- Credential roaming: WHERE a member's credential home lives, kept apart from
-- whether any of their workspaces happens to exist right now.
--
-- Membership used to be inferred from live `boxes` rows (`boxes.broker_box_id`
-- IS NOT NULL). Boxes are hard-deleted on destroy, so destroying a member's
-- LAST workspace dropped them out of `GET /boxes/:id/feed`; absence from the
-- feed is the broker's deprovision signal, and the broker then ran `userdel
-- --remove` and `os.RemoveAll(home)` on a home holding the only copy of that
-- member's vendor refresh token. Single-copy-by-construction is the point of
-- the design, so "no workspaces open" must not mean "delete the credential".
--
-- Production keys the feed on this table rather than on live machines
-- (monorepov2 0023_credential_broker.sql). Same shape here, on the identity
-- blitz-core actually has: one row per PRINCIPAL, not per membership.
--
-- The row outlives every workspace and is removed only when the identity goes
-- (principal deleted) or the broker box it names is un-enrolled. `broker_keys`
-- deliberately does NOT move here: keys are per box and CASCADE away with the
-- box on destroy, which is the revocation path and must keep working. A member
-- with zero live boxes therefore appears in the feed with an empty key list —
-- the wire's "keep the account, serve no keys" state.
CREATE TABLE broker_members (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  -- CASCADE, not RESTRICT: `DELETE /boxes/:id/broker` un-enrols a broker box,
  -- and a membership naming a box the control plane no longer knows would
  -- pin every future workspace of that member to nothing. Losing the row
  -- sends them back through placement on their next registration.
  broker_box_id TEXT NOT NULL REFERENCES broker_boxes(box_id) ON DELETE CASCADE,
  -- Derived server-side from the principal (core/registry.ts brokerUnixName),
  -- never accepted from a caller. Stored rather than re-derived so the UNIQUE
  -- below can exist at all: a digest collision here would hand one member
  -- another member's credential home, and this is the only place that can
  -- refuse it.
  unix_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (broker_box_id, unix_name)
);

CREATE INDEX broker_members_box ON broker_members(broker_box_id);

-- No backfill: `POST /boxes/:id/keys`, the only writer of broker placement,
-- ships in the same change as this table, and every box re-registers on each
-- boot — so the first registration after this migration creates the row.
