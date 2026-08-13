import { hashSecret } from "./crypto.js";
import type { Db, Query } from "./db.js";
import { first, rows, transaction } from "./db.js";
import {
  HttpError,
  isRecord,
  isSshPublicKey,
  positiveInteger,
  readJson,
  requiredString,
} from "./http.js";
import { authenticateBox } from "./oauth.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type { BoxIdentity } from "./types.js";
import {
  FEED_MAX_BYTES,
  type FeedKey,
  type FeedMember,
  type FeedResponse,
  type RegisterKeysResponse,
} from "./wire.js";

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

async function requireOwnBox(
  context: CoreContext,
  runtimeFactory: RuntimeFactory,
): Promise<BoxIdentity> {
  const box = await authenticateBox(context.req.raw, runtimeFactory(context).db);
  if (box === null) throw new HttpError(401, "invalid box access token");
  if (box.id !== context.req.param("id")) {
    throw new HttpError(403, "a box may only act as itself");
  }
  return box;
}

async function boxRow(db: Db, id: string): Promise<BoxRow | null> {
  return first<BoxRow>(db, {
    q: "SELECT * FROM boxes WHERE id = ?1 LIMIT 1",
    v: [id],
  });
}

async function leastLoadedBroker(db: Db, excludeBoxId: string): Promise<string | null> {
  const row = await first<{ box_id: string }>(db, {
    q: `SELECT broker.box_id
        FROM broker_boxes broker
        LEFT JOIN boxes member ON member.broker_box_id = broker.box_id
        WHERE broker.box_id <> ?1
        GROUP BY broker.box_id
        ORDER BY COUNT(member.id), broker.box_id
        LIMIT 1`,
    v: [excludeBoxId],
  });
  return row?.box_id ?? null;
}

function parseBrokerKeys(value: unknown): FeedKey[] {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length === 0) {
    throw new HttpError(400, "keys must be a non-empty array");
  }
  return value.keys.map((key) => {
    if (!isRecord(key)) throw new HttpError(400, "each key must be an object");
    const pubkey = requiredString(key.pubkey, "pubkey");
    if (!isSshPublicKey(pubkey)) {
      throw new HttpError(400, "pubkey must be an SSH public key");
    }
    if (key.op !== "mint" && key.op !== "deposit") {
      throw new HttpError(400, "op must be mint or deposit");
    }
    return { pubkey, op: key.op };
  });
}

export function addRegistryRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.put("/boxes/:id/broker", async (context) => {
    const box = await requireOwnBox(context, runtimeFactory);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const host = requiredString(value.host, "host", 512);
    const port = positiveInteger(value.port, "port");
    if (port > 65_535) throw new HttpError(400, "port must be at most 65535");
    const hostKey = requiredString(value.sshHostPublicKey, "sshHostPublicKey");
    if (!isSshPublicKey(hostKey)) {
      throw new HttpError(400, "sshHostPublicKey must be an SSH public key");
    }
    await transaction(runtimeFactory(context).db, [
      {
        q: "UPDATE boxes SET is_broker = 1, broker_box_id = NULL WHERE id = ?1",
        v: [box.id],
      },
      {
        q: `INSERT INTO broker_boxes (box_id, host, port, ssh_host_public_key)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(box_id) DO UPDATE SET
              host = excluded.host, port = excluded.port,
              ssh_host_public_key = excluded.ssh_host_public_key`,
        v: [box.id, host, port, hostKey],
      },
    ]);
    return context.body(null, 204);
  });

  router.delete("/boxes/:id/broker", async (context) => {
    const box = await requireOwnBox(context, runtimeFactory);
    await transaction(runtimeFactory(context).db, [
      { q: "DELETE FROM broker_boxes WHERE box_id = ?1", v: [box.id] },
      { q: "UPDATE boxes SET is_broker = 0 WHERE id = ?1", v: [box.id] },
    ]);
    return context.body(null, 204);
  });

  router.post("/boxes/:id/keys", async (context) => {
    const box = await requireOwnBox(context, runtimeFactory);
    const db = runtimeFactory(context).db;
    const current = await boxRow(db, box.id);
    if (current === null || current.workspace_id === null || current.is_broker === 1) {
      throw new HttpError(403, "only workspace boxes may register keys");
    }
    const keys = parseBrokerKeys(await readJson(context.req.raw));
    const assigned = current.broker_box_id ?? (await leastLoadedBroker(db, box.id));
    if (assigned === null) throw new HttpError(409, "no broker box is enrolled");

    const queries: Query[] = [
      {
        q: "UPDATE boxes SET broker_box_id = ?1 WHERE id = ?2 AND broker_box_id IS NULL",
        v: [assigned, box.id],
      },
    ];
    for (const key of keys) {
      queries.push({
        q: `INSERT OR IGNORE INTO broker_keys (id, box_id, pubkey, operation)
            VALUES (?1, ?2, ?3, ?4)`,
        v: [crypto.randomUUID(), box.id, key.pubkey, key.op],
      });
    }
    await transaction(db, queries);
    const broker = await first<BrokerRow>(db, {
      q: `SELECT host, port, ssh_host_public_key
          FROM broker_boxes
          WHERE box_id = ?1`,
      v: [assigned],
    });
    if (broker === null) throw new Error("assigned broker is not enrolled");
    const principal = await first<PrincipalRow>(db, {
      q: "SELECT unix_name FROM principals WHERE id = ?1",
      v: [current.principal_id],
    });
    if (principal === null) throw new Error("box principal does not exist");
    const response: RegisterKeysResponse = {
      memberUnixName: principal.unix_name,
      broker: {
        host: broker.host,
        port: broker.port,
        sshHostPublicKey: broker.ssh_host_public_key,
      },
    };
    return context.json(response, 200);
  });

  router.get("/boxes/:id/feed", async (context) => {
    const box = await requireOwnBox(context, runtimeFactory);
    const db = runtimeFactory(context).db;
    const current = await boxRow(db, box.id);
    if (current?.is_broker !== 1) throw new HttpError(403, "box is not a broker");
    const result = await rows<FeedRow>(db, {
      q: `SELECT p.id AS principal_id, p.unix_name, p.harnesses,
                 keys.pubkey, keys.operation
          FROM boxes member
          JOIN principals p ON p.id = member.principal_id
          LEFT JOIN broker_keys keys ON keys.box_id = member.id
          WHERE member.broker_box_id = ?1
          ORDER BY p.id, member.id, keys.operation, keys.pubkey`,
      v: [box.id],
    });

    const membersByPrincipal = new Map<string, FeedMember>();
    for (const row of result) {
      let member = membersByPrincipal.get(row.principal_id);
      if (member === undefined) {
        member = {
          unixName: row.unix_name,
          harnesses: parseHarnesses(row.harnesses),
          keys: [],
        };
        membersByPrincipal.set(row.principal_id, member);
      }
      if (
        row.pubkey !== null &&
        row.operation !== null &&
        !member.keys.some(
          (key) => key.pubkey === row.pubkey && key.op === row.operation,
        )
      ) {
        member.keys.push({ pubkey: row.pubkey, op: row.operation });
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
    if (context.req.header("if-none-match") === etag) {
      return context.body(null, 304, { ETag: etag });
    }
    return context.body(body, 200, {
      "Content-Type": "application/json; charset=UTF-8",
      ETag: etag,
    });
  });
}
