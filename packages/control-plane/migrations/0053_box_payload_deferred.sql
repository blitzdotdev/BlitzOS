-- A daemon-changing release can be fully verified yet deliberately remain
-- inactive while Lody has a turn in flight. Surface that waiting state without
-- claiming either that the old release is up to date or that activation failed.
ALTER TABLE machines RENAME COLUMN payload_outcome TO payload_outcome_legacy;
ALTER TABLE machines ADD COLUMN payload_outcome TEXT
  CHECK (payload_outcome IS NULL OR payload_outcome IN
    ('booted', 'applied', 'deferred', 'rolled-back', 'unsupported',
     'fetch-failed', 'verify-failed', 'start-failed', 'up-to-date'));
UPDATE machines SET payload_outcome = payload_outcome_legacy;
ALTER TABLE machines DROP COLUMN payload_outcome_legacy;
