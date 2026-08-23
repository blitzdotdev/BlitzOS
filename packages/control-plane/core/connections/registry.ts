import type {
  Connection,
  ConnectionView,
  Custody,
  ListConnectionsResponse,
  Minter,
  MintKind,
} from "./types.js";
import type { Db } from "../db.js";
import { first, rows, transaction } from "../db.js";
import {
  HttpError,
  isNumber,
  isRecord,
  isString,
  readJson,
  requiredString,
} from "../http.js";
import type { Principal } from "../principals.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { manifestBaseUrl } from "./catalog/index.js";
import type { ProviderManifest } from "./catalog/types.js";
import { revokeConnectionLeasesQuery } from "./leases.js";
import { sealRoot } from "./root-crypto.js";
import {
  githubAppMinter,
  importGithubAppPrivateKey,
  normalizeGithubAppPrivateKey,
} from "./minters/app-jwt/github-app.js";
import { staticMinter } from "./minters/static.js";

const minters: readonly Minter[] = [githubAppMinter, staticMinter];

type PlacementFill = "token" | "proxy-url";

interface EnvPlacementTemplate {
  kind: "env";
  name: string;
  fill?: PlacementFill;
}

interface FilePlacementTemplate {
  kind: "file";
  path: string;
  mode?: number;
  fill?: PlacementFill;
}

interface UnsetEnvPlacementTemplate {
  kind: "unset-env";
  name: string;
}

type ParsedPlacementTemplate =
  | EnvPlacementTemplate
  | FilePlacementTemplate
  | UnsetEnvPlacementTemplate;

interface ParsedProxyConfig {
  base_url: string;
  token_header: string;
  token_prefix: string;
}

interface ParsedStaticConfig {
  placements: ParsedPlacementTemplate[];
  default_scopes?: string[];
  proxy?: ParsedProxyConfig;
}

interface ParsedStringMap {
  [key: string]: string;
}

interface ParsedAppJwtConfig {
  app_id: string;
  installation_id: string;
  placements?: ParsedPlacementTemplate[];
  repositories?: string[];
  permissions?: ParsedStringMap;
}

function isMintKind(value: unknown): value is MintKind {
  return value === "app-jwt" || value === "oauth" || value === "static";
}

function isCustody(value: unknown): value is Custody {
  return value === "cp" || value === "proxy";
}

function stringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => isString(item) && item.length > 0)
  ) {
    throw new HttpError(400, `${field} must be an array of non-empty strings`);
  }
  return value;
}

function placementTemplate(
  value: unknown,
  allowStaticFill = false,
): ParsedPlacementTemplate {
  if (!isRecord(value)) throw new HttpError(400, "each placement must be an object");
  if (value.kind === "env") {
    const result: EnvPlacementTemplate = {
      kind: "env",
      name: requiredString(value.name, "placement.name", 256),
    };
    if (allowStaticFill && value.fill !== undefined) {
      if (value.fill !== "token" && value.fill !== "proxy-url") {
        throw new HttpError(400, "placement.fill must be token or proxy-url");
      }
      result.fill = value.fill;
    }
    return result;
  }
  if (value.kind === "file") {
    const result: FilePlacementTemplate = {
      kind: "file",
      path: requiredString(value.path, "placement.path", 4_096),
    };
    if (value.mode !== undefined) {
      if (
        !isNumber(value.mode) ||
        !Number.isSafeInteger(value.mode) ||
        value.mode < 0 ||
        value.mode > 0o777
      ) {
        throw new HttpError(400, "placement.mode must be an integer from 0 through 511");
      }
      result.mode = value.mode;
    }
    if (allowStaticFill && value.fill !== undefined) {
      if (value.fill !== "token" && value.fill !== "proxy-url") {
        throw new HttpError(400, "placement.fill must be token or proxy-url");
      }
      result.fill = value.fill;
    }
    return result;
  }
  if (value.kind === "unset-env") {
    if (allowStaticFill && value.fill !== undefined) {
      throw new HttpError(400, "unset-env placements cannot declare fill");
    }
    return {
      kind: "unset-env",
      name: requiredString(value.name, "placement.name", 256),
    };
  }
  throw new HttpError(400, "placement.kind must be env, file, or unset-env");
}

