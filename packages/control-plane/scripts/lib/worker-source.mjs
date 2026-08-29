import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertClosedUploadSet,
  hasRuntimeExtension,
  importSpecifiers,
  isRelative,
  loaderSpecifier,
  rewriteSpecifiers,
} from "./module-graph.mjs";
import { normalizeSource, sha256 } from "./source-utils.mjs";
import {
  coreRoutePaths,
  FRAMEWORK_ROUTE_PATHS,
  managedApiExactPaths,
  managedApiPrefixes,
} from "./worker-first-routes.mjs";
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
  "core/wire.ts", "core/wire-machines.ts",
  "core/agent-rules.ts",
  "core/bootstrap.ts",
  "core/box-config.ts",
  "core/box-images.ts",
  "core/cloud-init.ts",
  "core/crypto.ts",
  "core/entitlements.ts",
  "core/environment.ts",
  "core/connections/types.ts", "core/connections/pull-routes.ts", "core/connections/pull-wire.ts", "core/connections/root-crypto.ts", "core/connections/manifest.ts", "core/connections/leases.ts",
  "core/connections/catalog/types.ts", "core/connections/catalog/github.ts", "core/connections/catalog/google-workspace.ts", "core/connections/catalog/linear.ts", "core/connections/catalog/discord.ts", "core/connections/catalog/youtrack.ts", "core/connections/catalog/index.ts",
  "core/connections/user-grants.ts", "core/connections/minters/static.ts", "core/connections/minters/oauth.ts", "core/connections/minters/grant.ts",
  "core/connections/registry.ts", "core/connections/requests.ts", "core/connections/health.ts", "core/connections/canary.ts", "core/connections/connect.ts", "core/connections/mint.ts", "core/connections/proxy.ts", "core/connections/github-repo-check.ts", "core/connections/github-repositories.ts",
  "core/http.ts",
  "core/files/access.ts", "core/files/attachments.ts", "core/files/dav.ts", "core/files/folders.ts", "core/files/keys.ts", "core/files/objects.ts", "core/files/readiness.ts", "core/files/routes.ts", "core/files/schedule.ts", "core/files/sync.ts", "core/files/usage-push.ts",
  "core/identity/google.ts", "core/identity/invites.ts", "core/identity/members.ts", "core/identity/orgs.ts", "core/identity/routes.ts",
  "core/janitors.ts",
  "core/machines.ts",
  "core/machine-stats.ts",
  "core/oauth-state.ts",
  "core/oauth.ts",
  "core/operator-tokens.ts",
  "core/principals.ts",
  "core/recipes.ts",
  "core/registry.ts",
  "core/sessions.ts",
  "core/version.ts",
  "core/signup-config.js",
  "core/types.ts",
  "core/volumes.ts",
  "core/preview.ts",
  "core/webapp-state.ts", "core/webapp-proxy.ts", "core/webapp-surface.ts", "core/webapp-tickets.ts",
  "core/template-repos.ts",
  "core/workspace-access.ts", "core/workspace-credentials.ts", "core/workspace-members.ts",
  "core/workspace-names.ts", "core/workspace-projection.ts", "core/workspace-records.ts",
  "core/workspace-settings.ts",
  "core/workspace-tunnels.ts",
  "core/workspace-volumes.ts",
  "core/workspaces.ts",
  "core/compute/registry.ts", "core/compute/types.ts", "core/compute/hetzner-config.ts", "core/compute/hetzner.ts", "core/compute/json-fetch.ts", "core/compute/org-credentials.ts", "core/compute/workspace-placement.ts", "core/compute/microvm-hosts.js",
  "core/compute/microvm-config.ts", "core/compute/microvm-agent.ts", "core/compute/microvm-host-registry.ts", "core/compute/microvm.ts",
  "core/compute/aws.ts", "core/compute/aws-prices.ts", "core/compute/aws-sigv4.ts",
  "core/compute/aws-xml.ts", "core/compute/cloudflare-tunnels.ts",
]);

