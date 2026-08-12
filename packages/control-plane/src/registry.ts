import { FEED_MAX_BYTES } from "@blitzos/schema";
import type {
  FeedKey,
  FeedMember,
  FeedResponse,
  RegisterKeysResponse,
} from "@blitzos/schema";
import type { Context, Hono } from "hono";
import { hashSecret } from "./crypto.js";
import {
  HttpError,
  isRecord,
  isSshPublicKey,
  positiveInteger,
  readJson,
  requiredString,
} from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { AppEnv, BoxIdentity } from "./types.js";

interface BoxRow {
  id: string;
  principal_id: string;
  workspace_id: string | null;
  broker_box_id: string | null;
  is_broker: number;
}

interface FeedRow {
  principal_id: string;
  unix_name: string;
  harnesses: string;
  pubkey: string | null;
  operation: "mint" | "deposit" | null;
}

interface BrokerRow {
  host: string;
  port: number;
  ssh_host_public_key: string;
}

interface PrincipalRow {
  unix_name: string;
}

function parseHarnesses(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

async function requireOwnBox(c: Context<AppEnv>): Promise<BoxIdentity> {
  const box = await authenticateBox(c.req.raw, c.env.DB);
  if (box === null) throw new HttpError(401, "invalid box access token");
  if (box.id !== c.req.param("id")) throw new HttpError(403, "a box may only act as itself");
  return box;
}

async function boxRow(db: D1Database, id: string): Promise<BoxRow | null> {
  return db.prepare("SELECT * FROM boxes WHERE id = ?1 LIMIT 1").bind(id).first<BoxRow>();
}

async function leastLoadedBroker(
  db: D1Database,
  excludeBoxId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT broker.box_id
       FROM broker_boxes broker
       LEFT JOIN boxes member ON member.broker_box_id = broker.box_id
       WHERE broker.box_id <> ?1
       GROUP BY broker.box_id
       ORDER BY COUNT(member.id), broker.box_id
       LIMIT 1`,
    )
    .bind(excludeBoxId)
    .first<{ box_id: string }>();
  return row?.box_id ?? null;
}

function parseBrokerKeys(value: unknown): FeedKey[] {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length === 0) {
    throw new HttpError(400, "keys must be a non-empty array");
  }
  return value.keys.map((key) => {
    if (!isRecord(key)) throw new HttpError(400, "each key must be an object");
    const pubkey = requiredString(key.pubkey, "pubkey");
    if (!isSshPublicKey(pubkey)) throw new HttpError(400, "pubkey must be an SSH public key");
    if (key.op !== "mint" && key.op !== "deposit") {
      throw new HttpError(400, "op must be mint or deposit");
    }
    return { pubkey, op: key.op };
  });
}

export function addRegistryRoutes(app: Hono<AppEnv>): void {
  app.put("/boxes/:id/broker", async (c) => {
    const box = await requireOwnBox(c);
    const value = await readJson(c.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const host = requiredString(value.host, "host", 512);
    const port = positiveInteger(value.port, "port");
    if (port > 65_535) throw new HttpError(400, "port must be at most 65535");
    const hostKey = requiredString(value.sshHostPublicKey, "sshHostPublicKey");
    if (!isSshPublicKey(hostKey)) {
      throw new HttpError(400, "sshHostPublicKey must be an SSH public key");
    }
    await c.env.DB.batch([
      c.env.DB
        .prepare("UPDATE boxes SET is_broker = 1, broker_box_id = NULL WHERE id = ?1")
        .bind(box.id),
      c.env.DB
        .prepare(
          `INSERT INTO broker_boxes (box_id, host, port, ssh_host_public_key)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(box_id) DO UPDATE SET
             host = excluded.host, port = excluded.port,
             ssh_host_public_key = excluded.ssh_host_public_key`,
        )
        .bind(box.id, host, port, hostKey),
    ]);
    return c.body(null, 204);
  });

  app.delete("/boxes/:id/broker", async (c) => {
    const box = await requireOwnBox(c);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM broker_boxes WHERE box_id = ?1").bind(box.id),
      c.env.DB.prepare("UPDATE boxes SET is_broker = 0 WHERE id = ?1").bind(box.id),
    ]);
    return c.body(null, 204);
  });

  app.post("/boxes/:id/keys", async (c) => {
    const box = await requireOwnBox(c);
    const current = await boxRow(c.env.DB, box.id);
    if (current === null || current.workspace_id === null || current.is_broker === 1) {
      throw new HttpError(403, "only workspace boxes may register keys");
    }
    const keys = parseBrokerKeys(await readJson(c.req.raw));
    const assigned = current.broker_box_id ?? (await leastLoadedBroker(c.env.DB, box.id));
    if (assigned === null) throw new HttpError(409, "no broker box is enrolled");

    const statements: D1PreparedStatement[] = [
      c.env.DB
        .prepare("UPDATE boxes SET broker_box_id = ?1 WHERE id = ?2 AND broker_box_id IS NULL")
        .bind(assigned, box.id),
    ];
    for (const key of keys) {
      statements.push(
        c.env.DB
          .prepare(
            `INSERT OR IGNORE INTO broker_keys (id, box_id, pubkey, operation)
             VALUES (?1, ?2, ?3, ?4)`,
          )
          .bind(crypto.randomUUID(), box.id, key.pubkey, key.op),
      );
    }
    await c.env.DB.batch(statements);
    const broker = await c.env.DB
      .prepare(
        `SELECT host, port, ssh_host_public_key
         FROM broker_boxes
         WHERE box_id = ?1`,
      )
      .bind(assigned)
      .first<BrokerRow>();
    if (broker === null) throw new Error("assigned broker is not enrolled");
    const principal = await c.env.DB
      .prepare("SELECT unix_name FROM principals WHERE id = ?1")
      .bind(current.principal_id)
      .first<PrincipalRow>();
    if (principal === null) throw new Error("box principal does not exist");
    const response: RegisterKeysResponse = {
      memberUnixName: principal.unix_name,
      broker: {
        host: broker.host,
        port: broker.port,
        sshHostPublicKey: broker.ssh_host_public_key,
      },
    };
    return c.json(response, 200);
  });

  app.get("/boxes/:id/feed", async (c) => {
    const box = await requireOwnBox(c);
    const current = await boxRow(c.env.DB, box.id);
    if (current?.is_broker !== 1) throw new HttpError(403, "box is not a broker");
    const result = await c.env.DB
      .prepare(
        `SELECT p.id AS principal_id, p.unix_name, p.harnesses,
                keys.pubkey, keys.operation
         FROM boxes member
         JOIN principals p ON p.id = member.principal_id
         LEFT JOIN broker_keys keys ON keys.box_id = member.id
         WHERE member.broker_box_id = ?1
         ORDER BY p.id, member.id, keys.operation, keys.pubkey`,
      )
      .bind(box.id)
      .all<FeedRow>();

    const membersByPrincipal = new Map<string, FeedMember>();
    for (const row of result.results) {
      let member = membersByPrincipal.get(row.principal_id);
      if (member === undefined) {
        member = {
          unixName: row.unix_name,
          harnesses: parseHarnesses(row.harnesses),
          keys: [],
        };
        membersByPrincipal.set(row.principal_id, member);
      }
      if (row.pubkey !== null && row.operation !== null) {
        if (!member.keys.some((key) => key.pubkey === row.pubkey && key.op === row.operation)) {
          member.keys.push({ pubkey: row.pubkey, op: row.operation });
        }
      }
    }
    const members = [...membersByPrincipal.values()];
    const version = await hashSecret(JSON.stringify(members));
    const response: FeedResponse = { version, members };
    const body = JSON.stringify(response);
    if (new TextEncoder().encode(body).byteLength > FEED_MAX_BYTES) {
      throw new Error("broker feed exceeds FEED_MAX_BYTES");
    }
    const etag = `"${version}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });
    return c.body(body, 200, { "Content-Type": "application/json; charset=UTF-8", ETag: etag });
  });
}
