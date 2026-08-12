import type { Context, Hono } from "hono";
import {
  bearerToken,
  DUMMY_HASH,
  hashSecret,
  matchesStoredHash,
  randomToken,
} from "./crypto.js";
import { HttpError, isRecord, readForm, readJson, requiredString } from "./http.js";
import type { Principal } from "./principals.js";
import { ensurePrincipal } from "./principals.js";
import type { AppEnv, BoxIdentity } from "./types.js";

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

function oauthError(c: Context<AppEnv>, error: string, status: 400 | 401 = 400): Response {
  return c.json({ error }, status);
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

async function deviceByHash(db: D1Database, hash: string): Promise<DeviceRow | null> {
  return db
    .prepare("SELECT * FROM device_authorizations WHERE device_hash = ?1 LIMIT 1")
    .bind(hash)
    .first<DeviceRow>();
}

async function refreshGrant(
  c: Context<AppEnv>,
  refreshToken: string,
): Promise<Response> {
  const oldHash = await hashSecret(refreshToken);
  const row = await c.env.DB
    .prepare(
      `SELECT f.access_hash, f.refresh_hash, f.access_issued_at,
              b.id, b.principal_id, b.workspace_id, b.is_broker
       FROM box_token_families f JOIN boxes b ON b.id = f.box_id
       WHERE f.refresh_hash = ?1 LIMIT 1`,
    )
    .bind(oldHash)
    .first<BoxTokenRow>();
  const matches = await matchesStoredHash(refreshToken, row?.refresh_hash ?? DUMMY_HASH);
  if (row === null || !matches) {
    return oauthError(c, "invalid_grant");
  }

  const tokens = await issueBoxTokens();
  const result = await c.env.DB
    .prepare(
      `UPDATE box_token_families
       SET access_hash = ?1, refresh_hash = ?2, access_issued_at = ?3,
           generation = generation + 1
       WHERE box_id = ?4 AND refresh_hash = ?5`,
    )
    .bind(tokens.accessHash, tokens.refreshHash, Date.now(), row.id, row.refresh_hash)
    .run();
  if (result.meta.changes !== 1) return oauthError(c, "invalid_grant");
  return c.json({
    box_id: row.id,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
    expires_in: tokens.expiresIn,
  });
}

export async function authenticateBox(
  request: Request,
  db: D1Database,
  now = Date.now(),
): Promise<BoxIdentity | null> {
  const token = bearerToken(request);
  if (token === null) return null;
  const hash = await hashSecret(token);
  const row = await db
    .prepare(
      `SELECT f.access_hash, f.refresh_hash, f.access_issued_at,
              b.id, b.principal_id, b.workspace_id, b.is_broker
       FROM box_token_families f JOIN boxes b ON b.id = f.box_id
       WHERE f.access_hash = ?1 LIMIT 1`,
    )
    .bind(hash)
    .first<BoxTokenRow>();
  const matches = await matchesStoredHash(token, row?.access_hash ?? DUMMY_HASH);
  if (row === null || !matches || now - row.access_issued_at >= ACCESS_LIFETIME_MS) {
    return null;
  }
  return {
    id: row.id,
    principalId: row.principal_id,
    workspaceId: row.workspace_id,
    isBroker: row.is_broker === 1,
  };
}

export function addOAuthRoutes(
  app: Hono<AppEnv>,
  requirePrincipal: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.post("/oauth/device_authorization", async (c) => {
    const params = await requestParameters(c.req.raw);
    const clientId = requiredString(params.client_id, "client_id", 256);
    const deviceCode = randomToken();
    const code = userCode();
    const now = Date.now();
    await c.env.DB
      .prepare(
        `INSERT INTO device_authorizations
         (device_hash, user_hash, client_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(
        await hashSecret(deviceCode),
        await hashSecret(normalizedUserCode(code)),
        clientId,
        now,
      )
      .run();
    const verificationUri = `${new URL(c.req.url).origin}/oauth/device/approve`;
    return c.json({
      device_code: deviceCode,
      user_code: code,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(code)}`,
      expires_in: DEVICE_LIFETIME_MS / 1000,
      interval: DEVICE_INTERVAL_SECONDS,
    });
  });

  app.post("/oauth/device/approve", async (c) => {
    const principal = await requirePrincipal(c);
    const params = await requestParameters(c.req.raw);
    const code = normalizedUserCode(requiredString(params.user_code, "user_code", 32));
    const hash = await hashSecret(code);
    const row = await c.env.DB
      .prepare("SELECT * FROM device_authorizations WHERE user_hash = ?1 LIMIT 1")
      .bind(hash)
      .first<DeviceRow>();
    const matches = await matchesStoredHash(code, row?.user_hash ?? DUMMY_HASH);
    if (row === null || !matches) {
      throw new HttpError(404, "device authorization not found");
    }
    if (row.consumed_at !== null || Date.now() - row.created_at >= DEVICE_LIFETIME_MS) {
      throw new HttpError(409, "device authorization is no longer active");
    }
    await ensurePrincipal(c.env.DB, principal);
    await c.env.DB
      .prepare("UPDATE device_authorizations SET principal_id = ?1 WHERE device_hash = ?2")
      .bind(principal.id, row.device_hash)
      .run();
    return c.body(null, 204);
  });

  app.post("/oauth/token", async (c) => {
    const params = await requestParameters(c.req.raw);
    const grantType = requiredString(params.grant_type, "grant_type", 128);
    if (grantType === "refresh_token") {
      return refreshGrant(c, requiredString(params.refresh_token, "refresh_token"));
    }
    if (grantType !== "urn:ietf:params:oauth:grant-type:device_code") {
      return oauthError(c, "unsupported_grant_type");
    }

    const deviceCode = requiredString(params.device_code, "device_code");
    const clientId = requiredString(params.client_id, "client_id", 256);
    const hash = await hashSecret(deviceCode);
    const row = await deviceByHash(c.env.DB, hash);
    const matches = await matchesStoredHash(deviceCode, row?.device_hash ?? DUMMY_HASH);
    if (row === null || !matches || row.client_id !== clientId) {
      return oauthError(c, "invalid_grant");
    }
    const now = Date.now();
    if (row.consumed_at !== null || now - row.created_at >= DEVICE_LIFETIME_MS) {
      return oauthError(c, "expired_token");
    }
    if (row.principal_id === null) {
      if (
        row.last_poll_at !== null &&
        now - row.last_poll_at < DEVICE_INTERVAL_SECONDS * 1000
      ) {
        return oauthError(c, "slow_down");
      }
      await c.env.DB
        .prepare("UPDATE device_authorizations SET last_poll_at = ?1 WHERE device_hash = ?2")
        .bind(now, row.device_hash)
        .run();
      return oauthError(c, "authorization_pending");
    }

    const boxId = crypto.randomUUID();
    const tokens = await issueBoxTokens();
    const results = await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO boxes (id, principal_id, workspace_id, created_at)
           SELECT ?1, principal_id, NULL, ?2 FROM device_authorizations
           WHERE device_hash = ?3 AND consumed_at IS NULL AND principal_id IS NOT NULL`,
        )
        .bind(boxId, now, row.device_hash),
      c.env.DB
        .prepare(
          `INSERT INTO box_token_families
           (box_id, access_hash, refresh_hash, access_issued_at, generation)
           SELECT ?1, ?2, ?3, ?4, 1 FROM device_authorizations
           WHERE device_hash = ?5 AND consumed_at IS NULL AND principal_id IS NOT NULL`,
        )
        .bind(boxId, tokens.accessHash, tokens.refreshHash, now, row.device_hash),
      c.env.DB
        .prepare(
          `UPDATE device_authorizations SET consumed_at = ?1
           WHERE device_hash = ?2 AND consumed_at IS NULL AND principal_id IS NOT NULL`,
        )
        .bind(now, row.device_hash),
    ]);
    if (results[2]?.meta.changes !== 1) return oauthError(c, "invalid_grant");
    return c.json({
      box_id: boxId,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: "Bearer",
      expires_in: tokens.expiresIn,
    });
  });
}