// core/agent-rules.ts imports the box-image rules skeleton as a Text module
// (the `[[rules]]` block in wrangler.toml). The managed contract is source
// files only — there is no text-import mechanism — so the emitter inlines
// those bytes into a generated module and repoints the importer at it, the
// same way core/bootstrap.ts already inlines its bash and Python payloads.
// The .md stays the single source of truth; nothing is copied into the repo.
export const TEXT_ASSETS = Object.freeze([
  Object.freeze({
    specifier: "../../box/rootfs/opt/blitz/skel/agent-rules.md",
    sourcePath: "../box/rootfs/opt/blitz/skel/agent-rules.md",
    uploadPath: "core/agent-rules-doc.ts",
  }),
]);
export const GENERATED_MANIFEST = Object.freeze(TEXT_ASSETS.map((asset) => asset.uploadPath));
export const UPLOAD_MANIFEST = Object.freeze([
  "teenybase.ts",
  "worker.ts",
  ...CORE_MANIFEST,
  ...GENERATED_MANIFEST,
]);
export const UPLOAD_ORDER = Object.freeze([
  ...CORE_MANIFEST,
  ...GENERATED_MANIFEST,
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
  // Empty, not "$JWT_SECRET_MAIN": every table below is DENY_ALL_RULES with no
  // auth extension, so teenybase mounts no JWT route and never reads this. The
  // key stays because databaseSettingsSchema requires the string.
  jwtSecret: "",
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
        { name: "usage_capture", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "usage_capture IN (0, 1)" },
        // No folders foreignKey on purpose (migration 0021): a deleted usage
        // folder may dangle here; the usage-push leg inner-joins folders.
        { name: "usage_folder_id", type: "text", sqlType: "text" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      // Numbers a private billing service writes through
      // PUT /orgs/:id/entitlements. No plan name, ever. The VM cap is not here
      // on purpose: it stays orgs.vm_limit, the column core/workspaces.ts
      // enforces, so one limit never gets two sources of truth.
      name: "org_entitlements",
      fields: [
        { name: "org_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "orgs", column: "id" } },
        { name: "seat_limit", type: "integer", sqlType: "integer", notNull: true, check: "seat_limit >= 1" },
        // Migration 0037. A boolean-shaped integer: the plan that produced it
        // stays on the billing side, and core only ever reads 0 or 1.
        { name: "platform_compute", type: "integer", sqlType: "integer", notNull: true, default: { l: 0 } },
        { name: "updated_at", type: "integer", sqlType: "integer", notNull: true },
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
    { name: "org_compute_credentials", fields: [{ name: "org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } }, { name: "provider", type: "text", sqlType: "text", notNull: true, check: "provider IN ('hetzner', 'aws')" }, { name: "ciphertext", type: "text", sqlType: "text", notNull: true }, { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "validated_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "identity", unique: true, fields: ["org_id", "provider"] }], extensions: [DENY_ALL_RULES] },
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
    { name: "agent_rules", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } }, { name: "name", type: "text", sqlType: "text", notNull: true }, { name: "content", type: "text", sqlType: "text", notNull: true }, { name: "updated_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "identity", unique: true, fields: ["org_id", "name"] }], extensions: [DENY_ALL_RULES] },
    {
      // Configuration only. Every VM column moved to `machines`, the sharing
      // ACL to `workspace_members`, and the plaintext environment to
      // `workspace_credentials` (plans/MEMBER-MACHINES.md §1).
      name: "workspaces",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "owner_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } },
        { name: "default_machine_type_id", type: "text", sqlType: "text", notNull: true, default: { l: "unknown" } },
        { name: "auto_provision", type: "bool", sqlType: "integer", notNull: true, default: { l: 1 }, check: "auto_provision IN (0, 1)" },
        { name: "deleted_at", type: "integer", sqlType: "integer" },
        { name: "revision", type: "integer", sqlType: "integer", notNull: true, check: "revision > 0" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "updated_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "manifest", type: "text", sqlType: "text" },
        { name: "org_id", type: "text", sqlType: "text", foreignKey: { table: "orgs", column: "id" } }, { name: "owner_membership_id", type: "text", sqlType: "text", foreignKey: { table: "memberships", column: "id" } },
        { name: "files_ready", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "files_ready IN (0, 1)" },
        { name: "agent_rule_id", type: "text", sqlType: "text", foreignKey: { table: "agent_rules", column: "id", onDelete: "SET NULL" } },
        // Forward reference: recipes is created later in this list; SQLite
        // defers FK resolution to DML.
        { name: "recipe_id", type: "text", sqlType: "text", foreignKey: { table: "recipes", column: "id" } },
      ],
      indexes: [{ name: "owner", fields: ["owner_id", "created_at"] }, { name: "org", fields: ["org_id", "created_at"] }],
      extensions: [DENY_ALL_RULES],
    },
    // One VM per (workspace, member). The volume is the durable half: a type
    // change destroys the VM and keeps the disk.
    { name: "machines", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } }, { name: "membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('provisioning', 'running', 'stopped', 'error', 'destroying', 'destroyed')" }, { name: "machine_type_id", type: "text", sqlType: "text", notNull: true }, { name: "compute_credential_source", type: "text", sqlType: "text", notNull: true, default: { l: "deployment" }, check: "compute_credential_source IN ('org', 'deployment')" }, { name: "vm_id", type: "text", sqlType: "text" }, { name: "volume_id", type: "text", sqlType: "text" }, { name: "ssh_host", type: "text", sqlType: "text" }, { name: "ssh_port", type: "integer", sqlType: "integer" }, { name: "ssh_user", type: "text", sqlType: "text" }, { name: "ssh_host_public_key", type: "text", sqlType: "text" }, { name: "phone_home_hash", type: "text", sqlType: "text" }, { name: "phone_home_used", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "phone_home_used IN (0, 1)" }, { name: "tunnel_id", type: "text", sqlType: "text" }, { name: "tunnel_hostname", type: "text", sqlType: "text" }, { name: "dns_record_id", type: "text", sqlType: "text" }, { name: "broker_box_id", type: "text", sqlType: "text", foreignKey: { table: "broker_boxes", column: "box_id", onDelete: "SET NULL" } }, { name: "box_update_requested", type: "bool", sqlType: "integer", notNull: true, default: { l: 0 }, check: "box_update_requested IN (0, 1)" }, { name: "box_image_reported", type: "text", sqlType: "text" }, { name: "disk_used_percent", type: "integer", sqlType: "integer", check: "disk_used_percent IS NULL OR (disk_used_percent BETWEEN 0 AND 100)" }, { name: "disk_reported_at", type: "integer", sqlType: "integer" }, { name: "error", type: "text", sqlType: "text" }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "updated_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "identity", unique: true, fields: ["workspace_id", "membership_id"] }, { name: "workspace", fields: ["workspace_id", "created_at"] }, { name: "state", fields: ["state", "updated_at"] }], extensions: [DENY_ALL_RULES] },
    { name: "workspace_members", fields: [{ name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } }, { name: "membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "role", type: "text", sqlType: "text", notNull: true, check: "role IN ('admin', 'member', 'viewer')" }, { name: "added_by_membership_id", type: "text", sqlType: "text", foreignKey: { table: "memberships", column: "id" } }, { name: "added_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "identity", unique: true, fields: ["workspace_id", "membership_id"] }, { name: "membership", fields: ["membership_id", "workspace_id"] }], extensions: [DENY_ALL_RULES] },
    { name: "workspace_credentials", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } }, { name: "name", type: "text", sqlType: "text", notNull: true }, { name: "label", type: "text", sqlType: "text" }, { name: "ciphertext", type: "text", sqlType: "text", notNull: true }, { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "updated_at", type: "integer", sqlType: "integer", notNull: true }, { name: "revoked_at", type: "integer", sqlType: "integer" }], indexes: [{ name: "workspace", fields: ["workspace_id", "created_at"] }], extensions: [DENY_ALL_RULES] },
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
        { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "compute_credential_source", type: "text", sqlType: "text", check: "compute_credential_source IN ('org', 'deployment')" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    { name: "folders", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } }, { name: "name", type: "text", sqlType: "text", notNull: true }, { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "updated_at", type: "integer", sqlType: "integer", notNull: true }, { name: "org_role", type: "text", sqlType: "text", check: "org_role IN ('editor', 'viewer')" }], indexes: [{ name: "org", fields: ["org_id", "created_at"] }], extensions: [DENY_ALL_RULES] },
    { name: "folder_grants", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "folder_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "folders", column: "id" } }, { name: "membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "role", type: "text", sqlType: "text", notNull: true, check: "role IN ('editor', 'viewer')" }, { name: "granted_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "identity", unique: true, fields: ["folder_id", "membership_id"] }, { name: "membership", fields: ["membership_id", "folder_id"] }], extensions: [DENY_ALL_RULES] },
    { name: "folder_attachments", fields: [{ name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } }, { name: "folder_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "folders", column: "id" } }, { name: "attached_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "guest_path", type: "text", sqlType: "text" }], indexes: [{ name: "identity", unique: true, fields: ["workspace_id", "folder_id"] }, { name: "folder", fields: ["folder_id", "workspace_id"] }], extensions: [DENY_ALL_RULES] },
    // Flat like agent_rules/broker_members: this file already sits on the
    // max-lines warn list, so a new table stays terse instead of growing it.
    { name: "recipes", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "org_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "orgs", column: "id" } }, { name: "name", type: "text", sqlType: "text", notNull: true }, { name: "source_workspace_id", type: "text", sqlType: "text", foreignKey: { table: "workspaces", column: "id" } }, { name: "harness", type: "text", sqlType: "text", notNull: true, check: "harness IN ('claude', 'codex', 'chat')" }, { name: "model", type: "text", sqlType: "text" }, { name: "effort", type: "text", sqlType: "text" }, { name: "prompt", type: "text", sqlType: "text", notNull: true }, { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "updated_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "org", fields: ["org_id", "created_at"] }, { name: "source_workspace", fields: "source_workspace_id" }], extensions: [DENY_ALL_RULES] },
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
    // The workspace guest's credential. `box_token_families` above is what is
    // left of the old table: brokers and device-code enrolments.
    { name: "machine_token_families", fields: [{ name: "machine_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "machines", column: "id", onDelete: "CASCADE" } }, { name: "vm_id", type: "text", sqlType: "text" }, { name: "access_hash", type: "text", sqlType: "text", notNull: true, unique: true }, { name: "refresh_hash", type: "text", sqlType: "text", notNull: true, unique: true }, { name: "previous_refresh_hash", type: "text", sqlType: "text" }, { name: "previous_rotated_at", type: "integer", sqlType: "integer" }, { name: "access_issued_at", type: "integer", sqlType: "integer", notNull: true }, { name: "generation", type: "integer", sqlType: "integer", notNull: true }], indexes: [], extensions: [DENY_ALL_RULES] },
    {
      name: "broker_boxes",
      fields: [
        { name: "box_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "boxes", column: "id", onDelete: "CASCADE" } },
        { name: "host", type: "text", sqlType: "text", notNull: true },
        { name: "port", type: "integer", sqlType: "integer", notNull: true },
        { name: "ssh_host_public_key", type: "text", sqlType: "text", notNull: true },
        { name: "member_cap", type: "integer", sqlType: "integer", notNull: true, default: { l: 25 }, check: "member_cap > 0" },
      ],
      extensions: [DENY_ALL_RULES],
    },
    {
      name: "broker_keys",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "machine_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "machines", column: "id", onDelete: "CASCADE" } },
        { name: "pubkey", type: "text", sqlType: "text", notNull: true },
        { name: "operation", type: "text", sqlType: "text", notNull: true, check: "operation IN ('mint', 'deposit')" },
      ],
      indexes: [
        { name: "machine", fields: "machine_id" },
        { name: "identity", unique: true, fields: ["machine_id", "pubkey", "operation"] },
      ],
      extensions: [DENY_ALL_RULES],
    },
    // Written flat, unlike its neighbours: this file is 13 lines under the
    // 700-line max-lines warn and the expanded form crosses it. CLAUDE.md's
    // drift runbook reads that warn list as a ratchet, so a new table pays for
    // its own room here rather than growing the list.
    { name: "broker_members", fields: [{ name: "principal_id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid", foreignKey: { table: "principals", column: "id", onDelete: "CASCADE" } }, { name: "broker_box_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "broker_boxes", column: "box_id", onDelete: "CASCADE" } }, { name: "unix_name", type: "text", sqlType: "text", notNull: true }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }], indexes: [{ name: "box", fields: "broker_box_id" }, { name: "identity", unique: true, fields: ["broker_box_id", "unix_name"] }], extensions: [DENY_ALL_RULES] },
    {
      name: "connections",
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
    { name: "user_oauth_grants", fields: [{ name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" }, { name: "user_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "principals", column: "id" } }, { name: "provider", type: "text", sqlType: "text", notNull: true }, { name: "manifest_id", type: "text", sqlType: "text", notNull: true }, { name: "kind", type: "text", sqlType: "text", notNull: true, check: "kind IN ('pat','oauth')" }, { name: "label", type: "text", sqlType: "text" }, { name: "config", type: "text", sqlType: "text", notNull: true, default: { l: "{}" } }, { name: "access_ciphertext", type: "text", sqlType: "text" }, { name: "access_expires_at", type: "integer", sqlType: "integer" }, { name: "refresh_ciphertext", type: "text", sqlType: "text" }, { name: "scopes", type: "text", sqlType: "text", notNull: true }, { name: "rotation", type: "integer", sqlType: "integer", notNull: true, default: { l: 0 } }, { name: "created_at", type: "integer", sqlType: "integer", notNull: true }, { name: "updated_at", type: "integer", sqlType: "integer", notNull: true }, { name: "revoked_at", type: "integer", sqlType: "integer" }], indexes: [{ name: "live", unique: true, fields: ["user_id", "provider"], where: { q: "revoked_at IS NULL" } }, { name: "provider", fields: ["provider", "user_id"] }], extensions: [DENY_ALL_RULES] },
    { name: "provider_health", fields: [{ name: "provider", type: "text", sqlType: "text", primary: true, noUpdate: true }, { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('healthy','unhealthy')" }, { name: "detail", type: "text", sqlType: "text" }, { name: "checked_at", type: "integer", sqlType: "integer", notNull: true }, { name: "latency_ms", type: "integer", sqlType: "integer" }], indexes: [], extensions: [DENY_ALL_RULES] },
    {
      name: "credential_leases",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "workspace_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "workspaces", column: "id" } },
        { name: "box_id", type: "text", sqlType: "text", foreignKey: { table: "boxes", column: "id", onDelete: "SET NULL" } },
        { name: "machine_id", type: "text", sqlType: "text", foreignKey: { table: "machines", column: "id" } },
        { name: "connection_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "connections", column: "id" } },
        { name: "user_id", type: "text", sqlType: "text" },
        { name: "grant_id", type: "text", sqlType: "text", foreignKey: { table: "user_oauth_grants", column: "id" } },
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
        { name: "grant", fields: ["grant_id", "state"] },
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
        { name: "connection_name", type: "text", sqlType: "text", notNull: true },
        { name: "requested_scopes", type: "text", sqlType: "text", notNull: true },
        { name: "state", type: "text", sqlType: "text", notNull: true, check: "state IN ('pending','approved','denied')" },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "resolved_at", type: "integer", sqlType: "integer" },
        { name: "resolved_by", type: "text", sqlType: "text" },
        { name: "requester", type: "text", sqlType: "text" },
      ],
      indexes: [
        { name: "pending", fields: ["state", "created_at"] },
        { name: "dedup", unique: true, fields: ["workspace_id", "connection_name", "requested_scopes"], where: { q: "state = 'pending'" } },
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
      // Mirrors migration 0034. Only the SHA-256 of an operator token is
      // stored; the plaintext exists once, in the mint response.
      name: "operator_tokens",
      fields: [
        { name: "id", type: "text", sqlType: "text", primary: true, noUpdate: true, usage: "record_uid" },
        { name: "label", type: "text", sqlType: "text", notNull: true },
        { name: "token_hash", type: "text", sqlType: "text", notNull: true, unique: true },
        { name: "created_by_membership_id", type: "text", sqlType: "text", notNull: true, foreignKey: { table: "memberships", column: "id" } },
        { name: "created_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "last_used_at", type: "integer", sqlType: "integer" },
        { name: "expires_at", type: "integer", sqlType: "integer", notNull: true },
        { name: "revoked_at", type: "integer", sqlType: "integer" },
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

// Root-level `auth: false` relinquishes teenybase's framework auth table: this
// schema ships blitz-core's own `users` table, and the platform's auth-less
// validation requires the flag (teenybase PR #13 added `auth?: boolean` to
// DatabaseSettings). It is emitted into this template string instead of being
// carried on BLITZDEV_CONFIG because the pinned local teenybase 0.0.14 predates
// the field: its `DatabaseSettings` has no `auth`, and `databaseSettingsSchema`
// is a plain `z.object` that strips unknown keys, so BLITZDEV_CONFIG would stop
// round-tripping through the installed validator. Types do not apply inside the
// template; the platform typechecks the emitted file against its own teenybase.
export const TEENYBASE_SOURCE = normalizeSource(`import type { DatabaseSettings, TableRulesExtensionData } from "teenybase";

const denyAllRules: TableRulesExtensionData = ${tsValue({ ...DENY_ALL_RULES })};

const config = ${tsValue({ auth: false, ...BLITZDEV_CONFIG })} satisfies DatabaseSettings;

export default config;
`);

/**
 * The managed Worker's entry module.
 *
 * The routing arrays are an argument rather than a constant because they are
 * derived from the core sources being uploaded — see managedApiRouting below.
 *
 * @param {{exactPaths: readonly string[], prefixes: readonly string[]}} routing
 *   paths the Worker answers instead of the stored webApp assets
 * @returns {string} the emitted worker.ts source
 */
export function workerSource(routing) {
  return normalizeSource(`import { $Database, $DatabaseRawImpl, teenyHono } from "teenybase";
import config from "virtual:teenybase";
import {
  cloudWorkspaceCredentialPolicyFromEnv,
  credentialMasterKeyFor,
  createSessionPrincipalSource,
  installControlPlaneRoutes,
  isString,
  MicrovmPoolProvider,
  maybeScheduleLazySweep,
  OrgComputeProviderResolver,
  runFileSyncSweep, runInvariantSweep, runLeaseSweep, runOrphanSweep,
  runProviderCanary, runSessionSweep, runWorkspaceTunnelSweep,
  sessionTtlMsFromEnv,
  workspaceTunnelsFromEnv,
  workspaceWebAppAuthFromEnv,
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
  OPERATOR_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BOX_IMAGE_REF: string;
  BOX_IMAGE_SHA256: string;
  BOX_IMAGE_TAG: string;
  SESSION_TTL_DAYS: string;
  MICROVM_HOSTS: string;
  CLOUD_WORKSPACE_CREDENTIAL_POLICY?: string;
  CRED_MASTER_KEY: string;
  // Workspace tunnels and webApp auth, named exactly as self-host names them
  // (docs/TUNNEL.md, docs/SELF-HOST.md): one documented set for both targets.
  // The first three are project vars, the last two project secrets. Leave any
  // of them empty and cloud-VM workspaces still boot, but they get no browser
  // terminal, chat, files, or previews.
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
  WORKSPACE_TUNNEL_ZONE?: string;
  CLOUDFLARE_API_TOKEN?: string;
  WEBAPP_TOKEN_SECRET?: string;
  AWS_ACCESS_KEY_ID?: string; AWS_SECRET_ACCESS_KEY?: string; AWS_SESSION_TOKEN?: string;
  AWS_REGION?: string; AWS_IMAGE_ID?: string; AWS_SUBNET_ID?: string; AWS_SECURITY_GROUP_IDS?: string;
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

function nonEmptyString(value: unknown): string | undefined {
  return isString(value) && value.length > 0 ? value : undefined;
}

function providersFor(
  env: ManagedBindings,
  db: Db,
  credentialMasterKey: CryptoKey,
  workspaceCredentialPolicy: CoreRuntime["vars"]["cloudWorkspaceCredentialPolicy"],
): CoreRuntime["providers"] {
  const compute = new OrgComputeProviderResolver(db, credentialMasterKey, env, {
    workspaceCredentialPolicy,
  });
  const microvm = new MicrovmPoolProvider(
    env.MICROVM_HOSTS,
    (tokenVar) => dynamicBinding(env, tokenVar),
    { db },
  );
  return {
    vmRegistry: new VmProviderRegistry(
      [...compute.descriptors(), microvm],
      async (provider, orgId, requiredSource) => compute.handles(provider.id)
        ? compute.resolve(provider.id, orgId, requiredSource)
        : null,
    ),
    volume: { forOrg: (orgId, requiredSource) => compute.resolveVolume(orgId, requiredSource) },
    compute,
    microvm,
    workspaceTunnels: workspaceTunnelsFromEnv(env),
    webAppAuth: workspaceWebAppAuthFromEnv(env),
  };
}

let checkedWorkspaceTunnelsConfig = false;

// Cloud-VM providers have no proxyWebApp of their own: without configured
// workspace tunnels their workspaces boot with no browser access at all, and
// the terminal route can only answer 503. Say which names are missing, once
// per isolate, so the cause is in the logs instead of in a browser.
function warnOnceIfWorkspaceTunnelsUnconfigured(runtime: CoreRuntime): void {
  if (checkedWorkspaceTunnelsConfig) return;
  checkedWorkspaceTunnelsConfig = true;
  if (runtime.providers.workspaceTunnels !== undefined) return;
  const blindProviderIds = runtime.providers.vmRegistry
    .all()
    .filter((provider) => provider.proxyWebApp === undefined)
    .map((provider) => provider.id);
  if (blindProviderIds.length === 0) return;
  runtime.reportError(
    "workspace_tunnels_unconfigured",
    new Error(
      "workspace tunnels are not configured (set WORKSPACE_TUNNEL_ZONE, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID vars"
      + " and the CLOUDFLARE_API_TOKEN, WEBAPP_TOKEN_SECRET secrets); workspaces from providers without proxyWebApp"
      + " have no browser access: " + blindProviderIds.join(", "),
    ),
  );
}

// Generated from the core route registrations by scripts/lib/worker-first-routes.mjs.
// API_EXACT_PATHS holds the routes that are a whole path — the marketing home
// "/" among them, which must never become a prefix here: startsWith("/") is
// true of every request in the deployment.
const API_EXACT_PATHS = ${JSON.stringify(routing.exactPaths, null, 2)};
const API_PREFIXES = ${JSON.stringify(routing.prefixes, null, 2)};

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
  return API_EXACT_PATHS.includes(pathname) || API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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
  const cloudWorkspaceCredentialPolicy = cloudWorkspaceCredentialPolicyFromEnv(
    env.CLOUD_WORKSPACE_CREDENTIAL_POLICY,
  );
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
      googleClientId: env.GOOGLE_CLIENT_ID,
      googleClientSecret: env.GOOGLE_CLIENT_SECRET,
      bootstrapSecret: env.OPERATOR_API_KEY,
      cloudWorkspaceCredentialPolicy,
      connectSecret: (name) => nonEmptyString(dynamicBinding(env, name)),
    },
    providers: providersFor(
      env,
      db,
      context.get("$credentialMasterKey") as CryptoKey,
      cloudWorkspaceCredentialPolicy,
    ),
    principalSource: createSessionPrincipalSource(),
    // SAFETY: Both routed context variants satisfy the webApp blob response contract used for the SPA shell.
    assets: { fetch: async () => webAppResponse(context as WebAppContext, "/index.html") },
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
    warnOnceIfWorkspaceTunnelsUnconfigured(runtime);
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
      await runWorkspaceTunnelSweep(runtime); await runProviderCanary(runtime);
      await runFileSyncSweep(runtime);
    })());
  },
});
export default worker;
`);
}

/**
 * The managed Worker's routing arrays, derived from the sources it ships.
 *
 * Reading them off the very files being uploaded keeps the managed Worker and
 * the standalone Worker's assets.run_worker_first answering the same question
 * from the same place, with no second list to forget.
 *
 * @param {Map<string, string>} coreSources upload path -> source text
 * @returns {{exactPaths: string[], prefixes: string[]}} exact paths and startsWith prefixes
 */
export function managedApiRouting(coreSources) {
  const sources = [...coreSources].map(([sourcePath, source]) => ({ path: sourcePath, source }));
  const { paths, nonLiteral } = coreRoutePaths(sources);
  if (nonLiteral.length > 0) {
    throw new Error(
      `core route paths must be string literals; ${nonLiteral[0].path} hides at least one from the scan`,
    );
  }
  const routePaths = [...paths, ...FRAMEWORK_ROUTE_PATHS];
  return { exactPaths: managedApiExactPaths(routePaths), prefixes: managedApiPrefixes(routePaths) };
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
    // The platform Loader does not map an explicit `./x.js` onto the `x.ts`
    // it was handed; it externalizes the import and the Worker throws at
    // runtime with bundle.ok still true. Nothing loader-unsafe leaves here.
    const suffixed = imports.filter(({ specifier }) => isRelative(specifier) && hasRuntimeExtension(specifier));
    if (suffixed.length > 0) throw new Error(`${entry.path} keeps a loader-unsafe specifier ${suffixed[0].specifier}`);
  }
  assertClosedUploadSet(entries);
}

/** The specifier an emitted file uses to reach a generated text-asset module. */
function assetSpecifier(importerPath, uploadPath) {
  const relative = path.posix.relative(path.posix.dirname(importerPath), uploadPath).replace(/\.ts$/u, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function textAssetModule(asset, text) {
  return `// Generated by scripts/build-blitzdev.mjs from ${asset.sourcePath}.\n`
    + "// The box-image skeleton is the source of truth; never edit this copy.\n"
    + `const doc: string = ${JSON.stringify(text)};\n\nexport default doc;\n`;
}

/**
 * Repoints text-asset imports at their generated module and drops NodeNext
 * runtime extensions. Repo sources stay NodeNext-correct; only the uploaded
 * copies are normalized.
 */
function emitSource(uploadPath, source) {
  return normalizeSource(rewriteSpecifiers(source, (specifier) => {
    const asset = TEXT_ASSETS.find((candidate) => candidate.specifier === specifier);
    return asset === undefined ? loaderSpecifier(specifier) : assetSpecifier(uploadPath, asset.uploadPath);
  }));
}

export function createUploadSet(coreSources, textAssets) {
  const entries = [
    { path: "teenybase.ts", source: emitSource("teenybase.ts", TEENYBASE_SOURCE) },
    { path: "worker.ts", source: emitSource("worker.ts", workerSource(managedApiRouting(coreSources))) },
    ...CORE_MANIFEST.map((uploadPath) => {
      const source = coreSources.get(uploadPath);
      if (source === undefined) throw new Error(`missing source for ${uploadPath}`);
      return { path: uploadPath, source: emitSource(uploadPath, source) };
    }),
    ...TEXT_ASSETS.map((asset) => {
      const text = textAssets?.get(asset.uploadPath);
      if (text === undefined) throw new Error(`missing text asset ${asset.uploadPath} (${asset.sourcePath})`);
      return { path: asset.uploadPath, source: normalizeSource(textAssetModule(asset, text)) };
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

export async function readTextAssets(packageDir = PACKAGE_DIR) {
  const entries = await Promise.all(TEXT_ASSETS.map(async (asset) => [
    asset.uploadPath,
    await readFile(path.join(packageDir, asset.sourcePath), "utf8"),
  ]));
  return new Map(entries);
}

export async function emitUploadSet({ packageDir = PACKAGE_DIR, distDir = DEFAULT_DIST_DIR } = {}) {
  const uploadSet = createUploadSet(await readCoreSources(packageDir), await readTextAssets(packageDir));
  await rm(distDir, { recursive: true, force: true });
  for (const file of uploadSet.files) {
    const destination = path.join(distDir, file.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.source, "utf8");
  }
  return { ...uploadSet, distDir };
}
