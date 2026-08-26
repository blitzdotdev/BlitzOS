-- Entitlements seam: the numbers a private billing service writes into core.
--
-- Core never learns a plan name. A plan is translated into integers by the
-- billing service and pushed through PUT /orgs/:id/entitlements; this table
-- holds the one number that had no home yet. The VM cap deliberately stays in
-- orgs.vm_limit, where core/workspaces.ts already enforces it — a second copy
-- here would be a second source of truth for the same limit.
--
-- An absent row means the free tier: one seat. That default only applies where
-- the ENTITLEMENTS_API_KEY secret is set. A self-host deployment leaves it
-- unset, no seat gate runs at all, and this table stays empty forever.
CREATE TABLE org_entitlements (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  seat_limit INTEGER NOT NULL CHECK (seat_limit >= 1),
  updated_at INTEGER NOT NULL
);
