import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSource, sha256 } from "./source-utils.mjs";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "../..");
const DEFAULT_DIST_DIR = path.join(PACKAGE_DIR, ".managed-dist");
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_COUNT = 256;
export const CORE_MANIFEST = Object.freeze([
  "core/index.ts",
  "core/app.ts",
  "core/runtime.ts",
  "core/db.ts",
  "core/blobs.ts",
  "core/wire.ts",
  "core/bootstrap.ts",
  "core/box-images.ts",
  "core/cloud-init.ts",
  "core/crypto.ts",
  "core/credentials/types.ts", "core/credentials/root-crypto.ts", "core/credentials/manifest.ts", "core/credentials/leases.ts",
  "core/credentials/minters/static.ts", "core/credentials/minters/app-jwt/github-app.ts", "core/credentials/registry.ts", "core/credentials/requests.ts", "core/credentials/mint.ts", "core/credentials/proxy.ts",
  "core/http.ts",
  "core/files/access.ts", "core/files/attachments.ts", "core/files/folders.ts", "core/files/keys.ts", "core/files/objects.ts", "core/files/routes.ts", "core/files/sync.ts",
  "core/identity/google.ts", "core/identity/grants.ts", "core/identity/invites.ts", "core/identity/members.ts", "core/identity/oauth-state.ts", "core/identity/orgs.ts", "core/identity/routes.ts",
  "core/janitors.ts",
  "core/oauth.ts",
  "core/principals.ts",
  "core/registry.ts",
  "core/sessions.ts",
  "core/types.ts",
  "core/volumes.ts",
  "core/webapp-state.ts",
  "core/workspace-access.ts", "core/workspace-records.ts",
  "core/workspaces.ts",
  "core/providers/registry.ts", "core/providers/types.ts", "core/providers/hetzner.ts", "core/providers/microvm-hosts.js",
  "core/providers/microvm-config.ts", "core/providers/microvm-agent.ts", "core/providers/microvm-host-registry.ts", "core/providers/microvm.ts",
]);
export const UPLOAD_MANIFEST = Object.freeze([
  "teenybase.ts",
  "worker.ts",
  ...CORE_MANIFEST,
]);
export const UPLOAD_ORDER = Object.freeze([
  ...CORE_MANIFEST,
  "teenybase.ts",
  "worker.ts",
]);
export const DENY_ALL_RULES = Object.freeze({
  name: "rules",
  listRule: null,
  viewRule: null,
  createRule: null,
  updateRule: null,
  deleteRule: null,
});

