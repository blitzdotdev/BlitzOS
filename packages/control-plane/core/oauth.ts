import {
  bearerToken,
  DUMMY_HASH,
  hashSecret,
  matchesStoredHash,
  randomToken,
} from "./crypto.js";
import type { Db } from "./db.js";
import { changed, first, rows, transaction } from "./db.js";
import { HttpError, isRecord, readForm, readJson, requiredString } from "./http.js";
import type { Principal } from "./principals.js";
import { ensurePrincipal } from "./principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "./runtime.js";
import type { BoxIdentity } from "./types.js";

const DEVICE_LIFETIME_MS = 10 * 60 * 1000;
const DEVICE_INTERVAL_SECONDS = 5;
const ACCESS_LIFETIME_MS = 15 * 60 * 1000;

/** How long the refresh hash a rotation retires stays redeemable.
 *
 * A box writes its new pair to disk only after this endpoint has already
 * rotated, so a box that dies inside that window holds a token the family no
 * longer names. Without a way back that box is stranded for good: re-enrolment
 * needs a human at a device code. The grace is the way back.
 *
 * It is the access lifetime, because that is the longest a box can sit quiet
 * between calls and still believe its credential is current. Shorter, and a
 * box that crashes early in an idle period wakes past the window and strands
 * anyway — which is the bug this exists to end. */
const REFRESH_GRACE_MS = ACCESS_LIFETIME_MS;

interface DeviceRow {
  device_hash: string;
  user_hash: string;
  client_id: string;
  principal_id: string | null;
  created_at: number;
  last_poll_at: number | null;
  consumed_at: number | null;
}

interface BoxTokenRow {
  access_hash: string;
  refresh_hash: string;
  access_issued_at: number;
  id: string;
  principal_id: string;
  workspace_id: string | null;
  membership_id: string | null;
  is_broker: number;
  platform_operator: number;
}

interface RefreshRow extends BoxTokenRow {
  previous_refresh_hash: string | null;
  previous_rotated_at: number | null;
  /** Set on a machine family only: which table the row came from, so the
   * rotation writes back to the one that holds it. */
  family: "machine" | "box";
}

export interface IssuedBoxTokens {
  accessToken: string;
  refreshToken: string;
  accessHash: string;
  refreshHash: string;
  expiresIn: number;
}

export async function issueMachineTokens(): Promise<IssuedBoxTokens> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const [accessHash, refreshHash] = await Promise.all([
    hashSecret(accessToken),
    hashSecret(refreshToken),
  ]);
  return {
    accessToken,
    refreshToken,
    accessHash,
    refreshHash,
    expiresIn: ACCESS_LIFETIME_MS / 1000,
  };
}

function oauthError(
  context: CoreContext,
  error: string,
  status: 400 | 401 = 400,
): Response {
  return context.json({ error }, status);
}

async function requestParameters(request: Request): Promise<Record<string, unknown>> {
  if ((request.headers.get("content-type") ?? "").includes("application/json")) {
    const value = await readJson(request);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    return value;
  }
  return Object.fromEntries((await readForm(request)).entries());
}

function userCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()
    .replace(/^(.{4})(.{4})$/u, "$1-$2");
}

function normalizedUserCode(value: string): string {
  return value.replaceAll("-", "").toUpperCase();
}

async function deviceByHash(db: Db, hash: string): Promise<DeviceRow | null> {
  return first<DeviceRow>(db, {
    q: "SELECT * FROM device_authorizations WHERE device_hash = ?1 LIMIT 1",
    v: [hash],
  });
}

/** Which slot of the family the presented refresh token matched.
 *
 * `current` is the ordinary rotation. `previous` is a box coming back for a
 * rotation it never got to keep, and the two retire different things: a
 * current match retires the hash it just spent, while a previous match retires
 * nothing, because the grace it is spending is already running and restarting
 * that clock would let one stale token be redeemed forever. */
type RefreshSlot = "current" | "previous";

