import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const RETIREMENT_MIGRATION = "0053_drop_credential_broker.sql";

interface SchemaRow {
  type: string;
  name: string;
  table_name: string;
  sql: string | null;
}

interface NameRow {
  name: string;
}

interface MachineFixtureRow {
  id: string;
  vm_id: string | null;
}

interface LeaseFixtureRow {
  id: string;
  box_id: string | null;
  machine_id: string | null;
}

interface EventFixtureRow {
  id: number;
  lease_id: string | null;
}

async function schema(db: D1Database): Promise<SchemaRow[]> {
  const result = await db.prepare(
    `SELECT type, name, tbl_name AS table_name, sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations'
     ORDER BY type, name`,
  ).all<SchemaRow>();
  return result.results;
}

async function columnNames(db: D1Database, table: string): Promise<string[]> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<NameRow>();
  return result.results.map(({ name }) => name);
}

async function seedBrokerEraRows(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO principals (id, unix_name, harnesses)
       VALUES ('member-principal', 'blitz', '["codex"]'),
              ('custody-principal', 'blitz', '["codex"]')`,
    ),
    db.prepare(
      `INSERT INTO users
       (id, google_user_id, email, name, platform_operator, created_at, updated_at)
       VALUES ('user', 'google-user', 'user@example.com', 'User', 0, 1, 1)`,
    ),
    db.prepare(
      `INSERT INTO orgs
       (id, slug, name, vm_limit, created_at, updated_at, created_by_user_id)
       VALUES ('org', 'org', 'Org', 10, 1, 1, 'user')`,
    ),
    db.prepare(
      `INSERT INTO memberships (id, user_id, org_id, role, status)
       VALUES ('membership', 'user', 'org', 'admin', 'active')`,
    ),
    db.prepare(
      `INSERT INTO workspaces
       (id, owner_id, revision, created_at, updated_at, org_id,
        owner_membership_id, default_machine_type_id, auto_provision)
       VALUES ('workspace', 'member-principal', 1, 1, 1, 'org',
               'membership', 'small', 1)`,
    ),
    db.prepare(
      `INSERT INTO boxes
       (id, principal_id, workspace_id, broker_box_id, is_broker, created_at)
       VALUES ('custody-box', 'custody-principal', NULL, NULL, 1, 1),
              ('device-box', 'member-principal', NULL, NULL, 0, 1)`,
    ),
    db.prepare(
      `INSERT INTO broker_boxes
       (box_id, host, port, ssh_host_public_key, member_cap)
       VALUES ('custody-box', 'custody.example', 22, 'ssh-ed25519 AAAAcustody', 25)`,
    ),
    db.prepare(
      `UPDATE boxes SET broker_box_id = 'custody-box' WHERE id = 'device-box'`,
    ),
    db.prepare(
      `INSERT INTO machines
       (id, workspace_id, membership_id, state, machine_type_id,
        vm_id, broker_box_id, created_at, updated_at)
       VALUES ('machine', 'workspace', 'membership', 'running', 'small',
               'vm-machine', 'custody-box', 1, 1)`,
    ),
    db.prepare(
      `INSERT INTO broker_members
       (principal_id, broker_box_id, unix_name, created_at)
       VALUES ('member-principal', 'custody-box', 'm-123456789abc', 1)`,
    ),
    db.prepare(
      `INSERT INTO broker_keys (id, machine_id, pubkey, operation)
       VALUES ('key', 'machine', 'ssh-ed25519 AAAAmint', 'mint')`,
    ),
    db.prepare(
      `INSERT INTO machine_token_families
       (machine_id, vm_id, access_hash, refresh_hash, access_issued_at, generation)
       VALUES ('machine', 'vm-machine', 'machine-access', 'machine-refresh', 1, 1)`,
    ),
    db.prepare(
      `INSERT INTO box_token_families
       (box_id, access_hash, refresh_hash, access_issued_at, generation)
       VALUES ('custody-box', 'custody-access', 'custody-refresh', 1, 1),
              ('device-box', 'device-access', 'device-refresh', 1, 1)`,
    ),
    db.prepare(
      `INSERT INTO connections
       (id, name, provider, kind, custody, config, created_by, created_at,
        org_id, created_by_membership_id, scoped_name)
       VALUES ('connection', 'connection', 'github', 'oauth', 'cp', '{}',
               'member-principal', 1, 'org', 'membership', 'connection')`,
    ),
    db.prepare(
      `INSERT INTO credential_leases
       (id, workspace_id, box_id, connection_id, scopes, mode,
        issued_at, expires_at, state, machine_id)
       VALUES ('device-lease', 'workspace', 'device-box', 'connection', '[]',
               'inject', 1, 2, 'active', 'machine'),
              ('custody-lease', 'workspace', 'custody-box', 'connection', '[]',
               'inject', 1, 2, 'active', 'machine')`,
    ),
    db.prepare(
      `INSERT INTO credential_events (lease_id, event, detail, created_at)
       VALUES ('device-lease', 'minted', '{"result":"kept"}', 1)`,
    ),
  ]);
}

describe("credential custody schema retirement", () => {
  it("matches fresh and seeded upgrades without losing surviving data", async () => {
    const priorMigrations = env.TEST_MIGRATIONS.filter(
      ({ name }) => name !== RETIREMENT_MIGRATION,
    );
    expect(priorMigrations).toHaveLength(env.TEST_MIGRATIONS.length - 1);

    await applyD1Migrations(env.MIGRATION_FRESH, env.TEST_MIGRATIONS);
    await applyD1Migrations(env.MIGRATION_UPGRADED, priorMigrations);
    await seedBrokerEraRows(env.MIGRATION_UPGRADED);
    await applyD1Migrations(env.MIGRATION_UPGRADED, env.TEST_MIGRATIONS);

    const freshSchema = await schema(env.MIGRATION_FRESH);
    const upgradedSchema = await schema(env.MIGRATION_UPGRADED);
    expect(upgradedSchema).toEqual(freshSchema);
    // ONE ASSERTION PER TABLE, and that is not style. `arrayContaining` matches
    // only when EVERY name is present, so `.not.toEqual(arrayContaining([...]))`
    // passes as soon as one of the three is gone — two could survive unseen.
    // The schema equality above cannot catch it either: a migration that drops
    // nothing leaves both databases equally wrong.
    const upgradedTables = upgradedSchema
      .filter(({ type }) => type === "table")
      .map(({ name }) => name);
    for (const table of ["broker_keys", "broker_members", "broker_boxes"]) {
      expect(upgradedTables, `${table} survived the retirement migration`).not.toContain(table);
    }
    expect(await columnNames(env.MIGRATION_UPGRADED, "machines"))
      .not.toContain("broker_box_id");
    expect(await columnNames(env.MIGRATION_UPGRADED, "boxes"))
      .toEqual(["id", "principal_id", "workspace_id", "created_at"]);

    const machine = await env.MIGRATION_UPGRADED.prepare(
      "SELECT id, vm_id FROM machines WHERE id = 'machine'",
    ).first<MachineFixtureRow>();
    expect(machine).toEqual({ id: "machine", vm_id: "vm-machine" });

    const machineTokens = await env.MIGRATION_UPGRADED.prepare(
      "SELECT machine_id AS name FROM machine_token_families ORDER BY machine_id",
    ).all<NameRow>();
    expect(machineTokens.results).toEqual([{ name: "machine" }]);

    const boxes = await env.MIGRATION_UPGRADED.prepare(
      "SELECT id AS name FROM boxes ORDER BY id",
    ).all<NameRow>();
    expect(boxes.results).toEqual([{ name: "device-box" }]);

    const tokenBoxes = await env.MIGRATION_UPGRADED.prepare(
      "SELECT box_id AS name FROM box_token_families ORDER BY box_id",
    ).all<NameRow>();
    expect(tokenBoxes.results).toEqual([{ name: "device-box" }]);

    const leases = await env.MIGRATION_UPGRADED.prepare(
      `SELECT id, box_id, machine_id FROM credential_leases ORDER BY id`,
    ).all<LeaseFixtureRow>();
    expect(leases.results).toEqual([
      { id: "custody-lease", box_id: null, machine_id: "machine" },
      { id: "device-lease", box_id: "device-box", machine_id: "machine" },
    ]);

    const events = await env.MIGRATION_UPGRADED.prepare(
      "SELECT id, lease_id FROM credential_events ORDER BY id",
    ).all<EventFixtureRow>();
    expect(events.results).toEqual([{ id: 1, lease_id: "device-lease" }]);

    const violations = await env.MIGRATION_UPGRADED.prepare(
      "PRAGMA foreign_key_check",
    ).all();
    expect(violations.results).toEqual([]);
  });
});
