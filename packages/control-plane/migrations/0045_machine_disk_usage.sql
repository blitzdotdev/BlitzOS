-- What the guest says about its own disk.
--
-- The persistent volume is the durable half of a member's machine
-- (plans/MEMBER-MACHINES.md §1), and nothing in the control plane could say
-- how full it was: a provider reports a size, never a usage. Only the guest
-- can measure it, so the guest reports it (POST /workspaces/self/machine-stats)
-- and it lands here.
--
-- Both columns are nullable and stay null forever for a machine whose guest
-- predates the reporter. That is the honest pending state the UI shows, and it
-- is why neither column takes a default: 0 would read as "empty disk".
ALTER TABLE machines ADD COLUMN disk_used_percent INTEGER
  CHECK (disk_used_percent IS NULL OR (disk_used_percent BETWEEN 0 AND 100));

-- When that percentage was measured, in epoch ms. A stale figure is worth
-- less than a fresh one, and only this column can tell them apart.
ALTER TABLE machines ADD COLUMN disk_reported_at INTEGER;