async function refreshGrant(
  context: CoreContext,
  runtimeFactory: RuntimeFactory,
  refreshToken: string,
): Promise<Response> {
  const db = runtimeFactory(context).db;
  const oldHash = await hashSecret(refreshToken);
  const now = Date.now();
  // A machine and a box present the same kind of token, so both families are
  // asked. The machine family is the workspace guest; `box_token_families` is
  // what is left of the old table — brokers and device-code enrolments.
  const row = await machineRefreshRow(db, oldHash) ?? await boxRefreshRow(db, oldHash);
  const slot = row === null ? null : await refreshSlot(refreshToken, row, now);
  if (row === null || slot === null) return oauthError(context, "invalid_grant");

  const tokens = await issueMachineTokens();
  // The WHERE is a compare-and-swap on the hash this request read, so two
  // boxes racing the same rotation cannot both win it. The loser reads
  // invalid_grant and retries; by then the file it re-reads holds the winner's
  // pair, or its own token sits in the grace slot.
  const table = row.family === "machine" ? "machine_token_families" : "box_token_families";
  const key = row.family === "machine" ? "machine_id" : "box_id";
  const count = await changed(db, slot === "current"
    ? {
      q: `UPDATE ${table}
          SET access_hash = ?1, refresh_hash = ?2, access_issued_at = ?3,
              previous_refresh_hash = ?5, previous_rotated_at = ?3,
              generation = generation + 1
          WHERE ${key} = ?4 AND refresh_hash = ?5
          RETURNING ${key}`,
      v: [tokens.accessHash, tokens.refreshHash, now, row.id, row.refresh_hash],
    }
    : {
      q: `UPDATE ${table}
          SET access_hash = ?1, refresh_hash = ?2, access_issued_at = ?3,
              generation = generation + 1
          WHERE ${key} = ?4 AND refresh_hash = ?5
          RETURNING ${key}`,
      v: [tokens.accessHash, tokens.refreshHash, now, row.id, row.refresh_hash],
    });
  if (count !== 1) return oauthError(context, "invalid_grant");
  return context.json({
    box_id: row.id,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
  });
}

/** The slot the presented token belongs to, or null when it belongs to
 * neither. Both hashes are compared, in both branches, so the work this does
 * cannot tell an attacker which slot a guess missed. */
async function refreshSlot(
  refreshToken: string,
  row: RefreshRow,
  now: number,
): Promise<RefreshSlot | null> {
  const [isCurrent, isPrevious] = await Promise.all([
    matchesStoredHash(refreshToken, row.refresh_hash),
    matchesStoredHash(refreshToken, row.previous_refresh_hash ?? DUMMY_HASH),
  ]);
  if (isCurrent) return "current";
  if (!isPrevious || row.previous_rotated_at === null) return null;
  return now - row.previous_rotated_at < REFRESH_GRACE_MS ? "previous" : null;
}

/** A machine family, joined to the identity the machine acts as RIGHT NOW.
 *
 * The acting principal is derived here, at call time, from
 * `machines.membership_id`. It is never stored beside the credential: the row
 * that used to hold it (`boxes.principal_id`) pinned the workspace OWNER, so
 * every member's guest minted as one person and every audit row was written in
 * that person's name. There is nothing left to go stale. */
async function machineRefreshRow(db: Db, hash: string): Promise<RefreshRow | null> {
  return first<RefreshRow>(db, {
    q: `SELECT f.access_hash, f.refresh_hash, f.access_issued_at,
               f.previous_refresh_hash, f.previous_rotated_at,
               'machine' AS family, m.id, m.workspace_id, m.membership_id,
               ms.user_id AS principal_id, 0 AS is_broker,
               COALESCE(u.platform_operator, 0) AS platform_operator
        FROM machine_token_families f
        JOIN machines m ON m.id = f.machine_id
        JOIN memberships ms ON ms.id = m.membership_id
        LEFT JOIN users u ON u.id = ms.user_id
        WHERE f.refresh_hash = ?1 OR f.previous_refresh_hash = ?1 LIMIT 1`,
    v: [hash],
  });
}

async function boxRefreshRow(db: Db, hash: string): Promise<RefreshRow | null> {
  return first<RefreshRow>(db, {
    q: `SELECT f.access_hash, f.refresh_hash, f.access_issued_at,
               f.previous_refresh_hash, f.previous_rotated_at,
               'box' AS family, b.id, b.principal_id, b.workspace_id,
               NULL AS membership_id, b.is_broker,
               COALESCE(u.platform_operator, 0) AS platform_operator
        FROM box_token_families f
        JOIN boxes b ON b.id = f.box_id
        LEFT JOIN users u ON u.id = b.principal_id
        WHERE f.refresh_hash = ?1 OR f.previous_refresh_hash = ?1 LIMIT 1`,
    v: [hash],
  });
}

