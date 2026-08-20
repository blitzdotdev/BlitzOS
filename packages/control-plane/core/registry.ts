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
 * member on `^m-[0-9a-f]{12}$` and rejects PER MEMBER, not per feed: the bad
 * entry is dropped and every other member in the same response is applied
 * normally. The consumer states the rule in its own comment — a producer that
 * starts emitting a shape the binary does not understand "must not cost every
 * other member their keys".
 *
 * Containment is not absolution, and this is the failure that makes this
 * producer load-bearing. A member whose name arrives malformed is simply ABSENT
 * from the decoded feed, and absence is the deprovision signal:
 * `internal/broker/reconcile.go` sweeps every managed account that is neither
 * wanted nor in the preserve set, and feed.go only preserves names that PASSED
 * the pattern. Emitting a short name for a member who already has a home is
 * therefore identical to emitting nothing for them — `userdel --remove` over
 * the only copy of their vendor refresh token. One member instead of a boxful,
 * with nothing in the loop reporting it.
 *
 * DEVIATION from the production original, which slices the id's own hex
 * characters and only falls back to a hash. `broker_members` now carries the
 * same `UNIQUE(broker_box_id, unix_name)` production hangs its collision
 * backstop on (migrations/0020_broker_members.sql), so the old reason given
 * here — that blitz-core had no table to hang the constraint on — is gone. The
 * digest stays for what catching a collision COSTS: the constraint is a
 * detector, not a repair. It surfaces as a failed INSERT in `POST
 * /boxes/:id/keys`, and nothing in blitz-core renames the loser, so that member
 * cannot register keys until a human intervenes. A digest gives 48
 * uniformly-distributed bits whatever the id looks like — including the short
 * non-UUID principal ids blitz-core mints, where a prefix-of-hex has almost no
 * hex to slice and would collapse ids differing only in a suffix. The
 * constraint is the last line; the digest is what keeps us off it.
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
 * Load is counted in MEMBERSHIPS, not boxes. `member_cap` is a blast-radius
 * cap — how many identities one broker compromise takes — and one member
 * opening ten workspaces adds ten boxes but only one credential home. Counting
 * boxes would evict a heavy user's eleventh workspace off a box that holds one
 * credential; counting live boxes would also let a box fill past its cap with
 * the homes of members who happen to have nothing running.
 */
async function leastLoadedBroker(db: Db, excludeBoxId: string): Promise<string | null> {
  const row = await first<{ box_id: string }>(db, {
    q: `SELECT broker.box_id
        FROM broker_boxes broker
        LEFT JOIN broker_members member ON member.broker_box_id = broker.box_id
        WHERE broker.box_id <> ?1
        GROUP BY broker.box_id
        HAVING COUNT(member.principal_id) < broker.member_cap
        ORDER BY COUNT(member.principal_id), broker.box_id
        LIMIT 1`,
    v: [excludeBoxId],
  });
  return row?.box_id ?? null;
}

/**
 * The broker box this member's credential already lives on.
 *
 * Roaming is the whole point: every workspace a member owns has to reach the
 * same credential home, so their next workspace must land on the box that
 * already holds their credential rather than wherever the load balancer would
 * put a stranger. Without this, a second workspace splits a member across two
 * brokers and the second one is signed out with no way to fix itself.
 *
 * It reads the MEMBERSHIP, not the member's other boxes. The credential home
 * is what stickiness is about, and the home outlives every workspace — so a
 * member who destroys their last workspace and opens a new one comes back to
 * the same broker instead of being placed as a stranger next to a home they
 * already own.
 *
 * `member_cap` is deliberately NOT consulted here. The cap sizes the blast
 * radius of a NEW identity landing on a box; this member's credential is
 * already there, and refusing them would strand a box they own.
 *
 * The JOIN to `broker_boxes` keeps a de-enrolled broker out of the answer. The
 * CASCADE on `broker_members.broker_box_id` should already have removed the
 * row, so this is belt and braces — but the two failure modes are not
 * comparable. Missing the JOIN and reading a dangling row hands the caller a
 * box that is not enrolled, which `POST /boxes/:id/keys` can only turn into a
 * 500; failing to find a row costs nothing, because placement then falls
 * through to `leastLoadedBroker` and the member lands somewhere real.
 */
