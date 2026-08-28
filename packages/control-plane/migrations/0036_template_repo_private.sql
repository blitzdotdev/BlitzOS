-- The old schema cannot reconstruct privacy for existing rows, so they retain
-- their former public-clone semantics. New writes store a server-derived probe
-- verdict, which lets workspace create refuse a private clone before a member
-- waits ten minutes for bootstrap to give up in repo-clone.log.
ALTER TABLE workspace_template_repos
ADD COLUMN private INTEGER NOT NULL DEFAULT 0;