export async function authenticateBox(
  request: Request,
  db: Db,
  now = Date.now(),
): Promise<BoxIdentity | null> {
  const token = bearerToken(request);
  if (token === null) return null;
  const hash = await hashSecret(token);
  const row = await first<BoxTokenRow>(db, {
    q: `SELECT f.access_hash, f.access_issued_at, m.id, m.workspace_id,
               m.membership_id, ms.user_id AS principal_id, 0 AS is_broker,
               COALESCE(u.platform_operator, 0) AS platform_operator
        FROM machine_token_families f
        JOIN machines m ON m.id = f.machine_id
        JOIN memberships ms ON ms.id = m.membership_id
        LEFT JOIN users u ON u.id = ms.user_id
        WHERE f.access_hash = ?1 LIMIT 1`,
    v: [hash],
  }) ?? await first<BoxTokenRow>(db, {
    q: `SELECT f.access_hash, f.access_issued_at, b.id, b.principal_id,
               b.workspace_id, NULL AS membership_id, b.is_broker,
               COALESCE(u.platform_operator, 0) AS platform_operator
        FROM box_token_families f
        JOIN boxes b ON b.id = f.box_id
        LEFT JOIN users u ON u.id = b.principal_id
        WHERE f.access_hash = ?1 LIMIT 1`,
    v: [hash],
  });
  const matches = await matchesStoredHash(token, row?.access_hash ?? DUMMY_HASH);
  if (row === null || !matches || now - row.access_issued_at >= ACCESS_LIFETIME_MS) {
    return null;
  }
  return {
    id: row.id,
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    membershipId: row.membership_id,
    isBroker: row.is_broker === 1,
    platformOperator: row.platform_operator === 1,
  };
}

/** The membership a machine's credential resolves to, read at call time. */
export interface MachineMembership {
  id: string;
  orgId: string;
  role: "admin" | "member";
}

/**
 * The one place a `BoxIdentity` plus its membership becomes a `Principal`.
 *
 * Both box-plane doors build the acting principal here — `boxCaller` for the
 * `/workspaces/self/*` routes and `authenticateMachinePrincipal` for the
 * machine API — so the two can never drift into disagreeing about who a
 * machine acts as. A machine whose membership no longer resolves keeps its
 * user identity and loses its org reach, exactly as an ex-member's session does.
 */
export function machinePrincipal(
  box: BoxIdentity,
  membership: MachineMembership | null,
): Principal {
  return {
    id: box.principalId,
    unixName: "blitz",
    harnesses: [],
    membershipId: membership?.id ?? null,
    orgId: membership?.orgId ?? null,
    role: membership?.role ?? null,
    platformOperator: box.platformOperator,
    plane: "machine",
  };
}

/**
 * A machine asking on the machine API, on its own behalf.
 *
 * This is `blitz-cred`'s identity model applied to the machine routes a
 * person's browser already uses: the bearer names a machine, the machine names
 * a membership, and the membership IS the caller. No route learns that a
 * machine asked — every ownership and role check downstream runs unchanged
 * against the member's own reach, so an agent reaches exactly what its member
 * reaches and nothing more. That includes destroying any machine its member
 * may destroy, its own box's included; the token is the member's, and it is not
 * pretended to be less.
 *
 * Null on any break in that chain (no bearer, unknown token, a broker box with
 * no membership, a membership that is no longer active), so the caller falls
 * through to the next authentication source rather than through a hole.
 */
export async function authenticateMachinePrincipal(
  request: Request,
  db: Db,
  now = Date.now(),
): Promise<Principal | null> {
  const box = await authenticateBox(request, db, now);
  if (box === null || box.membershipId === null) return null;
  const membership = await first<{ id: string; org_id: string; role: "admin" | "member" }>(db, {
    q: `SELECT id, org_id, role FROM memberships
        WHERE id = ?1 AND status = 'active' LIMIT 1`,
    v: [box.membershipId],
  });
  if (membership === null) return null;
  return machinePrincipal(box, {
    id: membership.id,
    orgId: membership.org_id,
    role: membership.role,
  });
}

