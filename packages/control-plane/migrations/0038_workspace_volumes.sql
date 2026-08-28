-- Every workspace on a volume-capable provider gets its own volume, created
-- with the workspace and attached before the guest's first boot.
--
-- `auto_created` separates the two kinds of volume. A volume the operator made
-- through POST /volumes is theirs forever; only an auto-created one is ever
-- reclaimed. `detached_at` starts the retention clock when the workspace is
-- destroyed, and the janitor deletes the volume once the window closes.
-- NULL in either column is the legacy state: a hand-made volume with no clock.
ALTER TABLE volume_ownership ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE volume_ownership ADD COLUMN detached_at INTEGER;
ALTER TABLE volume_ownership ADD COLUMN workspace_id TEXT;

-- The janitor scans by retention clock, so the reclaim sweep never reads a row
-- it cannot act on.
CREATE INDEX volume_ownership_detached_at
  ON volume_ownership (detached_at)
  WHERE auto_created = 1 AND detached_at IS NOT NULL;
