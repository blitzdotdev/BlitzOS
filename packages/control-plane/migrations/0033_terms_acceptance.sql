ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER CHECK (terms_accepted_at IS NULL OR terms_accepted_at >= 0);
ALTER TABLE users ADD COLUMN terms_version TEXT CHECK ((terms_version IS NULL AND terms_accepted_at IS NULL) OR (length(terms_version) BETWEEN 1 AND 64 AND terms_accepted_at IS NOT NULL));
