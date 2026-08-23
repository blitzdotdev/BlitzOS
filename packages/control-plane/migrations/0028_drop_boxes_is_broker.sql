-- boxes.is_broker mirrored membership in broker_boxes; enrollment rows are
-- the single source of truth, and every reader now derives broker status
-- with an EXISTS against broker_boxes.
ALTER TABLE boxes DROP COLUMN is_broker;
