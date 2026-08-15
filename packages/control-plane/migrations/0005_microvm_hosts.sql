CREATE TABLE microvm_hosts (
  name TEXT PRIMARY KEY,
  url TEXT,
  updated_at INTEGER,
  source TEXT CHECK (source IN ('static', 'registered'))
);