function proxyConfig(value: unknown): ParsedProxyConfig {
  if (!isRecord(value)) throw new HttpError(400, "config.proxy must be an object");
  const baseUrl = requiredString(value.base_url, "config.proxy.base_url", 4_096);
  try {
    if (new URL(baseUrl).protocol !== "https:") throw new Error("not https");
  } catch {
    throw new HttpError(400, "config.proxy.base_url must be an https URL");
  }
  const tokenHeader = value.token_header ?? "Authorization";
  if (!isString(tokenHeader) || tokenHeader.length === 0) {
    throw new HttpError(400, "config.proxy.token_header must be a non-empty string");
  }
  const tokenPrefix = value.token_prefix ?? "Bearer ";
  if (!isString(tokenPrefix) || tokenPrefix.length > 4_096) {
    throw new HttpError(400, "config.proxy.token_prefix must be a string");
  }
  try {
    const headers = new Headers();
    headers.set(tokenHeader, `${tokenPrefix}token`);
  } catch {
    throw new HttpError(400, "config.proxy token header or prefix is invalid");
  }
  return {
    base_url: baseUrl,
    token_header: tokenHeader,
    token_prefix: tokenPrefix,
  };
}

function staticConfigJson(value: unknown, custody: Custody): string {
  if (!isRecord(value)) throw new HttpError(400, "config must be an object");
  if (!Array.isArray(value.placements)) {
    throw new HttpError(400, "config.placements must be an array");
  }
  const config: ParsedStaticConfig = {
    placements: value.placements.map((placement) =>
      placementTemplate(placement, true)
    ),
  };
  if (value.default_scopes !== undefined) {
    config.default_scopes = stringArray(value.default_scopes, "config.default_scopes");
  }
  if (value.proxy !== undefined) config.proxy = proxyConfig(value.proxy);
  if (custody === "proxy" && config.proxy === undefined) {
    throw new HttpError(400, "config.proxy.base_url is required for proxy custody");
  }
  return JSON.stringify(config);
}

function digitString(value: unknown, field: string): string {
  if (
    !isString(value) ||
    value.length === 0 ||
    value.length > 256 ||
    !/^\d+$/u.test(value)
  ) {
    throw new HttpError(400, `${field} must be a non-empty string of digits`);
  }
  return value;
}

function stringMap(value: unknown, field: string): ParsedStringMap {
  if (!isRecord(value)) {
    throw new HttpError(400, `${field} must be an object of non-empty strings`);
  }
  const result: ParsedStringMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || !isString(item) || item.length === 0) {
      throw new HttpError(400, `${field} must be an object of non-empty strings`);
    }
    result[key] = item;
  }
  return result;
}

function appJwtConfigJson(value: unknown): string {
  if (!isRecord(value)) throw new HttpError(400, "config must be an object");
  const config: ParsedAppJwtConfig = {
    app_id: digitString(value.app_id, "config.app_id"),
    installation_id: digitString(value.installation_id, "config.installation_id"),
  };
  if (value.placements !== undefined) {
    if (!Array.isArray(value.placements)) {
      throw new HttpError(400, "config.placements must be an array");
    }
    config.placements = value.placements.map((placement) =>
      placementTemplate(placement)
    );
  }
  if (value.repositories !== undefined) {
    config.repositories = stringArray(value.repositories, "config.repositories");
  }
  if (value.permissions !== undefined) {
    config.permissions = stringMap(value.permissions, "config.permissions");
  }
  return JSON.stringify(config);
}

function configJson(kind: MintKind, custody: Custody, value: unknown): string {
  return kind === "app-jwt"
    ? appJwtConfigJson(value)
    : staticConfigJson(value, custody);
}

/** The exact root string to seal. For app-jwt it rewrites GitHub's PKCS#1
 * download into PKCS#8 and proves the result imports, so a sealed app root
 * is always a key the minter can sign with. Encrypted keys carry their own
 * 400 out of the normalizer; everything else that fails to import is one
 * generic 400. */
async function validateRoot(kind: MintKind, root: string): Promise<string> {
  if (kind !== "app-jwt") return root;
  try {
    const normalized = normalizeGithubAppPrivateKey(root);
    await importGithubAppPrivateKey(normalized);
    return normalized;
  } catch (caught) {
    if (caught instanceof HttpError) throw caught;
    throw new HttpError(
      400,
      "private key must be an RSA private key PEM (the .pem file GitHub generates)",
    );
  }
}

function usableByJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new HttpError(400, "usable_by must be an object or null");
  return JSON.stringify({ owners: stringArray(value.owners, "usable_by.owners") });
}

/** The connection row is the provider *declaration*, never a secret. Stock
 * providers land here with zero ceremony the first time a member connects, so
 * every existing lease, audit, proxy, and ceiling join keeps working against
 * one table. A legacy row that still holds an org root is left alone. */
