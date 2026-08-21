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
  "memberships",
  "sessions",
  "agent_rules",
  "workspaces",
  "invites",
  "volume_ownership",
  "workspace_grants",
  "folders",
  "folder_grants",
  "folder_attachments",
  "workspace_templates",
  "workspace_template_folders",
  "recipes",
  "webapp_state",
  "device_authorizations",
  "boxes",
  "box_token_families",
  "broker_boxes",
  "broker_keys",
  "broker_members",
  "connections",
  "user_oauth_grants",
  "workspace_template_connections",
  "provider_health",
  "credential_leases",
  "credential_events",
  "credential_requests",
  "microvm_hosts",
  "blitz_files",
] as const;

describe.skipIf(!managedToolchainEnabled)("blitz.dev managed schema [vendor-only: set BLITZDEV_MANAGED=1 to run]", () => {
  it("parses as TypeScript and passes teenybase's installed config validator", () => {
    expect(TEENYBASE_SOURCE).toMatch(/^import type \{ DatabaseSettings, TableRulesExtensionData \} from "teenybase";/u);
    expect(TEENYBASE_SOURCE).toContain("satisfies DatabaseSettings;");
    expect(databaseSettingsSchema.parse(BLITZDEV_CONFIG)).toEqual(BLITZDEV_CONFIG);
    expect(BLITZDEV_CONFIG.appUrl).toBe("$APP_URL");
  });

  it("contains the thirty-one domain tables plus the deny-all file support table", () => {
    expect(BLITZDEV_CONFIG.tables.map((table) => table.name)).toEqual(expectedTables);
    expect(BLITZDEV_CONFIG.tables).toHaveLength(32);
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
          name: "machine_type_id",
          notNull: true,
          default: { l: "unknown" },
        }),
        expect.objectContaining({
          name: "org_id",
          foreignKey: { table: "orgs", column: "id" },
        }),
        expect.objectContaining({
          name: "owner_membership_id",
          foreignKey: { table: "memberships", column: "id" },
        }),
        expect.objectContaining({ name: "environment", type: "text" }),
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
          name: "template_id",
          notNull: true,
          foreignKey: { table: "workspace_templates", column: "id" },
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
        { name: "template", fields: "template_id" },
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
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "workspace_grants")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "role", check: "role IN ('editor', 'viewer')" }),
      ]),
      indexes: [{
        name: "identity",
        unique: true,
        fields: ["workspace_id", "membership_id"],
      }],
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
    expect(BLITZDEV_CONFIG.tables.find(({ name }) => name === "workspace_templates")).toMatchObject({
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "machine_type_id", notNull: true }),
        expect.objectContaining({ name: "environment", type: "text" }),
        expect.objectContaining({
          name: "agent_rule_id",
          foreignKey: { table: "agent_rules", column: "id", onDelete: "SET NULL" },
        }),
        expect.objectContaining({
          name: "created_by_membership_id",
          foreignKey: { table: "memberships", column: "id" },
        }),
      ]),
      indexes: [{ name: "org", fields: ["org_id", "created_at"] }],
    });
    expect(
      BLITZDEV_CONFIG.tables.find(({ name }) => name === "workspace_template_folders"),
    ).toMatchObject({
      indexes: [
        { name: "identity", unique: true, fields: ["template_id", "folder_id"] },
        { name: "folder", fields: ["folder_id", "template_id"] },
      ],
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
      "idx_sessions_expires_at",
      "idx_agent_rules_identity",
      "idx_workspaces_owner",
      "idx_workspaces_phase",
      "idx_workspace_grants_identity",
      "idx_folders_org",
      "idx_folder_grants_identity",
      "idx_folder_grants_membership",
      "idx_folder_attachments_identity",
      "idx_folder_attachments_folder",
      "idx_workspace_templates_org",
      "idx_workspace_template_folders_identity",
      "idx_workspace_template_folders_folder",
      "idx_recipes_org",
      "idx_recipes_template",
      "idx_webapp_state_identity",
      "idx_boxes_broker",
      "idx_boxes_principal",
      "idx_broker_keys_box",
      "idx_broker_keys_identity",
      "idx_broker_members_box",
      "idx_broker_members_identity",
      "idx_connections_org_name",
      "idx_connections_org",
      "idx_user_oauth_grants_live",
      "idx_user_oauth_grants_provider",
      "idx_workspace_template_connections_provider",
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
