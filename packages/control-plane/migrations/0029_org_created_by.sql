-- Records who created an org through POST /orgs, so that route can cap
-- self-serve org creation per user. The cap replaces the "you already have a
-- membership" 409 that route used to carry: that 409 was a signup-flow guard,
-- but it was also the only thing stopping one account from minting unlimited
-- vm_limit quota by creating orgs in a loop. Orgs created before this column,
-- and the operator bootstrap org, stay NULL and count against nobody.
ALTER TABLE orgs ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