export async function ensureCatalogConnection(
  db: Db,
  orgId: string,
  provider: string,
  manifest: ProviderManifest,
  principal: Principal,
  /** The org's instance URL for instance-hosted vendors (YouTrack): rides
   * `config.proxy.base_url` on the declared row so later members inherit it. */
  instanceBaseUrl: string | null = null,
  now = Date.now(),
): Promise<Connection> {
  const custody = manifest.custody;
  const placements = manifest.delivery.env.map((delivery) => ({
    kind: "env" as const,
    name: delivery.name,
    fill: delivery.fill,
  }));
  const config: ParsedStaticConfig & { manifest_id: string } = {
    manifest_id: manifest.id,
    placements,
    default_scopes: [...manifest.defaultScopes],
  };
  if (custody === "proxy") {
    // The row is where the proxy reads its destination, so a row written with
    // no destination would 502 every call. An instance-hosted vendor supplies
    // the URL from the paste; everyone else declares one on the manifest.
    config.proxy = {
      base_url: instanceBaseUrl ?? manifestBaseUrl(manifest, "proxy custody"),
      token_header: manifest.tokenHeader.name,
      token_prefix: manifest.tokenHeader.prefix,
    };
  }
  await rows(db, {
    q: `INSERT INTO connections
        (id, name, scoped_name, provider, kind, custody, config, root_ciphertext,
         usable_by, created_by, created_at, revoked_at, org_id,
         created_by_membership_id)
        VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8, NULL, ?9, ?10)
        ON CONFLICT(org_id, scoped_name) DO UPDATE SET
          provider = excluded.provider,
          kind = excluded.kind,
          custody = excluded.custody,
          config = excluded.config,
          revoked_at = NULL
        WHERE connections.root_ciphertext IS NULL`,
    v: [
      crypto.randomUUID(),
      provider,
      manifest.id,
      manifest.auth === null ? "static" : "oauth",
      custody,
      JSON.stringify(config),
      principal.id,
      now,
      orgId,
      principal.membershipId,
    ],
  });
  const connection = await connectionByName(db, provider, orgId, false);
  if (connection === null) throw new Error("catalog connection disappeared");
  return connection;
}

/** The non-secret vendor URL a proxy-custody row points at, or null. Shown to
 * members (the paste form prefills from it) and used to validate that a new
 * grant will have somewhere to resolve. */
export function connectionProxyBaseUrl(config: string): string | null {
  try {
    const value: unknown = JSON.parse(config);
    if (!isRecord(value) || !isRecord(value.proxy) || !isString(value.proxy.base_url)) {
      return null;
    }
    return new URL(value.proxy.base_url).protocol === "https:"
      ? value.proxy.base_url
      : null;
  } catch {
    return null;
  }
}

/** Which catalog entry interprets a connection row, when one does. */
export function connectionManifestId(connection: Connection): string | null {
  try {
    const value: unknown = JSON.parse(connection.config);
    return isRecord(value) && isString(value.manifest_id) ? value.manifest_id : null;
  } catch {
    return null;
  }
}

export function resolveMinter(connection: Connection): Minter | null {
  return (
    minters.find(
      (minter) =>
        minter.kind === connection.kind &&
        minter.providers?.includes(connection.provider) === true,
    ) ??
    minters.find(
      (minter) => minter.kind === connection.kind && minter.providers === undefined,
    ) ??
    null
  );
}

export async function connectionByName(
  db: Db,
  name: string,
  orgId: string,
  activeOnly = true,
): Promise<Connection | null> {
  return first<Connection>(db, {
    q: `SELECT id, scoped_name AS name, provider, kind, custody, config,
               root_ciphertext, usable_by, created_by, created_at, revoked_at,
               org_id, created_by_membership_id
        FROM connections
        WHERE scoped_name = ?1 AND org_id = ?2${activeOnly ? " AND revoked_at IS NULL" : ""}
        LIMIT 1`,
    v: [name, orgId],
  });
}

export async function activeConnections(db: Db, orgId: string): Promise<Connection[]> {
  return rows<Connection>(db, {
    q: `SELECT id, scoped_name AS name, provider, kind, custody, config,
               root_ciphertext, usable_by, created_by, created_at, revoked_at,
               org_id, created_by_membership_id FROM connections
        WHERE org_id = ?1 AND revoked_at IS NULL ORDER BY created_at, scoped_name`,
    v: [orgId],
  });
}

function validateServedConnection(
  provider: string,
  kind: MintKind,
  custody: Custody,
): void {
  const candidate: Connection = {
    id: "",
    name: "",
    provider,
    kind,
    custody,
    config: "{}",
    root_ciphertext: null,
    usable_by: null,
    created_by: "",
    created_at: 0,
    revoked_at: null,
    org_id: null,
    created_by_membership_id: null,
  };
  if (resolveMinter(candidate) === null) {
    throw new HttpError(400, `credential kind ${kind} is not available`);
  }
  // A static root can sit behind the proxy or be injected; an app-jwt root
  // mints short-lived tokens the box holds itself, so it is cp only.
  if (kind === "static") return;
  if (kind === "app-jwt" && custody === "cp") return;
  throw new HttpError(400, `credential kind ${kind} does not support ${custody} custody`);
}

