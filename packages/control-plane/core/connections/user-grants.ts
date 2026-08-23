import type { Db, Query } from "../db.js";
import { first, rows, transaction } from "../db.js";
import {
  HttpError,
  isRecord,
  isString,
  readJson,
  requiredString,
  type JsonValue,
} from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { catalogViews, providerManifest } from "./catalog/index.js";
import type { ProviderManifest, TokenHeader } from "./catalog/types.js";
import { revokeGrantLeasesQuery } from "./leases.js";
import { scopesFromJson } from "./manifest.js";
import {
  connectionByName,
  connectionProxyBaseUrl,
  ensureCatalogConnection,
} from "./registry.js";
import { openRoot, sealRoot } from "./root-crypto.js";
import type { UserGrantView } from "./types.js";

/** Connection names are the box wire's `integration` value and become a file
 * name inside the box, so they stay to the same alphabet the box accepts.
 * This 63-character rule is the canonical one; `isProviderName` in
 * packages/schema/src/provider-name.ts exports it for everything that can
 * import the schema package (core keeps to relative imports, hence the
 * mirror), and packages/schema/fixtures/connections-focus/ pins the copies. */
const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

export interface GrantRow {
  id: string;
  user_id: string;
  provider: string;
  manifest_id: string;
  kind: "pat" | "oauth";
  label: string | null;
  config: string;
  access_ciphertext: string | null;
  access_expires_at: number | null;
  refresh_ciphertext: string | null;
  scopes: string;
  rotation: number;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

/** Non-secret per-grant configuration, filled from the catalog manifest plus
 * the one thing no manifest can know: the instance URL an instance-hosted
 * vendor lives at. */
export interface GrantConfig {
  baseUrl: string | null;
  tokenHeader: TokenHeader;
}

const GRANT_FIELDS = `id, user_id, provider, manifest_id, kind, label, config,
       access_ciphertext, access_expires_at, refresh_ciphertext, scopes,
       rotation, created_at, updated_at, revoked_at`;

export function grantSecretLabel(userId: string, provider: string): string {
  return `grant:${userId}:${provider}`;
}

export function grantConfig(row: GrantRow): GrantConfig {
  const fallback: GrantConfig = {
    baseUrl: null,
    tokenHeader: { name: "Authorization", prefix: "Bearer " },
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.config);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) return fallback;
  const header = isRecord(parsed.tokenHeader) ? parsed.tokenHeader : null;
  return {
    baseUrl: isString(parsed.baseUrl) ? parsed.baseUrl : null,
    tokenHeader:
      header !== null && isString(header.name) && isString(header.prefix)
        ? { name: header.name, prefix: header.prefix }
        : fallback.tokenHeader,
  };
}

