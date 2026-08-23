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
  is_broker: number;
  platform_operator: number;
}

export interface IssuedBoxTokens {
  accessToken: string;
  refreshToken: string;
  accessHash: string;
  refreshHash: string;
  expiresIn: number;
}

export async function issueBoxTokens(): Promise<IssuedBoxTokens> {
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

async function refreshGrant(
  context: CoreContext,
  runtimeFactory: RuntimeFactory,
  refreshToken: string,
): Promise<Response> {
  const db = runtimeFactory(context).db;
  const oldHash = await hashSecret(refreshToken);
  const row = await first<BoxTokenRow>(db, {
    q: `SELECT f.access_hash, f.refresh_hash, f.access_issued_at,
               b.id, b.principal_id, b.workspace_id,
               EXISTS(
                 SELECT 1 FROM broker_boxes broker WHERE broker.box_id = b.id
               ) AS is_broker
        FROM box_token_families f JOIN boxes b ON b.id = f.box_id
        WHERE f.refresh_hash = ?1 LIMIT 1`,
    v: [oldHash],
  });
  const matches = await matchesStoredHash(refreshToken, row?.refresh_hash ?? DUMMY_HASH);
  if (row === null || !matches) return oauthError(context, "invalid_grant");

  const tokens = await issueBoxTokens();
  const count = await changed(db, {
    q: `UPDATE box_token_families
        SET access_hash = ?1, refresh_hash = ?2, access_issued_at = ?3,
            generation = generation + 1
        WHERE box_id = ?4 AND refresh_hash = ?5
        RETURNING box_id`,
    v: [tokens.accessHash, tokens.refreshHash, Date.now(), row.id, row.refresh_hash],
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

export async function authenticateBox(
  request: Request,
  db: Db,
  now = Date.now(),
): Promise<BoxIdentity | null> {
  const token = bearerToken(request);
  if (token === null) return null;
  const hash = await hashSecret(token);
  const row = await first<BoxTokenRow>(db, {
    q: `SELECT f.access_hash, f.refresh_hash, f.access_issued_at,
               b.id, b.principal_id, b.workspace_id,
               EXISTS(
                 SELECT 1 FROM broker_boxes broker WHERE broker.box_id = b.id
               ) AS is_broker,
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
    isBroker: row.is_broker === 1,
    platformOperator: row.platform_operator === 1,
  };
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
    const tokens = await issueBoxTokens();
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