export function addConnectionRoutes(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
  requirePrincipal: (context: CoreContext) => Promise<Principal>,
): void {
  const listConnections = async (context: CoreContext) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null) throw new HttpError(403, "active membership required");
    const connections = await rows<
      Pick<Connection, "name" | "provider" | "kind" | "custody" | "config" | "revoked_at" | "created_by">
      & { org_credential: number }
    >(runtimeFactory(context).db, {
      q: `SELECT scoped_name AS name, provider, kind, custody, config, revoked_at, created_by,
                 (root_ciphertext IS NOT NULL) AS org_credential
          FROM connections WHERE org_id = ?1 ORDER BY created_at, scoped_name`,
      v: [principal.orgId],
    });
    const response: ListConnectionsResponse = {
      connections: connections.map((connection): ConnectionView => ({
        name: connection.name,
        provider: connection.provider,
        kind: connection.kind,
        custody: connection.custody,
        status: connection.revoked_at === null ? "active" : "revoked",
        createdBy: connection.created_by,
        // The vendor URL only, never the config itself: the paste form
        // prefills the instance URL for members from this.
        proxyBaseUrl: connectionProxyBaseUrl(connection.config),
        // A boolean about the sealed root, never the root: the surfaces that
        // say "configured" must not mistake a member-declared row for an
        // admin-stored credential.
        orgCredential: connection.org_credential === 1,
      })),
    };
    return context.json(response);
  };

  const putConnection = async (context: CoreContext) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.membershipId === null || principal.role !== "admin") {
      throw new HttpError(403, "organization admin required");
    }
    const name = requiredString(context.req.param("name"), "name", 256);
    const value = await readJson(context.req.raw);
    if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
    const provider = requiredString(value.provider, "provider", 256);
    if (!isMintKind(value.kind)) {
      throw new HttpError(400, "kind must be app-jwt, oauth, or static");
    }
    const custodyValue = value.custody ?? (value.kind === "static" ? "proxy" : "cp");
    if (!isCustody(custodyValue)) {
      throw new HttpError(400, "custody must be cp or proxy");
    }
    validateServedConnection(provider, value.kind, custodyValue);
    const config = configJson(value.kind, custodyValue, value.config);
    const root = await validateRoot(value.kind, requiredString(value.root, "root"));
    const usableBy = usableByJson(value.usable_by);
    const runtime = runtimeFactory(context);
    const existing = await connectionByName(runtime.db, name, principal.orgId, false);
    const id = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    const rootCiphertext = await sealRoot(runtime.credentialMasterKey, name, root);
    await rows(runtime.db, {
      q: `INSERT INTO connections
          (id, name, scoped_name, provider, kind, custody, config, root_ciphertext,
           usable_by, created_by, created_at, revoked_at, org_id,
           created_by_membership_id)
          VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?12)
          ON CONFLICT(org_id, scoped_name) DO UPDATE SET
            provider = excluded.provider,
            kind = excluded.kind,
            custody = excluded.custody,
            config = excluded.config,
            root_ciphertext = excluded.root_ciphertext,
            usable_by = excluded.usable_by,
            created_by = excluded.created_by,
            created_by_membership_id = excluded.created_by_membership_id,
            revoked_at = NULL`,
      v: [
        id,
        name,
        provider,
        value.kind,
        custodyValue,
        config,
        rootCiphertext,
        usableBy,
        principal.id,
        now,
        principal.orgId,
        principal.membershipId,
      ],
    });
    return context.body(null, 204);
  };

  const deleteConnection = async (context: CoreContext) => {
    const principal = await requirePrincipal(context);
    if (principal.orgId === null || principal.role !== "admin") {
      throw new HttpError(403, "organization admin required");
    }
    const name = requiredString(context.req.param("name"), "name", 256);
    const runtime = runtimeFactory(context);
    const connection = await connectionByName(runtime.db, name, principal.orgId, false);
    if (connection === null) throw new HttpError(404, "connection not found");
    await transaction(runtime.db, [
      {
        q: `UPDATE connections
            SET revoked_at = ?1, root_ciphertext = NULL
            WHERE id = ?2`,
        v: [Date.now(), connection.id],
      },
      revokeConnectionLeasesQuery(connection.id),
    ]);
    return context.body(null, 204);
  };

  router.get("/connections", listConnections);
  router.put("/connections/:name", putConnection);
  router.delete("/connections/:name", deleteConnection);
  // Alias paths: the subsystem was called "integrations" before the rename.
  // Old bookmarks and scripts keep working; the same handlers serve both.
  router.get("/integrations", listConnections);
  router.put("/integrations/:name", putConnection);
  router.delete("/integrations/:name", deleteConnection);
}
