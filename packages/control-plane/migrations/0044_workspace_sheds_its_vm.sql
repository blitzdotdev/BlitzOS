-- The workspace row loses every column that moved to `machines` (0041), the
-- sharing ACL that became `workspace_members`, and the plaintext environment
-- that became `workspace_credentials` (0042).
--
-- 0041 and 0042 copied all of it. Nothing here reads a column it has not
-- already written somewhere else.

-- The phase index has to go before its column can.
DROP INDEX workspaces_phase;

-- The sharing ACL. Its rows converted to `workspace_members` in 0041.
DROP INDEX grants_membership;
DROP TABLE workspace_grants;

-- VM identity and lifecycle: now machines(vm_id, ssh_*, phone_home_*).
ALTER TABLE workspaces DROP COLUMN phase;
ALTER TABLE workspaces DROP COLUMN vm_id;
ALTER TABLE workspaces DROP COLUMN volume_id;
ALTER TABLE workspaces DROP COLUMN ssh_host;
ALTER TABLE workspaces DROP COLUMN ssh_port;
ALTER TABLE workspaces DROP COLUMN ssh_user;
ALTER TABLE workspaces DROP COLUMN ssh_host_public_key;
ALTER TABLE workspaces DROP COLUMN error;
ALTER TABLE workspaces DROP COLUMN phone_home_hash;
ALTER TABLE workspaces DROP COLUMN phone_home_used;
ALTER TABLE workspaces DROP COLUMN tunnel_id;
ALTER TABLE workspaces DROP COLUMN tunnel_hostname;
ALTER TABLE workspaces DROP COLUMN dns_record_id;
ALTER TABLE workspaces DROP COLUMN compute_credential_source;
ALTER TABLE workspaces DROP COLUMN box_update_requested;
ALTER TABLE workspaces DROP COLUMN box_image_reported;

-- Renamed, not dropped: `default_machine_type_id` (0041) holds this value and
-- says what it now means — a default for new machines, never a restriction.
ALTER TABLE workspaces DROP COLUMN machine_type_id;

-- Replaced by workspace_members rows (0041).
ALTER TABLE workspaces DROP COLUMN org_share_role;

-- Replaced by workspace_credentials rows (0042).
ALTER TABLE workspaces DROP COLUMN environment;
