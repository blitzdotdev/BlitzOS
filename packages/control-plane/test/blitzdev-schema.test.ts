import { env } from "cloudflare:test";
import { databaseSettingsSchema, generateMigrations } from "teenybase";
import { describe, expect, it } from "vitest";
import {
  BLITZDEV_CONFIG,
  DENY_ALL_RULES,
  TEENYBASE_SOURCE,
} from "../scripts/build-blitzdev.mjs";

// Vendor-only: this suite pins the teenybase schema for the blitz.dev managed
// deployment, which forks do not use. Skipped unless BLITZDEV_MANAGED=1.
const managedToolchainEnabled = env.BLITZDEV_MANAGED === "1";

const expectedTables = [
  "principals",
  "users",
  "orgs",
  "org_entitlements",
  "memberships",
  "org_compute_credentials",
  "sessions",
  "agent_rules",
  "workspaces",
  "machines",
  "workspace_members",
  "workspace_credentials",
  "invites",
  "volume_ownership",
  "folders",
  "folder_grants",
  "folder_attachments",
  "recipes",
  "webapp_state",
  "workspace_sessions",
  "workspace_member_views",
  "presence_connections",
  "device_authorizations",
  "boxes",
  "box_token_families",
  "machine_token_families",
  "broker_boxes",
  "broker_keys",
  "broker_members",
  "connections",
  "user_oauth_grants",
  "provider_health",
  "credential_leases",
  "credential_events",
  "credential_requests",
  "microvm_hosts",
  "operator_tokens",
  "blitz_files",
] as const;

