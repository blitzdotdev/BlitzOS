import { hashSecret } from "./crypto.js";
import type { Db, Query } from "./db.js";
import { first, rows, transaction } from "./db.js";
import {
  HttpError,
  isRecord,
  isSshPublicKey,
  isString,
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
  harnesses: string;
  pubkey: string | null;
  operation: "mint" | "deposit" | null;
}

interface BrokerRow {
  host: string;
  port: number;
  ssh_host_public_key: string;
}

/**
 * `m-<12 hex>` — the broker-side unix account for one member. Derived
 * SERVER-SIDE from the principal id; a caller never supplies it, and it is
 * never read back out of `principals.unix_name`.
 *
 * WHY IT IS NOT `principals.unix_name`: that column is the workspace-box login
 * and is the literal `blitz` for everyone. On a workspace box, where one box
 * belongs to one member, a shared name is harmless. On a BROKER box, which
 * holds the only copy of every member's vendor refresh token and hosts all of
 * them at once, a shared name means one `/home` directory, one credential file,
 * and every member evicting every other. The isolation boundary of this whole
 * design is one unix account per member, so the name has to be per member —
 * and only here. `principals.unix_name` is deliberately left alone.
 *
 * The 12 hex characters are an INVARIANT this function must guarantee, not a
 * property of the input. `packages/broker/internal/feed/feed.go` gates every
 * member on `^m-[0-9a-f]{12}$` and rejects the WHOLE feed when one name fails —
 * deliberately, because a half-trusted list is worse than none when reconcile
 * runs as root and its delete sweep is gated on the same pattern. That makes
 * this producer load-bearing: one short name costs every member on that box
 * their keys until it is fixed.
 *
 * DEVIATION from the production original, which slices the id's own hex
 * characters and only falls back to a hash: production has
 * `UNIQUE(broker_box_id, unix_name)` to catch a collision, and blitz-core has
 * no `broker_members` table to hang that constraint on. A digest gives 48
 * uniformly-distributed bits whatever the id looks like, so ids that differ
 * only in a suffix — which a prefix-of-hex would happily collapse — stay apart
 * without a database backstop. A collision here would hand one member another
 * member's credential home, so the weaker construction is not worth its
 * synchronousness.
 */
async function brokerUnixName(principalId: string): Promise<string> {
  return `m-${(await hashSecret(principalId)).slice(0, 12)}`;
}

function parseHarnesses(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => isString(item))
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

/**
 * The least loaded broker box that is still under its `member_cap`, or null
 * when every box is full — at which point a human provisions another
 * (packages/broker/deploy). Null is also what zero enrolled brokers returns,
 * and the two are deliberately the same answer: the caller's job either way is
 * to leave the workspace signed out and cleanly wired to nothing.
 *
 * Load is counted in DISTINCT PRINCIPALS, not boxes. `member_cap` is a
 * blast-radius cap — how many identities one broker compromise takes — and one
 * member opening ten workspaces adds ten boxes but only one credential home.
 * Counting boxes would evict a heavy user's eleventh workspace off a box that
 * holds one credential.
 */
async function leastLoadedBroker(db: Db, excludeBoxId: string): Promise<string | null> {
  const row = await first<{ box_id: string }>(db, {
    q: `SELECT broker.box_id
        FROM broker_boxes broker
        LEFT JOIN boxes member ON member.broker_box_id = broker.box_id
        WHERE broker.box_id <> ?1
        GROUP BY broker.box_id
        HAVING COUNT(DISTINCT member.principal_id) < broker.member_cap
        ORDER BY COUNT(DISTINCT member.principal_id), broker.box_id
        LIMIT 1`,
    v: [excludeBoxId],
  });
  return row?.box_id ?? null;
}

/**
 * The broker box this member is already on, if any of their OTHER boxes has
 * one. Roaming is the whole point: every workspace a member owns has to reach
 * the same credential home, so a member's second workspace must land on the
 * box that already holds their credential rather than wherever the load
 * balancer would put a stranger. Without this, opening a second workspace
 * splits a member across two brokers and the second one is signed out with no
 * way to fix itself.
 *
 * `member_cap` is deliberately NOT consulted here. The cap sizes the blast
 * radius of a NEW identity landing on a box; this member's credential is
 * already there, and refusing them would strand a box they own.
 */
async function stickyBroker(
  db: Db,
  principalId: string,
  excludeBoxId: string,
): Promise<string | null> {
  const row = await first<{ broker_box_id: string }>(db, {
    q: `SELECT member.broker_box_id AS broker_box_id
        FROM boxes member
        JOIN broker_boxes broker ON broker.box_id = member.broker_box_id
        WHERE member.principal_id = ?1
          AND member.id <> ?2
          AND member.broker_box_id IS NOT NULL
        ORDER BY member.broker_box_id
        LIMIT 1`,
    v: [principalId, excludeBoxId],
  });
  return row?.broker_box_id ?? null;
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
    const assigned =
      current.broker_box_id ??
      (await stickyBroker(db, current.principal_id, box.id)) ??
      (await leastLoadedBroker(db, box.id));
    // `no_broker_capacity` is a MACHINE TOKEN, not prose, and it is the only
    // 409 this route raises. The workspace reads it, removes any stale broker
    // wiring it is holding, and exits 0 (packages/broker/internal/workspace).
    // Zero enrolled brokers and every broker full are the same answer on
    // purpose: the feature is simply off for this box, and a workspace that
    // runs signed-out is one a human can fix, where a workspace whose services
    // refused to start is not.
    if (assigned === null) throw new HttpError(409, "no_broker_capacity");

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
    const response: RegisterKeysResponse = {
      memberUnixName: await brokerUnixName(current.principal_id),
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
      q: `SELECT p.id AS principal_id, p.harnesses,
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
          // The SAME derivation the key registration above answered with. The
          // two must agree or the box is handed a login the broker never
          // creates, so they share one function and neither reads a stored
          // name.
          unixName: await brokerUnixName(row.principal_id),
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