export function grantView(row: GrantRow): UserGrantView {
  return {
    provider: row.provider,
    manifestId: row.manifest_id,
    kind: row.kind,
    label: row.label,
    scopes: scopesFromJson(row.scopes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessExpiresAt: row.access_expires_at,
  };
}

export async function grantFor(
  db: Db,
  userId: string,
  provider: string,
): Promise<GrantRow | null> {
  return first<GrantRow>(db, {
    q: `SELECT ${GRANT_FIELDS} FROM user_oauth_grants
        WHERE user_id = ?1 AND provider = ?2 AND revoked_at IS NULL
        LIMIT 1`,
    v: [userId, provider],
  });
}

export async function grantsForUser(db: Db, userId: string): Promise<GrantRow[]> {
  return rows<GrantRow>(db, {
    q: `SELECT ${GRANT_FIELDS} FROM user_oauth_grants
        WHERE user_id = ?1 AND revoked_at IS NULL
        ORDER BY provider`,
    v: [userId],
  });
}

export async function grantsForProvider(
  db: Db,
  provider: string,
): Promise<GrantRow[]> {
  return rows<GrantRow>(db, {
    q: `SELECT ${GRANT_FIELDS} FROM user_oauth_grants
        WHERE provider = ?1 AND revoked_at IS NULL
        ORDER BY user_id`,
    v: [provider],
  });
}

export async function openGrantSecret(
  key: CryptoKey,
  row: GrantRow,
  which: "access" | "refresh",
): Promise<string | null> {
  const ciphertext = which === "access" ? row.access_ciphertext : row.refresh_ciphertext;
  if (ciphertext === null) return null;
  return openRoot(key, grantSecretLabel(row.user_id, row.provider), ciphertext);
}

export interface StoreGrantInput {
  userId: string;
  provider: string;
  manifestId: string;
  kind: "pat" | "oauth";
  label: string | null;
  config: GrantConfig;
  scopes: readonly string[];
  refresh: string | null;
  access: string | null;
  accessExpiresAt: number | null;
}

/** Replacing a grant revokes the previous one rather than editing it: the old
 * ciphertext must not survive a re-auth, and the leases it backed are dead. */
export async function storeGrant(
  db: Db,
  key: CryptoKey,
  input: StoreGrantInput,
  now = Date.now(),
): Promise<GrantRow> {
  const label = grantSecretLabel(input.userId, input.provider);
  const id = crypto.randomUUID();
  const replaced = await grantFor(db, input.userId, input.provider);
  const queries: Query[] = [
    {
      q: `UPDATE user_oauth_grants
          SET revoked_at = ?1, access_ciphertext = NULL, refresh_ciphertext = NULL
          WHERE user_id = ?2 AND provider = ?3 AND revoked_at IS NULL`,
      v: [now, input.userId, input.provider],
    },
    // Re-pasting a rotated key must kill the boxes holding the old one. An
    // inject-mode lease carries the credential itself, so without this it
    // stays active — and reads as active in the lease UI — for its full hour
    // with a value the vendor has already invalidated.
    ...(replaced === null ? [] : [revokeGrantLeasesQuery(replaced.id)]),
    {
      q: `INSERT INTO user_oauth_grants
          (id, user_id, provider, manifest_id, kind, label, config,
           access_ciphertext, access_expires_at, refresh_ciphertext, scopes,
           rotation, created_at, updated_at, revoked_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?12, NULL)`,
      v: [
        id,
        input.userId,
        input.provider,
        input.manifestId,
        input.kind,
        input.label,
        JSON.stringify(input.config),
        input.access === null ? null : await sealRoot(key, label, input.access),
        input.accessExpiresAt,
        input.refresh === null ? null : await sealRoot(key, label, input.refresh),
        JSON.stringify([...input.scopes]),
        now,
      ],
    },
  ];
  await transaction(db, queries);
  const stored = await grantFor(db, input.userId, input.provider);
  if (stored === null) throw new Error("stored grant disappeared");
  return stored;
}

export async function revokeGrant(
  db: Db,
  userId: string,
  provider: string,
  now = Date.now(),
): Promise<boolean> {
  const grant = await grantFor(db, userId, provider);
  if (grant === null) return false;
  await transaction(db, [
    {
      q: `UPDATE user_oauth_grants
          SET revoked_at = ?1, access_ciphertext = NULL, refresh_ciphertext = NULL
          WHERE id = ?2 AND revoked_at IS NULL`,
      v: [now, grant.id],
    },
    revokeGrantLeasesQuery(grant.id),
  ]);
  return true;
}

/** Compare-and-set on the `rotation` counter, which counts writes and nothing
 * else. A second concurrent refresh must lose rather than overwrite the
 * winner's material, so the caller treats `false` as "another request already
 * wrote". Nothing here stops the two provider calls from both going out. */
export async function rotateGrantTokens(
  db: Db,
  key: CryptoKey,
  row: GrantRow,
  access: string,
  accessExpiresAt: number,
  refresh: string | null,
  now = Date.now(),
): Promise<boolean> {
  const label = grantSecretLabel(row.user_id, row.provider);
  const updated = await rows<{ id: string }>(db, {
    q: `UPDATE user_oauth_grants
        SET access_ciphertext = ?1, access_expires_at = ?2,
            refresh_ciphertext = COALESCE(?3, refresh_ciphertext),
            rotation = rotation + 1, updated_at = ?4
        WHERE id = ?5 AND rotation = ?6 AND revoked_at IS NULL
        RETURNING id`,
    v: [
      await sealRoot(key, label, access),
      accessExpiresAt,
      refresh === null ? null : await sealRoot(key, label, refresh),
      now,
      row.id,
      row.rotation,
    ],
  });
  return updated.length === 1;
}

/** Every scope the provider's catalog knows about. A pasted key carries the
 * reach the person created it with and nothing here can narrow that, so the
 * grant records the vocabulary rather than pretending to a choice: the token's
 * own ceiling is the ceiling. Providers with no scope vocabulary (youtrack,
 * discord) record nothing, which is the truthful answer for them. */
function fullManifestScopes(manifest: ProviderManifest): string[] {
  return manifest.scopes.map((scope) => scope.id);
}

function grantLabel(value: JsonValue | undefined): string | null {
  if (!isString(value)) return null;
  const label = value.trim().slice(0, 128);
  return label.length === 0 ? null : label;
}

function personalTokenHeader(manifest: ProviderManifest): TokenHeader {
  return manifest.personalToken?.header ?? manifest.tokenHeader;
}

function vendorBaseUrl(value: JsonValue): string {
  const baseUrl = requiredString(value, "vendor.baseUrl", 4_096);
  try {
    if (new URL(baseUrl).protocol !== "https:") throw new Error("not https");
  } catch {
    throw new HttpError(400, "vendor.baseUrl must be an https URL");
  }
  return baseUrl;
}

function parseVendorConfig(
  value: JsonValue | undefined,
  manifest: ProviderManifest,
): GrantConfig {
  const config: GrantConfig = {
    baseUrl: null,
    tokenHeader: personalTokenHeader(manifest),
  };
  // Instance-hosted vendors (YouTrack): the paste may name the instance.
  // Absent is fine when the org connection row already carries it — the
  // route validates that one of the two exists.
  if (
    (manifest.personalToken?.baseUrlLabel ?? null) !== null &&
    isRecord(value) &&
    value.baseUrl !== undefined &&
    value.baseUrl !== null
  ) {
    config.baseUrl = vendorBaseUrl(value.baseUrl);
  }
  return config;
}

/** Where the proxy will send an instance-hosted vendor's calls. The row's URL
 * wins so the whole organization stays on one instance; the first member's
 * pasted URL is what sets it. Neither present is a paste that could never
 * resolve, so it fails here instead of at the first proxied call. */
async function resolveInstanceBaseUrl(
  db: Db,
  orgId: string,
  provider: string,
  manifest: ProviderManifest,
  config: GrantConfig,
): Promise<string | null> {
  if ((manifest.personalToken?.baseUrlLabel ?? null) === null) return null;
  const existing = await connectionByName(db, provider, orgId);
  const rowBaseUrl = existing === null ? null : connectionProxyBaseUrl(existing.config);
  if (rowBaseUrl === null && config.baseUrl === null) {
    throw new HttpError(
      400,
      `${manifest.title} needs its instance URL; paste it along with the token`,
    );
  }
  return rowBaseUrl ?? config.baseUrl;
}

export function addUserGrantRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  router.get("/connections/catalog", async (context) => {
    await requirePrincipal(context);
    return context.json({
      providers: catalogViews(runtimeFactory(context).vars.connectSecret),
    });
  });

  router.get("/connections/grants", async (context) => {
    const principal = await requirePrincipal(context);
    const grants = await grantsForUser(runtimeFactory(context).db, principal.id);
    return context.json({ grants: grants.map(grantView) });
  });

  // The only account a member may manage is their own: there are no org
  // grants, so no admin gate belongs here.
  router.put("/connections/grants/:provider", async (context) => {
    const principal = await requirePrincipal(context);
    const provider = requiredString(context.req.param("provider"), "provider", 64);
    if (!PROVIDER_NAME.test(provider)) {
      throw new HttpError(400, "provider must be lowercase letters, digits, dot, dash, or underscore");
    }
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const manifestId = requiredString(value.manifestId, "manifestId", 64);
    const manifest = providerManifest(manifestId);
    if (manifest === null) throw new HttpError(404, `provider ${manifestId} is not in the catalog`);
    if (manifest.personalToken === null) {
      throw new HttpError(
        400,
        `${manifest.title} issues no personal token; connect it with OAuth instead`,
      );
    }
    if (provider !== manifest.id) {
      throw new HttpError(400, `a ${manifest.id} grant must be named ${manifest.id}`);
    }
    const token = requiredString(value.token, "token", 8_192).trim();
    if (token.length === 0) throw new HttpError(400, "token must be a non-empty string");
    const config = parseVendorConfig(value.vendor, manifest);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const runtime = runtimeFactory(context);
    const instanceBaseUrl = await resolveInstanceBaseUrl(
      runtime.db,
      principal.orgId,
      provider,
      manifest,
      config,
    );
    // Declaring the provider is part of connecting it: the connection row is
    // what leases, audit, and the workspace ceiling all key on.
    await ensureCatalogConnection(
      runtime.db,
      principal.orgId,
      provider,
      manifest,
      principal,
      instanceBaseUrl,
    );
    await storeGrant(runtime.db, runtime.credentialMasterKey, {
      userId: principal.id,
      provider,
      manifestId: manifest.id,
      kind: "pat",
      label: grantLabel(value.label),
      config,
      scopes: fullManifestScopes(manifest),
      refresh: token,
      access: null,
      accessExpiresAt: null,
    });
    return context.body(null, 204);
  });

  router.delete("/connections/grants/:provider", async (context) => {
    const principal = await requirePrincipal(context);
    const provider = requiredString(context.req.param("provider"), "provider", 64);
    const removed = await revokeGrant(runtimeFactory(context).db, principal.id, provider);
    if (!removed) throw new HttpError(404, "connection grant not found");
    return context.body(null, 204);
  });
}
