-- GRANT PROPOSALS GET A ROW (plans/ORG-CREDENTIALS.md §7a).
--
-- The proposal store was an in-memory Map on the CP runtime. On Workers that
-- is one Map per isolate, so a proposal filed on one isolate answered 404 on
-- the next — the agent's poll and the person's approval feed each saw it
-- only by luck (observed 2026-09-02: one hit in four polls). A proposal is
-- a hand-off between two callers, so it needs the one store both reach.
--
-- `proposed` and `applied` are the JSON change lists as the wire carries
-- them (`GrantChange[]`); the row is the hand-off, not an audit — the
-- durable record of an approval is still the grant rows it writes and their
-- `credential_events`. Expiry stays lazy: a pending row read past its TTL
-- flips to `expired` on the spot, and inserts sweep rows past their TTL.
CREATE TABLE grant_proposals (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  machine_id     TEXT NOT NULL,
  membership_id  TEXT NOT NULL REFERENCES memberships(id),
  reason         TEXT NOT NULL,
  proposed       TEXT NOT NULL,
  applied        TEXT,
  state          TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'denied', 'expired')),
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);

CREATE INDEX grant_proposals_org_pending ON grant_proposals(org_id, state, created_at);