async function stickyBroker(db: Db, principalId: string): Promise<string | null> {
  const row = await first<{ broker_box_id: string }>(db, {
    q: `SELECT member.broker_box_id AS broker_box_id
        FROM broker_members member
        JOIN broker_boxes broker ON broker.box_id = member.broker_box_id
        WHERE member.principal_id = ?1
        LIMIT 1`,
    v: [principalId],
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
    // Membership, then the box's own pin, then placement. The pin is a derived
    // copy of the membership and so can never outvote one; it sits in the chain
    // for boxes wired to a broker BEFORE `broker_members` existed.
    // migrations/0018 does not backfill — `unix_name` is a SHA-256 digest no
    // SQL statement can compute — so those boxes carry their assignment in the
    // only place that still has it, and their next registration rebuilds the
    // membership on the broker they are already talking to. Without this the
    // rebuild would go through `leastLoadedBroker` and move a live member's
    // credential home to whichever box is emptiest.
    const assigned =
      (await stickyBroker(db, current.principal_id)) ??
      current.broker_box_id ??
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
      // The membership is what places this member, and it is written FIRST so
      // the box row below can be derived from it. `DO NOTHING` makes the
      // placement above advisory: an existing membership wins, so two
      // workspaces registering at once cannot end up on two brokers.
      {
        q: `INSERT INTO broker_members (principal_id, broker_box_id, unix_name, created_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(principal_id) DO NOTHING`,
        v: [
          current.principal_id,
          assigned,
          await brokerUnixName(current.principal_id),
          Date.now(),
        ],
      },
      // Follows the membership rather than only filling a NULL, so a box left
      // pointing at a broker the member is no longer on re-wires itself on its
      // next boot instead of talking to a box that will not mint for it.
      {
        q: `UPDATE boxes
            SET broker_box_id = (
              SELECT broker_box_id FROM broker_members WHERE principal_id = ?1
            )
            WHERE id = ?2`,
        v: [current.principal_id, box.id],
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
    // Read the placement back rather than answering with what this request
    // proposed: the membership row is authoritative, and it may be one another
    // registration wrote.
    const membership = await first<{ broker_box_id: string; unix_name: string }>(db, {
      q: "SELECT broker_box_id, unix_name FROM broker_members WHERE principal_id = ?1",
      v: [current.principal_id],
    });
    if (membership === null) throw new Error("broker membership missing after assignment");
    const broker = await first<BrokerRow>(db, {
      q: `SELECT host, port, ssh_host_public_key
          FROM broker_boxes
          WHERE box_id = ?1`,
      v: [membership.broker_box_id],
    });
    if (broker === null) throw new Error("assigned broker is not enrolled");
    const response: RegisterKeysResponse = {
      // The name the FEED will serve, from the same row, so the login this box
      // is handed and the account the broker creates cannot disagree.
      memberUnixName: membership.unix_name,
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
    // Driven by MEMBERSHIPS, with the boxes LEFT-joined on. A member whose
    // workspaces have all been destroyed still appears, with an empty key
    // list: that is the wire's "keep this account, serve it no keys" state.
    // Deriving this from live boxes instead — as it once did — made destroying
    // a member's last workspace their deprovision signal, and the broker
    // answers that signal by deleting the home holding the only copy of their
    // vendor refresh token.
    //
    // The keys still come from boxes, and only from boxes, so destroy remains
    // the revocation path: the box row goes, `broker_keys` CASCADEs with it,
    // and the next poll removes those authorized_keys lines.
    const result = await rows<FeedRow>(db, {
      q: `SELECT member.unix_name AS unix_name, p.harnesses AS harnesses,
                 keys.pubkey AS pubkey, keys.operation AS operation
          FROM broker_members member
          JOIN principals p ON p.id = member.principal_id
          LEFT JOIN boxes box
            ON box.principal_id = member.principal_id
           AND box.broker_box_id = member.broker_box_id
          LEFT JOIN broker_keys keys ON keys.box_id = box.id
          WHERE member.broker_box_id = ?1
          ORDER BY member.unix_name, box.id, keys.operation, keys.pubkey`,
      v: [box.id],
    });

    const membersByName = new Map<string, FeedMember>();
    for (const row of result) {
      let member = membersByName.get(row.unix_name);
      if (member === undefined) {
        member = {
          // The name the registration response above already handed this
          // member's boxes, read back off the same row. A derivation on each
          // side could drift; one stored name cannot.
          unixName: row.unix_name,
          harnesses: parseHarnesses(row.harnesses),
          keys: [],
        };
        membersByName.set(row.unix_name, member);
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
    const members = [...membersByName.values()];
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