export const BLITZDEV_CONFIG = Object.freeze({
  appName: "Blitz Control Plane",
  appUrl: "$APP_URL",
  jwtSecret: "$JWT_SECRET_MAIN",
  tables: [
    {
      name: "principals",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "unix_name", type: "text", sqlType: "text", notNull: true },
        { name: "harnesses", type: "text", sqlType: "text", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "users",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "google_user_id", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "email", type: "email", sqlType: "text", notNull: true, unique: true, check: "email = lower(email)" },
        { name: "name", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "avatar_url", type: "url", sqlType: "text" },
        { name: "platform_operator", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "platform_operator IN (0, 1)" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true, check: "created_at >= 0" },
        { name: "updated_at", type: "integer", sqlType: "integer", notNull: true, check: "updated_at >= created_at" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "orgs",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "slug", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "name", type: "text", sqlType: "text", notNull: true },
        { name: "vm_limit", type: "integer", sqlType: "integer", notNull: true, check: "vm_limit > 0" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true, check: "created_at >= 0" },
        { name: "updated_at", type: "integer", sqlType: "integer", notNull: true, check: "updated_at >= created_at" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "memberships",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "user_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "users", column: "id" } },
        { name: "org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } },
        { name: "role", type: "text", sqlType: "text", notNull: true, check: "role IN ('admin', 'member')" },
        { name: "status", type: "text", sqlType: "text", notNull: true, check: "status IN ('invited', 'active', 'disabled')" },
      ],
      indexes: [
        { name: "identity", unique: true, fields: ["user_id", "org_id"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "sessions",
      fields: [
        { name: "token_hash", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "principal_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "expires_at", type: "integer", sqlType: "integer", notNull: true, default: { l: 0 } },
        { name: "membership_id", type: "text", sqlType: "text", foreignKey: { table: "memberships", column: "id" } },
      ],
      indexes: [
        { name: "expires_at", fields: "expires_at" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "workspaces",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "owner_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "machine_type_id", type: "text", sqlType: "text", notNull: true, default: { l: "unknown" } },
        { name: "phase", type: "text", sqlType: "text", notNull: true, check: "phase IN ('creating', 'ready', 'destroying', 'destroyed', 'error')" },
        { name: "revision", type: "integer", sqlType: "integer", notNull: true, check: "revision > 0" },
        { name: "vm_id", type: "text", sqlType: "text" },
        { name: "volume_id", type: "text", sqlType: "text" },
        { name: "ssh_host", type: "text", sqlType: "text" },
        { name: "ssh_port", type: "integer", sqlType: "integer" },
        { name: "ssh_user", type: "text", sqlType: "text" },
        { name: "ssh_host_public_key", type: "text", sqlType: "text" },
        { name: "error", type: "text", sqlType: "text" },
        { name: "phone_home_hash", type: "text", sqlType: "text" },
        { name: "phone_home_used", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "phone_home_used IN (0, 1)" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "updated_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "manifest", type: "text", sqlType: "text" }, { name: "tunnel_id", type: "text", sqlType: "text" },
        { name: "tunnel_hostname", type: "text", sqlType: "text" }, { name: "dns_record_id", type: "text", sqlType: "text" },
        { name: "org_id", type: "text", sqlType: "text", foreignKey: { table: "orgs", column: "id" } }, { name: "owner_membership_id", type: "text", sqlType: "text", foreignKey: { table: "memberships", column: "id" } },
      ],
      indexes: [{ name: "owner", fields: ["owner_id", "created_at"] }, { name: "phase", fields: ["phase", "updated_at"] }],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "invites",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "code_hash", type: "text", sqlType: "text", notNull: true, unique: true, check: "length(code_hash) = 43" },
        { name: "email", type: "email", sqlType: "text", check: "email IS NULL OR email = lower(email)" }, { name: "target_org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } },
        { name: "role", type: "text", sqlType: "text", notNull: true, check: "role IN ('admin', 'member')" }, { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('ready', 'redeemed', 'revoked', 'expired')" },
        { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "redeemed_by_user_id", type: "text", sqlType: "text", foreignKey: { table: "users", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "expires_at", type: "integer", sqlType: "integer", notNull: true }, { name: "redeemed_at", type: "integer", sqlType: "integer" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "volume_ownership",
      fields: [
        { name: "volume_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } },
        { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "workspace_grants",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "role", type: "text", sqlType: "text", notNull: true, check: "role IN ('editor', 'viewer')" },
        { name: "granted_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      indexes: [{ name: "identity", unique: true, fields: ["workspace_id", "membership_id"] }],
      extensions: [DENY_ALL_RULES],
    },
    { name: "folders", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } }, { name: "name", type: "text", sqlType: "text", notNull: true }, { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "updated_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "org", fields: ["org_id", "created_at"] }], extensions: [DENY_ALL_RULES] },
    { name: "folder_grants", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "folder_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "folders", column: "id" } }, { name: "membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "role", type: "text", sqlType: "text", notNull: true, check: "role IN ('editor', 'viewer')" }, { name: "granted_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "identity", unique: true, fields: ["folder_id", "membership_id"] }, { name: "membership", fields: ["membership_id", "folder_id"] }], extensions: [DENY_ALL_RULES] },
    { name: "folder_attachments", fields: [{ name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } }, { name: "folder_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "folders", column: "id" } }, { name: "attached_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "identity", unique: true, fields: ["workspace_id", "folder_id"] }, { name: "folder", fields: ["folder_id", "workspace_id"] }], extensions: [DENY_ALL_RULES] },
    {
      name: "webapp_state",
      fields: [
        { name: "principal_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "workspace_id", type: "text", sqlType: "text", foreignKey: { table: "workspaces", column: "id" } },
        { name: "doc", type: "json", sqlType: "text", notNull: true },
        { name: "updated_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      indexes: [
        { name: "identity", unique: true, fields: ["principal_id", "workspace_id"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "device_authorizations",
      fields: [
        { name: "device_hash", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "user_hash", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "client_id", type: "text", sqlType: "text", notNull: true },
        { name: "principal_id", type: "text", sqlType: "text", foreignKey: { table: "principals", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "last_poll_at", type: "integer", sqlType: "integer" },
        { name: "consumed_at", type: "integer", sqlType: "integer" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "boxes",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "principal_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "workspace_id", type: "text", sqlType: "text", unique: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "broker_box_id", type: "text", sqlType: "text", foreignKey: { table: "broker_boxes", column: "box_id", onDelete: "SET NULL" } },
        { name: "is_broker", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "is_broker IN (0, 1)" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      indexes: [
        { name: "broker", fields: "broker_box_id" },
        { name: "principal", fields: "principal_id" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "box_token_families",
      fields: [
        { name: "box_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "access_hash", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "refresh_hash", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "access_issued_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "generation", type: "integer", sqlType: "integer", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "broker_boxes",
      fields: [
        { name: "box_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "host", type: "text", sqlType: "text", notNull: true },
        { name: "port", type: "integer", sqlType: "integer", notNull: true },
        { name: "ssh_host_public_key", type: "text", sqlType: "text", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "broker_keys",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "box_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "pubkey", type: "text", sqlType: "text", notNull: true },
        { name: "operation", type: "text", sqlType: "text", notNull: true, check: "operation IN ('mint', 'deposit')" },
      ],
      indexes: [
        { name: "box", fields: "box_id" },
        { name: "identity", unique: true, fields: ["box_id", "pubkey", "operation"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "integrations",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "name", type: "text", sqlType: "text", notNull: true },
        { name: "provider", type: "text", sqlType: "text", notNull: true },
        { name: "kind", type: "text", sqlType: "text", notNull: true },
        { name: "custody", type: "text", sqlType: "text", notNull: true, default: { l: "cp" } },
        { name: "config", type: "text", sqlType: "text", notNull: true, default: { l: "{}" } },
        { name: "root_ciphertext", type: "text", sqlType: "text" },
        { name: "usable_by", type: "text", sqlType: "text" },
        { name: "created_by", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "revoked_at", type: "integer", sqlType: "integer" },
        { name: "org_id", type: "text", sqlType: "text", foreignKey: { table: "orgs", column: "id" } }, { name: "created_by_membership_id", type: "text", sqlType: "text", foreignKey: { table: "memberships", column: "id" } }, { name: "scoped_name", type: "text", sqlType: "text" },
      ],
      indexes: [{ name: "org_name", unique: true, fields: ["org_id", "scoped_name"] }, { name: "org", fields: ["org_id", "created_at", "scoped_name"] }],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "user_connections",
      fields: [
        { name: "user_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "integration_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "integrations", column: "id" } },
        { name: "refresh_ciphertext", type: "text", sqlType: "text", notNull: true },
        { name: "scopes", type: "text", sqlType: "text", notNull: true },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "revoked_at", type: "integer", sqlType: "integer" },
      ],
      indexes: [
        { name: "identity", unique: true, fields: ["user_id", "integration_id"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "credential_leases",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "box_id", type: "text", sqlType: "text", foreignKey: { table: "boxes", column: "id", onDelete: "SET NULL" } },
        { name: "integration_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "integrations", column: "id" } },
        { name: "user_id", type: "text", sqlType: "text" },
        { name: "scopes", type: "text", sqlType: "text", notNull: true },
        { name: "mode", type: "text", sqlType: "text", notNull: true, check: "mode IN ('inject','proxy')" },
        { name: "token_hash", type: "text", sqlType: "text", unique: true },
        { name: "issued_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "expires_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('active','revoked','expired')" },
      ],
      indexes: [
        { name: "workspace", fields: ["workspace_id", "state"] },
        { name: "expiry", fields: ["state", "expires_at"] },
        { name: "token", fields: "token_hash", where: { q: "token_hash IS NOT NULL" } },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "credential_events",
      fields: [
        { name: "id", type: "integer", sqlType: "integer", primary: true, autoIncrement: true, noUpdate: true, noInsert: true },
        { name: "lease_id", type: "text", sqlType: "text", foreignKey: { table: "credential_leases", column: "id" } },
        { name: "event", type: "text", sqlType: "text", notNull: true, check: "event IN ('minted','revoked','denied','approved')" },
        { name: "detail", type: "text", sqlType: "text" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "credential_requests",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "integration_name", type: "text", sqlType: "text", notNull: true },
        { name: "requested_scopes", type: "text", sqlType: "text", notNull: true },
        { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('pending','approved','denied')" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "resolved_at", type: "integer", sqlType: "integer" },
        { name: "resolved_by", type: "text", sqlType: "text" },
        { name: "requester", type: "text", sqlType: "text" },
      ],
      indexes: [
        { name: "pending", fields: ["state", "created_at"] },
        { name: "dedup", unique: true, fields: ["workspace_id", "integration_name", "requested_scopes"], where: { q: "state = 'pending'" } },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "microvm_hosts",
      fields: [
        { name: "name", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "url", type: "text", sqlType: "text" },
        { name: "updated_at", type: "integer", sqlType: "integer" },
        { name: "source", type: "text", sqlType: "text", check: "source IN ('static', 'registered')" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "blitz_files",
      r2Base: "blitz-files",
      autoDeleteR2Files: false,
      allowMultipleFileRef: true,
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "kind", type: "text", sqlType: "text", notNull: true, check: "kind IN ('webapp', 'box-image')" },
        { name: "logical_path", type: "text", sqlType: "text", notNull: true },
        { name: "object", type: "file", sqlType: "text", notNull: true },
        { name: "media_type", type: "text", sqlType: "text", notNull: true },
        { name: "size_bytes", type: "integer", sqlType: "integer", notNull: true, check: "size_bytes >= 0" },
        { name: "sha256", type: "text", sqlType: "text", notNull: true },
        { name: "release_id", type: "text", sqlType: "text", notNull: true },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
      ],
      indexes: [
        { name: "logical", unique: true, fields: ["kind", "logical_path"] },
        { name: "release", fields: ["kind", "release_id"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
  ],
});

function tsValue(value, depth = 0) {
  if (value === DENY_ALL_RULES) return "denyAllRules";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const indent = "  ".repeat(depth + 1);
    return `[\n${indent}${value.map((item) => tsValue(item, depth + 1)).join(`,\n${indent}`)},\n${"  ".repeat(depth)}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const indent = "  ".repeat(depth + 1);
    return `{\n${indent}${entries.map(([key, item]) => `${key}: ${tsValue(item, depth + 1)}`).join(`,\n${indent}`)},\n${"  ".repeat(depth)}}`;
  }
  return JSON.stringify(value);
}

export const TEENYBASE_SOURCE = normalizeSource(`import type { DatabaseSettings, TableRulesExtensionData } from "teenybase";

const denyAllRules: TableRulesExtensionData = ${tsValue({ ...DENY_ALL_RULES })};

const config = ${tsValue(BLITZDEV_CONFIG)} satisfies DatabaseSettings;

export default config;
`);

export const WORKER_SOURCE = normalizeSource(`import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase";
import config from "virtual:teenybase";
import {
  credentialMasterKeyFor,
  createSessionPrincipalSource,
  HetznerProvider,
  installControlPlaneRoutes,
  MicrovmPoolProvider,
  maybeScheduleLazySweep,
  maxConcurrentWorkspacesFromEnv,
  runFileSyncSweep, runInvariantSweep, runLeaseSweep, runOrphanSweep,
  runSessionSweep, runWorkspaceTunnelSweep,
  sessionTtlMsFromEnv,
  VmProviderRegistry,
  blobResponse,
  first,
  type BlobObject,
  type BlobStore,
  type CoreContext,
  type CoreRouter,
  type CoreRuntime,
  type Db,
} from "./core/index";

type ManagedBindings = {
  APP_URL: string;
  RESPOND_WITH_ERRORS: string | boolean;
  RESPOND_WITH_QUERY_LOG: string | boolean;
  TEENY_PRIMARY_DB: ConstructorParameters<typeof $Database>[2];
  TEENY_PRIMARY_R2: ConstructorParameters<typeof $Database>[3];
  HETZNER_API_TOKEN: string;
  JWT_SECRET_MAIN: string;
  OPERATOR_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BOX_IMAGE_REF: string;
  BOX_IMAGE_SHA256: string;
  BOX_IMAGE_TAG: string;
  SESSION_TTL_DAYS: string;
  MAX_CONCURRENT_WORKSPACES: string;
  MICROVM_HOSTS: string;
  CRED_MASTER_KEY: string;
};

type ManagedEnv = {
  Bindings: ManagedBindings;
  Variables: {
    settings: typeof config;
    $db: $Database;
    $credentialMasterKey: CryptoKey;
  };
};

interface ManagedContext {
  readonly env: ManagedBindings;
  get(name: string): unknown;
  readonly executionCtx: { waitUntil(promise: Promise<unknown>): void };
}

interface WebAppContext {
  readonly req: { readonly raw: Request };
  get(name: "$db"): $Database;
  json(value: { error: string; retryAction: null }, status: number): Response;
}

interface ManagedFileRow {
  object: string;
  media_type: string;
  size_bytes: number;
}

function dynamicBinding(env: ManagedBindings, name: string): unknown {
  return Reflect.get(env, name);
}

function providersFor(env: ManagedBindings, db: Db): CoreRuntime["providers"] {
  const hetzner = new HetznerProvider(env.HETZNER_API_TOKEN);
  const microvm = new MicrovmPoolProvider(
    env.MICROVM_HOSTS,
    (tokenVar) => dynamicBinding(env, tokenVar),
    { db },
  );
  return {
    vmRegistry: new VmProviderRegistry([hetzner, microvm]),
    volume: hetzner,
    microvm,
  };
}

const API_PREFIXES = [
  "/sessions",
  "/workspaces",
  "/volumes",
  "/machine-types",
  "/webapp-state",
  "/auth/",
  "/me",
  "/orgs",
  "/hosts/",
  "/oauth/",
  "/boxes/",
  "/integrations",
  "/leases/",
  "/requests",
  "/proxy/",
  "/box-image",
  "/api/",
];

function managedBlobStore(db: $Database, kind: "box-image" | "webapp"): BlobStore {
  return {
    async get(logicalPath): Promise<BlobObject | null> {
      const row = await first<ManagedFileRow>(db, {
        q: "SELECT object, media_type, size_bytes FROM blitz_files WHERE kind = ? AND logical_path = ? LIMIT 1",
        v: [kind, logicalPath],
      });
      if (row === null) return null;
      const object = await db.getFileObject("blitz-files/" + row.object);
      if (object === null) return null;
      return {
        body: object.body,
        size: row.size_bytes,
        httpEtag: object.httpEtag,
        writeHttpMetadata(headers) {
          object.writeHttpMetadata(headers);
          headers.set("content-type", row.media_type);
        },
      };
    },
  };
}

function isApiPath(pathname: string): boolean {
  return API_PREFIXES.some((prefix) => pathname === (prefix.endsWith("/") ? prefix.slice(0, -1) : prefix) || pathname.startsWith(prefix));
}

async function webAppResponse(context: WebAppContext, logicalPath: string): Promise<Response> {
  const object = await managedBlobStore(context.get("$db"), "webapp").get(logicalPath);
  if (object === null) return context.json({ error: "not found", retryAction: null }, 404);
  const response = blobResponse(object, context.req.raw);
  response.headers.set(
    "cache-control",
    logicalPath.startsWith("/assets/") && /-[A-Za-z0-9_-]{8,}\\.[^/]+$/u.test(logicalPath)
      ? "public,max-age=31536000,immutable"
      : "no-cache",
  );
  return response;
}

function runtimeFor(context: CoreContext): CoreRuntime;
function runtimeFor(context: ManagedContext): CoreRuntime;
function runtimeFor(context: CoreContext | ManagedContext): CoreRuntime {
  const env = context.env as ManagedBindings;
  const db = context.get("$db") as Db;
  return {
    db,
    blobs: managedBlobStore(context.get("$db") as $Database, "box-image"),
    fileObjects: env.TEENY_PRIMARY_R2 as R2Bucket,
    credentialMasterKey: context.get("$credentialMasterKey") as CryptoKey,
    vars: {
      boxImageRef: env.BOX_IMAGE_REF,
      boxImageSha256: env.BOX_IMAGE_SHA256,
      boxImageTag: env.BOX_IMAGE_TAG,
      sessionTtlMs: sessionTtlMsFromEnv(env.SESSION_TTL_DAYS),
      maxConcurrentWorkspaces: maxConcurrentWorkspacesFromEnv(env.MAX_CONCURRENT_WORKSPACES),
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      bootstrapSecret: env.OPERATOR_API_KEY,
    },
    providers: providersFor(env, db),
    principalSource: createSessionPrincipalSource(),
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
    reportError: (event, error) => console.error(JSON.stringify({ event, error: error.message })),
  };
}

const app = teenyHono<ManagedEnv>(
  async (c) => {
    c.set("$credentialMasterKey", await credentialMasterKeyFor(c.env.CRED_MASTER_KEY));
    return new $Database(c, config, c.env.TEENY_PRIMARY_DB, c.env.TEENY_PRIMARY_R2);
  },
  undefined,
  { cors: false, logger: true },
  async (c) => {
    const runtime = runtimeFor(c);
    await runtime.providers.microvm?.syncStaticHosts();
    maybeScheduleLazySweep(runtime, c.req.path);
  },
);

installControlPlaneRoutes(app as unknown as CoreRouter, runtimeFor);
app.get("/assets/*", (c) => webAppResponse(c, c.req.path));
app.get("/", (c) => webAppResponse(c, "/index.html"));
app.get("*", (c) => isApiPath(c.req.path)
  ? c.json({ error: "not found", retryAction: null }, 404)
  : webAppResponse(c, "/index.html"));
const worker = Object.assign(app, {
  async scheduled(_event: ScheduledController, env: ManagedBindings, executionContext: ExecutionContext) {
    const db = new $DatabaseRawImpl(env.TEENY_PRIMARY_DB);
    executionContext.waitUntil((async () => {
      const key = await credentialMasterKeyFor(env.CRED_MASTER_KEY);
      const runtime = runtimeFor({
        env, executionCtx: executionContext,
        get: (name) => name === "$db" ? db : key,
      });
      await runtime.providers.microvm?.syncStaticHosts();
      await runSessionSweep(runtime); await runLeaseSweep(runtime);
      await runInvariantSweep(runtime); await runOrphanSweep(runtime);
      await runWorkspaceTunnelSweep(runtime); await runFileSyncSweep(runtime);
    })());
  },
});
export default worker;
`);

export function importSpecifiers(source) {
  const imports = [];
  const staticPattern = /\b(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\s+from\s*)?["']([^"']+)["']/gu;
  const dynamicPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(staticPattern)) {
    imports.push({ specifier: match[2], typeOnly: match[1] !== undefined });
  }
  for (const match of source.matchAll(dynamicPattern)) {
    imports.push({ specifier: match[1], typeOnly: false });
  }
  return imports;
}

function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

export function validateUploadSet(entries) {
  const paths = entries.map((entry) => entry.path);
  const duplicates = paths.filter((entryPath, index) => paths.indexOf(entryPath) !== index);
  if (duplicates.length > 0) throw new Error(`duplicate output paths: ${duplicates.join(", ")}`);
  if (entries.length > MAX_FILE_COUNT) throw new Error(`upload set has ${entries.length} files; maximum is ${MAX_FILE_COUNT}`);

  for (const entry of entries) {
    const bytes = Buffer.byteLength(entry.source);
    if (bytes > MAX_FILE_BYTES) throw new Error(`${entry.path} is ${bytes} bytes; maximum is ${MAX_FILE_BYTES}`);
    const imports = importSpecifiers(entry.source);
    if (entry.path.startsWith("core/")) {
      const forbidden = imports.filter(({ specifier }) => !isRelative(specifier));
      if (forbidden.length > 0) throw new Error(`${entry.path} has forbidden import ${forbidden[0].specifier}`);
    } else if (entry.path === "worker.ts") {
      const forbidden = imports.filter(({ specifier }) =>
        !isRelative(specifier) && specifier !== "teenybase" && specifier !== "virtual:teenybase");
      if (forbidden.length > 0) throw new Error(`worker.ts has forbidden import ${forbidden[0].specifier}`);
    } else if (entry.path === "teenybase.ts") {
      const forbidden = imports.filter(({ specifier, typeOnly }) => specifier !== "teenybase" || !typeOnly);
      if (forbidden.length > 0) throw new Error("teenybase.ts may only type-import teenybase");
    }
  }
}

export function createUploadSet(coreSources) {
  const entries = [
    { path: "teenybase.ts", source: TEENYBASE_SOURCE },
    { path: "worker.ts", source: WORKER_SOURCE },
    ...CORE_MANIFEST.map((uploadPath) => {
      const source = coreSources.get(uploadPath);
      if (source === undefined) throw new Error(`missing source for ${uploadPath}`);
      return { path: uploadPath, source: normalizeSource(source) };
    }),
  ];
  validateUploadSet(entries);
  const files = entries.map((entry) => ({
    ...entry,
    bytes: Buffer.byteLength(entry.source),
    sha256: sha256(entry.source),
  }));
  const releaseHash = sha256(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(""));
  return { files, releaseHash };
}

export async function readCoreSources(packageDir = PACKAGE_DIR) {
  const entries = await Promise.all(CORE_MANIFEST.map(async (uploadPath) => {
    const relative = uploadPath.slice("core/".length);
    return [uploadPath, await readFile(path.join(packageDir, "core", relative), "utf8")];
  }));
  return new Map(entries);
}

export async function emitUploadSet({ packageDir = PACKAGE_DIR, distDir = DEFAULT_DIST_DIR } = {}) {
  const uploadSet = createUploadSet(await readCoreSources(packageDir));
  await rm(distDir, { recursive: true, force: true });
  for (const file of uploadSet.files) {
    const destination = path.join(distDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.source, "utf8");
  }
  return { ...uploadSet, distDir };
}
