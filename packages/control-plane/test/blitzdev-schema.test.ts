import { databaseSettingsSchema, generateMigrations } from "teenybase";
import { describe, expect, it } from "vitest";
import {
  BLITZDEV_CONFIG,
  DENY_ALL_RULES,
  TEENYBASE_SOURCE,
} from "../scripts/build-blitzdev.mjs";

const expectedTables = [
  "principals",
  "sessions",
  "workspaces",
  "device_authorizations",
  "boxes",
  "box_token_families",
  "broker_boxes",
  "broker_keys",
  "blitz_files",
] as const;

describe("blitz.dev managed schema", () => {
  it("parses as TypeScript and passes teenybase's installed config validator", () => {
    expect(TEENYBASE_SOURCE).toMatch(/^import type \{ DatabaseSettings, TableRulesExtensionData \} from "teenybase";/u);
    expect(TEENYBASE_SOURCE).toContain("satisfies DatabaseSettings;");
    expect(databaseSettingsSchema.parse(BLITZDEV_CONFIG)).toEqual(BLITZDEV_CONFIG);
    expect(BLITZDEV_CONFIG.appUrl).toBe("$APP_URL");
  });

  it("contains the eight domain tables plus the deny-all file support table", () => {
    expect(BLITZDEV_CONFIG.tables.map((table) => table.name)).toEqual(expectedTables);
    expect(BLITZDEV_CONFIG.tables).toHaveLength(9);
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
      ]),
      indexes: [{ name: "expires_at", fields: "expires_at" }],
    });
  });

  it("generates only the expected table and index creates from an empty schema", () => {
    const generated = generateMigrations(BLITZDEV_CONFIG, undefined);
    const sql = generated.migrations.map((migration) => migration.sql).join("\n");
    expect([...sql.matchAll(/CREATE TABLE\s+([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1])).toEqual(expectedTables);
    expect([...sql.matchAll(/CREATE (?:UNIQUE )?INDEX\s+([A-Za-z_][A-Za-z0-9_]*)/gu)].map((match) => match[1])).toEqual([
      "idx_sessions_expires_at",
      "idx_workspaces_owner",
      "idx_workspaces_phase",
      "idx_boxes_broker",
      "idx_boxes_principal",
      "idx_broker_keys_box",
      "idx_broker_keys_identity",
      "idx_blitz_files_logical",
      "idx_blitz_files_release",
    ]);
  });
});
