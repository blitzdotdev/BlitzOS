-- Delete every trace of the `generic` catalog entry. The entry is gone from
-- the code in the same change: ad-hoc secrets are a workspace file or `.env`
-- the member writes, not a connection the control plane holds.
--
-- DESTRUCTIVE, and approved for it (ruling 2026-08-23, plans/CONNECTIONS-FLOW.md
-- "PR #22 CHARTER": "canary/staging is no critical info anyway"). Sealed
-- ciphertext goes with the rows; there is no undo but a database restore.
--
-- Column names read from the migrations that created them:
--   user_oauth_grants.manifest_id  (0023) names the catalog entry
--   connections.provider           (0003 as integrations.provider, renamed 0022)
--                                  holds the manifest id for a catalog row
--   credential_leases.connection_id / .grant_id  (0022, 0023)
--
-- Order is dictated by the foreign keys: events reference leases, leases
-- reference both connections and grants.

DELETE FROM credential_events
 WHERE lease_id IN (
   SELECT id FROM credential_leases
    WHERE connection_id IN (SELECT id FROM connections WHERE provider = 'generic')
       OR grant_id IN (SELECT id FROM user_oauth_grants WHERE manifest_id = 'generic')
 );

DELETE FROM credential_leases
 WHERE connection_id IN (SELECT id FROM connections WHERE provider = 'generic')
    OR grant_id IN (SELECT id FROM user_oauth_grants WHERE manifest_id = 'generic');

-- Open connect requests naming a generic connection can never be satisfied
-- now: nothing in the catalog answers to the name.
DELETE FROM credential_requests
 WHERE connection_name IN (SELECT scoped_name FROM connections WHERE provider = 'generic');

DELETE FROM connections WHERE provider = 'generic';

DELETE FROM user_oauth_grants WHERE manifest_id = 'generic';
