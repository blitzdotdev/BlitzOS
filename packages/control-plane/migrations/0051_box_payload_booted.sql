-- A boot report describes what the image started with; it is not an update
-- attempt and must not masquerade as the `up-to-date` no-op tick outcome.
-- Rename/add/copy/drop changes the CHECK without rebuilding the parent table,
-- preserving every machine token and lease that references machines(id).
ALTER TABLE machines RENAME COLUMN payload_outcome TO payload_outcome_legacy;
ALTER TABLE machines ADD COLUMN payload_outcome TEXT
  CHECK (payload_outcome IS NULL OR payload_outcome IN
    ('booted', 'applied', 'rolled-back', 'unsupported', 'fetch-failed',
     'verify-failed', 'start-failed', 'up-to-date'));
UPDATE machines SET payload_outcome = payload_outcome_legacy;
ALTER TABLE machines DROP COLUMN payload_outcome_legacy;
