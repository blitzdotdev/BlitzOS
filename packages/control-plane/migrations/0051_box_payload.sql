-- In-place box payload delivery (plans/THIN-IMAGE.md §4).
--
-- A guest reports the payload and daemon versions it is actually running to
-- POST /workspaces/self/payload-result. These columns are nullable so a box
-- image predating the payload updater has an honest "not reported" state.
-- The outcome describes the last attempt; the report timestamp is receipt
-- time in epoch milliseconds.
ALTER TABLE machines ADD COLUMN payload_reported TEXT;
ALTER TABLE machines ADD COLUMN daemon_reported TEXT;
ALTER TABLE machines ADD COLUMN payload_outcome TEXT
  CHECK (payload_outcome IS NULL OR payload_outcome IN
    ('applied', 'rolled-back', 'unsupported', 'fetch-failed',
     'verify-failed', 'start-failed', 'up-to-date'));
ALTER TABLE machines ADD COLUMN payload_reported_at INTEGER;

-- Rollout control is per machine: the deployment-wide pin remains selected,
-- but GET /workspaces/self/box-config answers payload: null for this one box.
ALTER TABLE machines ADD COLUMN payload_hold INTEGER NOT NULL DEFAULT 0
  CHECK (payload_hold IN (0, 1));