describe.skipIf(!managedToolchainEnabled)("blitz.dev managed schema [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
  it("parses as TypeScript and passes teenybase's installed config validator", () => {
    expect(TEENYBASE_SOURCE).toMatch(/^import type \{ DatabaseSettings, TableRulesExtensionData \} from "teenybase";/u);
    expect(TEENYBASE_SOURCE).toContain("satisfies DatabaseSettings;");
    expect(databaseSettingsSchema.parse(BLITZDEV_CONFIG)).toEqual(BLITZDEV_CONFIG);
    expect(BLITZDEV_CONFIG.appUrl).toBe("$APP_URL");
  });

  it("emits a root-level auth:false because this schema ships its own users table", () => {
    expect(TEENYBASE_SOURCE).toContain("const config = {\n  auth: false,\n");
    expect(expectedTables).toContain("users");
    // The pinned teenybase 0.0.14 predates the root-level `auth` flag, so it is
    // emitted into the source string only and BLITZDEV_CONFIG still round-trips
    // through the installed validator (a z.object that strips unknown keys).
    expect(BLITZDEV_CONFIG).not.toHaveProperty("auth");
    expect(databaseSettingsSchema.parse(BLITZDEV_CONFIG)).toEqual(BLITZDEV_CONFIG);
  });

  it("contains the thirty-seven domain tables plus the deny-all file support table", () => {
    expect(BLITZDEV_CONFIG.tables.map((table) => table.name)).toEqual(expectedTables);
    expect(BLITZDEV_CONFIG.tables).toHaveLength(38);
    for (const table of BLITZDEV_CONFIG.tables) {
      expect(table.extensions).toEqual([DENY_ALL_RULES]);
    }
    expect(BLITZDEV_CONFIG.tables.at(-1)).toMatchObject({
      name: "blitz_files",
      r2Base: "blitz-files",
      autoDeleteR2Files: false,
      allowMultipleFileRef: true,
      fields: expect.arrayContaining([expect.objectContaining({ name: "object", type: "file" })]),
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "sessions")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "expires_at",
          type: "integer",
          sqlType: "integer",
          notNull: true,
          default: { l: 0 },
        }),
        expect.objectContaining({
          name: "membership_id",
          foreignKey: { table: "memberships", column: "id" },
        }),
      ]),
      indexes: [{ name: "expires_at", fields: "expires_at" }],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "workspaces")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "default_machine_type_id",
          notNull: true,
          default: { l: "unknown" },
        }),
        expect.objectContaining({
          name: "auto_provision",
          type: "bool",
          default: { l: 1 },
          check: "auto_provision IN (0, 1)",
        }),
        expect.objectContaining({ name: "deleted_at", type: "integer" }),
        expect.objectContaining({
          name: "org_id",
          foreignKey: { table: "orgs", column: "id" },
        }),
        expect.objectContaining({
          name: "owner_membership_id",
          foreignKey: { table: "memberships", column: "id" },
        }),
        expect.objectContaining({
          name: "files_ready",
          type: "bool",
          default: { l: 0 },
          check: "files_ready IN (0, 1)",
        }),
        expect.objectContaining({
          name: "agent_rule_id",
          foreignKey: { table: "agent_rules", column: "id", onDelete: "SET NULL" },
        }),
        expect.objectContaining({
          name: "recipe_id",
          foreignKey: { table: "recipes", column: "id" },
        }),
      ]),
    });
    // The VM columns the workspace shed. One machine per (workspace, member),
    // and the pair is unique (plans/MEMBER-MACHINES.md §1).
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "machines")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "workspace_id",
          notNull: true,
          foreignKey: { table: "workspaces", column: "id" },
        }),
        expect.objectContaining({
          name: "membership_id",
          notNull: true,
          foreignKey: { table: "memberships", column: "id" },
        }),
        expect.objectContaining({
          name: "state",
          notNull: true,
          check: "state IN ('provisioning', 'running', 'stopped', 'error', 'destroying', 'destroyed')",
        }),
        expect.objectContaining({ name: "machine_type_id", notNull: true }),
        expect.objectContaining({
          name: "compute_credential_source",
          notNull: true,
          check: "compute_credential_source IN ('org', 'deployment')",
        }),
        expect.objectContaining({ name: "vm_id", type: "text" }),
        expect.objectContaining({ name: "volume_id", type: "text" }),
        expect.objectContaining({ name: "phone_home_hash", type: "text" }),
        expect.objectContaining({ name: "tunnel_hostname", type: "text" }),
      ]),
      indexes: expect.arrayContaining([
        { name: "identity", unique: true, fields: ["workspace_id", "membership_id"] },
      ]),
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "workspace_members")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "role",
          notNull: true,
          check: "role IN ('admin', 'member', 'viewer')",
        }),
      ]),
      indexes: expect.arrayContaining([
        { name: "identity", unique: true, fields: ["workspace_id", "membership_id"] },
      ]),
    });
    // Sealed values only: the ciphertext column is NOT NULL and nothing here
    // stores a plaintext value.
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "workspace_credentials")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "name", notNull: true }),
        expect.objectContaining({ name: "ciphertext", notNull: true }),
        expect.objectContaining({ name: "revoked_at", type: "integer" }),
      ]),
    });
    // The machine's own credential. `box_token_families` beside it is what is
    // left of the old table: brokers and device-code enrolments.
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "machine_token_families")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "machine_id",
          primary: true,
          foreignKey: { table: "machines", column: "id", onDelete: "CASCADE" },
        }),
        expect.objectContaining({ name: "vm_id", type: "text" }),
        expect.objectContaining({ name: "access_hash", notNull: true, unique: true }),
      ]),
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "org_compute_credentials")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "org_id", foreignKey: { table: "orgs", column: "id" } }),
        expect.objectContaining({ name: "provider", check: "provider IN ('hetzner', 'aws')" }),
        expect.objectContaining({ name: "ciphertext", notNull: true }),
        expect.objectContaining({
          name: "created_by_membership_id",
          foreignKey: { table: "memberships", column: "id" },
        }),
        expect.objectContaining({ name: "validated_at", notNull: true }),
      ]),
      indexes: [{ name: "identity", unique: true, fields: ["org_id", "provider"] }],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "orgs")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "usage_capture",
          type: "bool",
          default: { l: 0 },
          check: "usage_capture IN (0, 1)",
        }),
        // No folders foreignKey on purpose: a dangling usage_folder_id is
        // tolerated (the usage-push leg inner-joins folders).
        expect.objectContaining({ name: "usage_folder_id", type: "text", sqlType: "text" }),
      ]),
    });
    expect(
      BLITZDEV_CONFIG.tables
        .find(({ name }) => name === "orgs")
        ?.fields.find(({ name }) => name === "usage_folder_id"),
    ).not.toHaveProperty("foreignKey");
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "recipes")).toMatchObject({
      fields: [
        expect.objectContaining({ name: "id", primary: true }),
        expect.objectContaining({
          name: "org_id",
          notNull: true,
          foreignKey: { table: "orgs", column: "id" },
        }),
        expect.objectContaining({ name: "name", notNull: true }),
        expect.objectContaining({
          name: "source_workspace_id",
          foreignKey: { table: "workspaces", column: "id" },
        }),
        expect.objectContaining({
          name: "harness",
          check: "harness IN ('claude', 'codex', 'chat')",
        }),
        expect.objectContaining({ name: "model", type: "text" }),
        expect.objectContaining({ name: "effort", type: "text" }),
        expect.objectContaining({ name: "prompt", notNull: true }),
        expect.objectContaining({
          name: "created_by_membership_id",
          foreignKey: { table: "memberships", column: "id" },
        }),
        expect.objectContaining({ name: "created_at", type: "integer", notNull: true }),
        expect.objectContaining({ name: "updated_at", type: "integer", notNull: true }),
      ],
      indexes: [
        { name: "org", fields: ["org_id", "created_at"] },
        { name: "source_workspace", fields: "source_workspace_id" },
      ],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "agent_rules")).toMatchObject({
      fields: [
        expect.objectContaining({ name: "id", primary: true }),
        expect.objectContaining({
          name: "org_id",
          notNull: true,
          foreignKey: { table: "orgs", column: "id" },
        }),
        expect.objectContaining({ name: "name", notNull: true }),
        expect.objectContaining({ name: "content", notNull: true }),
        expect.objectContaining({ name: "updated_at", type: "integer", notNull: true }),
      ],
      indexes: [{ name: "identity", unique: true, fields: ["org_id", "name"] }],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "users")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "google_user_id", notNull: true, unique: true }),
        expect.objectContaining({ name: "email", unique: true, check: "email = lower(email)" }),
        expect.objectContaining({
          name: "platform_operator",
          check: "platform_operator IN (0, 1)",
        }),
      ]),
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "memberships")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "role", check: "role IN ('admin', 'member')" }),
        expect.objectContaining({
          name: "status",
          check: "status IN ('invited', 'active', 'disabled')",
        }),
      ]),
      indexes: [{ name: "identity", unique: true, fields: ["user_id", "org_id"] }],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "invites")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "code_hash", check: "length(code_hash) = 43" }),
        expect.objectContaining({
          name: "state",
          check: "state IN ('ready', 'redeemed', 'revoked', 'expired')",
        }),
      ]),
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "folders")).toMatchObject({
      fields: [
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "org_id" }),
        expect.objectContaining({ name: "name" }),
        expect.objectContaining({ name: "created_by_membership_id" }),
        expect.objectContaining({ name: "created_at" }),
        expect.objectContaining({ name: "updated_at" }),
        expect.objectContaining({ name: "org_role", check: "org_role IN ('editor', 'viewer')" }),
      ],
      indexes: [{ name: "org", fields: ["org_id", "created_at"] }],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "workspace_sessions")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "created_by_membership_id",
          foreignKey: { table: "memberships", column: "id", onDelete: "SET NULL" },
        }),
      ]),
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "folder_grants")).toMatchObject({
      fields: [
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "folder_id" }),
        expect.objectContaining({ name: "membership_id" }),
        expect.objectContaining({ name: "role", check: "role IN ('editor', 'viewer')" }),
        expect.objectContaining({ name: "granted_by_membership_id" }),
        expect.objectContaining({ name: "created_at" }),
      ],
      indexes: [
        { name: "identity", unique: true, fields: ["folder_id", "membership_id"] },
        { name: "membership", fields: ["membership_id", "folder_id"] },
      ],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "folder_attachments")).toMatchObject({
      fields: [
        expect.objectContaining({ name: "workspace_id" }),
        expect.objectContaining({ name: "folder_id" }),
        expect.objectContaining({ name: "attached_by_membership_id" }),
        expect.objectContaining({ name: "created_at" }),
        expect.objectContaining({ name: "guest_path" }),
      ],
      indexes: [
        { name: "identity", unique: true, fields: ["workspace_id", "folder_id"] },
        { name: "folder", fields: ["folder_id", "workspace_id"] },
      ],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "webapp_state")).toMatchObject({
      fields: [
        expect.objectContaining({ name: "principal_id" }),
        expect.objectContaining({ name: "workspace_id" }),
        expect.objectContaining({ name: "doc", type: "json" }),
        expect.objectContaining({ name: "updated_at" }),
      ],
      indexes: [{
        name: "identity",
        unique: true,
        fields: ["principal_id", "workspace_id"],
      }],
    });
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "microvm_hosts")).toMatchObject({
      fields: [
        expect.objectContaining({ name: "name", primary: true }),
        expect.objectContaining({ name: "url", sqlType: "text" }),
        expect.objectContaining({ name: "updated_at", sqlType: "integer" }),
        expect.objectContaining({
          name: "source",
          check: "source IN ('static', 'registered')",
        }),
      ],
    });
    expect(
      BLITZDEV_CONFIG.tables.find(({ name }) => name === "credential_leases"),
    ).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({
          name: "box_id",
          foreignKey: { table: "boxes", column: "id", onDelete: "SET NULL" },
        }),
        expect.objectContaining({ name: "token_hash", unique: true }),
      ]),
    });
    expect(
      BLITZDEV_CONFIG.tables.find(({ name }) => name === "credential_requests"),
    ).toMatchObject({
      fields: expect.arrayContaining([expect.objectContaining({ name: "requester" })]),
    });
  });

  it("generates only the expected table and index creates from an empty schema", () => {
    const generated = generateMigrations(BLITZDEV_CONFIG, undefined);
    const sql = generated.migrations.map((migration) => migration.sql).join("\n");
    expect([...sql.matchAll(/CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1])).toEqual(expectedTables);
    expect([...sql.matchAll(/CREATE (?:UNIQUE )?INDEX\s+([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1])).toEqual([
      "idx_memberships_identity",
      "idx_org_compute_credentials_identity",
      "idx_sessions_expires_at",
      "idx_agent_rules_identity",
      "idx_workspaces_owner",
      "idx_workspaces_org",
      "idx_machines_identity",
      "idx_machines_workspace",
      "idx_machines_state",
      "idx_workspace_members_identity",
      "idx_workspace_members_membership",
      "idx_workspace_credentials_workspace",
      "idx_folders_org",
      "idx_folder_grants_identity",
      "idx_folder_grants_membership",
      "idx_folder_attachments_identity",
      "idx_folder_attachments_folder",
      "idx_recipes_org",
      "idx_recipes_source_workspace",
      "idx_webapp_state_identity",
      "idx_workspace_sessions_workspace",
      "idx_workspace_member_views_identity",
      "idx_workspace_member_views_membership",
      "idx_presence_connections_identity",
      "idx_presence_connections_expiry",
      "idx_presence_connections_workspace",
      "idx_boxes_broker",
      "idx_boxes_principal",
      "idx_broker_keys_machine",
      "idx_broker_keys_identity",
      "idx_broker_members_box",
      "idx_broker_members_identity",
      "idx_connections_org_name",
      "idx_connections_org",
      "idx_user_oauth_grants_live",
      "idx_user_oauth_grants_provider",
            "idx_credential_leases_workspace",
      "idx_credential_leases_expiry",
      "idx_credential_leases_token",
      "idx_credential_leases_grant",
      "idx_credential_requests_pending",
      "idx_credential_requests_dedup",
      "idx_blitz_files_logical",
      "idx_blitz_files_release",
    ]);
  });
});