export function addOAuthRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.post("/oauth/device_authorization", async (context) => {
    const params = await requestParameters(context.req.raw);
    const clientId = requiredString(params.client_id, "client_id", 256);
    const deviceCode = randomToken();
    const code = userCode();
    const now = Date.now();
    await rows(runtimeFactory(context).db, {
      q: `INSERT INTO device_authorizations
          (device_hash, user_hash, client_id, created_at)
          VALUES (?1, ?2, ?3, ?4)`,
      v: [
        await hashSecret(deviceCode),
        await hashSecret(normalizedUserCode(code)),
        clientId,
        now,
      ],
    });
    const verificationUri = `${new URL(context.req.url).origin}/oauth/device/approve`;
    return context.json({
      device_code: deviceCode,
      user_code: code,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(code)}`,
      expires_in: DEVICE_LIFETIME_MS / 1000,
      interval: DEVICE_INTERVAL_SECONDS,
    });
  });

  router.post("/oauth/device/approve", async (context) => {
    const principal = await requirePrincipal(context);
    const params = await requestParameters(context.req.raw);
    const code = normalizedUserCode(requiredString(params.user_code, "user_code", 32));
    const hash = await hashSecret(code);
    const db = runtimeFactory(context).db;
    const row = await first<DeviceRow>(db, {
      q: "SELECT * FROM device_authorizations WHERE user_hash = ?1 LIMIT 1",
      v: [hash],
    });
    const matches = await matchesStoredHash(code, row?.user_hash ?? DUMMY_HASH);
    if (row === null || !matches) {
      throw new HttpError(404, "device authorization not found");
    }
    if (row.consumed_at !== null || Date.now() - row.created_at >= DEVICE_LIFETIME_MS) {
      throw new HttpError(409, "device authorization is no longer active");
    }
    await ensurePrincipal(db, principal);
    await rows(db, {
      q: "UPDATE device_authorizations SET principal_id = ?1 WHERE device_hash = ?2",
      v: [principal.id, row.device_hash],
    });
    return context.body(null, 204);
  });

  router.post("/oauth/token", async (context) => {
    const params = await requestParameters(context.req.raw);
    const grantType = requiredString(params.grant_type, "grant_type", 128);
    if (grantType === "refresh_token") {
      return refreshGrant(
        context,
        runtimeFactory,
        requiredString(params.refresh_token, "refresh_token"),
      );
    }
    if (grantType !== "urn:ietf:params:oauth:grant-type:device_code") {
      return oauthError(context, "unsupported_grant_type");
    }

    const deviceCode = requiredString(params.device_code, "device_code");
    const clientId = requiredString(params.client_id, "client_id", 256);
    const hash = await hashSecret(deviceCode);
    const db = runtimeFactory(context).db;
    const row = await deviceByHash(db, hash);
    const matches = await matchesStoredHash(deviceCode, row?.device_hash ?? DUMMY_HASH);
    if (row === null || !matches || row.client_id !== clientId) {
      return oauthError(context, "invalid_grant");
    }
    const now = Date.now();
    if (row.consumed_at !== null || now - row.created_at >= DEVICE_LIFETIME_MS) {
      return oauthError(context, "expired_token");
    }
    if (row.principal_id === null) {
      if (
        row.last_poll_at !== null &&
        now - row.last_poll_at < DEVICE_INTERVAL_SECONDS * 1000
      ) {
        return oauthError(context, "slow_down");
      }
      await rows(db, {
        q: "UPDATE device_authorizations SET last_poll_at = ?1 WHERE device_hash = ?2",
        v: [now, row.device_hash],
      });
      return oauthError(context, "authorization_pending");
    }

    const boxId = crypto.randomUUID();
    const tokens = await issueMachineTokens();
    const results = await transaction(db, [
      {
        q: `INSERT INTO boxes (id, principal_id, workspace_id, created_at)
            SELECT ?1, principal_id, NULL, ?2 FROM device_authorizations
            WHERE device_hash = ?3 AND consumed_at IS NULL AND principal_id IS NOT NULL`,
        v: [boxId, now, row.device_hash],
      },
      {
        q: `INSERT INTO box_token_families
            (box_id, access_hash, refresh_hash, access_issued_at, generation)
            SELECT ?1, ?2, ?3, ?4, 1 FROM device_authorizations
            WHERE device_hash = ?5 AND consumed_at IS NULL AND principal_id IS NOT NULL`,
        v: [boxId, tokens.accessHash, tokens.refreshHash, now, row.device_hash],
      },
      {
        q: `UPDATE device_authorizations SET consumed_at = ?1
            WHERE device_hash = ?2 AND consumed_at IS NULL AND principal_id IS NOT NULL
            RETURNING device_hash`,
        v: [now, row.device_hash],
      },
    ]);
    if (results[2]?.length !== 1) return oauthError(context, "invalid_grant");
    return context.json({
      box_id: boxId,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
    });
  });
}
