-- GitHub became a personal-token connector: no organization credential, no
-- OAuth. Rows created under the old paths would otherwise stay live and fail
-- in ways that read as breakage rather than as a removed feature.
--
-- An org app-jwt row keeps a sealed root, so the connect grid still showed
-- GitHub as backed while every mint answered 404 — resolveMinter no longer
-- claims the kind. Revoking it lets the tile fall back to the paste form.
UPDATE connections
SET revoked_at = unixepoch() * 1000, root_ciphertext = NULL
WHERE provider = 'github' AND kind = 'app-jwt' AND revoked_at IS NULL;

-- A member's OAuth grant holds an 8-hour user token that can never refresh,
-- because the manifest has no authorize endpoint any more. Left alone it
-- mints 409 forever with no instruction; revoked, the member is asked to
-- paste a token, which is the only GitHub credential there is now.
UPDATE user_oauth_grants
SET revoked_at = unixepoch() * 1000
WHERE provider = 'github' AND kind = 'oauth' AND revoked_at IS NULL;
