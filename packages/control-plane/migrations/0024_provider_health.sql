-- The canary's record: one row per provider, overwritten each run. `detail`
-- is a redacted summary (status and the field that was missing) and never a
-- response body, so a failing probe cannot leak account data into the panel.
CREATE TABLE provider_health (
  provider TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('healthy', 'unhealthy')),
  detail TEXT,
  checked_at INTEGER NOT NULL,
  latency_ms INTEGER
);
