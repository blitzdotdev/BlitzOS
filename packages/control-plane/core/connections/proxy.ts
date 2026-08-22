import { hashSecret, matchesStoredHash } from "../crypto.js";
import type { Db } from "../db.js";
import { first } from "../db.js";
import { isRecord, isString } from "../http.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import type { TokenHeader } from "./catalog/types.js";
import { openRoot } from "./root-crypto.js";
import { grantSecretLabel } from "./user-grants.js";

const LEASE_TOKEN_AT_END = /([A-Za-z0-9_-]{43})$/u;
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
] as const;

interface TokenCandidate {
  header: string;
  token: string;
  hash: string;
}

interface ProxyLeaseRow {
  token_hash: string;
  connection_name: string;
  root_ciphertext: string | null;
  config: string;
  grant_id: string | null;
  grant_user_id: string | null;
  grant_provider: string | null;
  grant_kind: "pat" | "oauth" | null;
  grant_config: string | null;
  grant_access_ciphertext: string | null;
  grant_access_expires_at: number | null;
  grant_refresh_ciphertext: string | null;
}

interface ProxyConfig {
  baseUrl: string;
  tokenHeader: string;
  tokenPrefix: string;
}

interface ProxyCredential extends ProxyConfig {
  leaseToken: string;
  root: string;
}

async function tokenCandidates(headers: Headers): Promise<TokenCandidate[]> {
  const candidates: Array<Omit<TokenCandidate, "hash">> = [];
  for (const [header, value] of headers) {
    const token = LEASE_TOKEN_AT_END.exec(value)?.[1];
    if (token !== undefined) candidates.push({ header, token });
  }
  return Promise.all(
    candidates.map(async (candidate) => ({
      ...candidate,
      hash: await hashSecret(candidate.token),
    })),
  );
}

async function proxyLease(
  db: Db,
  leaseId: string,
  candidates: readonly TokenCandidate[],
  now: number,
): Promise<ProxyLeaseRow | null> {
  if (candidates.length === 0) return null;
  const tokenParameters = candidates
    .map((_, index) => `?${index + 2}`)
    .join(", ");
  const nowParameter = candidates.length + 2;
  // A grant-backed lease carries its own secret and header shape, so it is not
  // held to the static-connection rule the org-root path needs.
  return first<ProxyLeaseRow>(db, {
    q: `SELECT lease.token_hash, connection.scoped_name AS connection_name,
               connection.root_ciphertext, connection.config,
               lease.grant_id, grant_row.user_id AS grant_user_id,
               grant_row.provider AS grant_provider, grant_row.kind AS grant_kind,
               grant_row.config AS grant_config,
               grant_row.access_ciphertext AS grant_access_ciphertext,
               grant_row.access_expires_at AS grant_access_expires_at,
               grant_row.refresh_ciphertext AS grant_refresh_ciphertext
        FROM credential_leases lease
        JOIN connections connection ON connection.id = lease.connection_id
        LEFT JOIN user_oauth_grants grant_row
          ON grant_row.id = lease.grant_id AND grant_row.revoked_at IS NULL
        WHERE lease.id = ?1
          AND lease.token_hash IN (${tokenParameters})
          AND lease.state = 'active'
          AND lease.expires_at > ?${nowParameter}
          AND connection.revoked_at IS NULL
          AND connection.custody = 'proxy'
          AND (
            (lease.grant_id IS NULL AND connection.kind = 'static')
            OR grant_row.id IS NOT NULL
          )
        LIMIT 1`,
    v: [leaseId, ...candidates.map(({ hash }) => hash), now],
  });
}

/** The grant's own header shape, used on the way out to the vendor. Linear
 * personal keys take a raw `Authorization: <key>`; OAuth tokens take Bearer. */
function parseGrantHeader(value: string | null): TokenHeader {
  const fallback: TokenHeader = { name: "Authorization", prefix: "Bearer " };
  if (value === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !isRecord(parsed.tokenHeader)) return fallback;
    const header = parsed.tokenHeader;
    if (!isString(header.name) || header.name.length === 0 || !isString(header.prefix)) {
      return fallback;
    }
    return { name: header.name, prefix: header.prefix };
  } catch {
    return fallback;
  }
}

function parseGrantBaseUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || !isString(parsed.baseUrl)) return null;
    return new URL(parsed.baseUrl).protocol === "https:" ? parsed.baseUrl : null;
  } catch {
    return null;
  }
}

function parseProxyConfig(value: string): ProxyConfig | null {
  try {
    const config: unknown = JSON.parse(value);
    if (!isRecord(config) || !isRecord(config.proxy)) return null;
    const baseUrl = config.proxy.base_url;
    const tokenHeader = config.proxy.token_header ?? "Authorization";
    const tokenPrefix = config.proxy.token_prefix ?? "Bearer ";
    if (
      !isString(baseUrl) ||
      new URL(baseUrl).protocol !== "https:" ||
      !isString(tokenHeader) ||
      tokenHeader.length === 0 ||
      !isString(tokenPrefix)
    ) {
      return null;
    }
    const headers = new Headers();
    headers.set(tokenHeader, `${tokenPrefix}token`);
    return { baseUrl, tokenHeader, tokenPrefix };
  } catch {
    return null;
  }
}

/** Where the upstream secret and its header shape come from for one lease.
 * A grant-backed lease answers from the person's own grant; the org-root path
 * answers from the connection row it always did. */
async function upstreamSecret(
  runtime: ReturnType<RuntimeFactory>,
  lease: ProxyLeaseRow,
  config: ProxyConfig,
): Promise<{ root: string; config: ProxyConfig } | null> {
  if (lease.grant_id === null || lease.grant_user_id === null || lease.grant_provider === null) {
    if (lease.root_ciphertext === null) return null;
    return {
      root: await openRoot(
        runtime.credentialMasterKey,
        lease.connection_name,
        lease.root_ciphertext,
      ),
      config,
    };
  }
  const grantHeader = parseGrantHeader(lease.grant_config);
  const ciphertext = lease.grant_kind === "pat"
    ? lease.grant_refresh_ciphertext
    : lease.grant_access_ciphertext;
  if (ciphertext === null) return null;
  if (
    lease.grant_kind === "oauth" &&
    (lease.grant_access_expires_at === null || lease.grant_access_expires_at <= Date.now())
  ) {
    return null;
  }
  return {
    root: await openRoot(
      runtime.credentialMasterKey,
      grantSecretLabel(lease.grant_user_id, lease.grant_provider),
      ciphertext,
    ),
    config: {
      // A grant that carries its own URL wins — the person typed it. After
      // that, the connection row's proxy base URL, never the manifest's:
      // instance-hosted vendors (YouTrack) declare only a placeholder in the
      // catalog, and the row is where the organization's real instance lives.
      // Fixed-URL catalog rows carry the manifest URL verbatim, so for them
      // this resolves to the same place it always did.
      baseUrl: parseGrantBaseUrl(lease.grant_config) ?? config.baseUrl,
      tokenHeader: grantHeader.name,
      tokenPrefix: grantHeader.prefix,
    },
  };
}

async function proxyCredential(
  context: CoreContext,
  runtime: ReturnType<RuntimeFactory>,
  leaseId: string,
): Promise<ProxyCredential | null> {
  const candidates = await tokenCandidates(context.req.raw.headers);
  const lease = await proxyLease(runtime.db, leaseId, candidates, Date.now());
  if (lease === null) return null;
  const config = parseProxyConfig(lease.config);
  if (config === null) return null;
  // The box always presents the lease token in the connection's configured
  // header; the upstream header shape may differ and is applied on the way out.
  const candidate = candidates.find(
    ({ header }) => header.toLowerCase() === config.tokenHeader.toLowerCase(),
  );
  if (
    candidate === undefined ||
    context.req.raw.headers.get(config.tokenHeader) !==
      `${config.tokenPrefix}${candidate.token}` ||
    !(await matchesStoredHash(candidate.token, lease.token_hash))
  ) {
    return null;
  }
  try {
    const upstream = await upstreamSecret(runtime, lease, config);
    if (upstream === null) return null;
    return {
      ...upstream.config,
      leaseToken: candidate.token,
      root: upstream.root,
    };
  } catch {
    return null;
  }
}

function stripHopByHop(headers: Headers): Headers {
  const result = new Headers(headers);
  const connection = result.get("connection");
  if (connection !== null) {
    for (const name of connection.split(",")) {
      const trimmed = name.trim();
      if (trimmed.length === 0) continue;
      try {
        result.delete(trimmed);
      } catch {
        // Invalid Connection tokens cannot name a forwarded header.
      }
    }
  }
  for (const name of HOP_BY_HOP_HEADERS) result.delete(name);
  return result;
}

function upstreamUrl(
  requestUrl: URL,
  leaseId: string,
  baseUrl: string,
): URL | null {
  const proxyPrefix = `/proxy/${leaseId}`;
  if (!requestUrl.pathname.startsWith(`${proxyPrefix}/`)) return null;
  const wildcardPath = requestUrl.pathname.slice(proxyPrefix.length);
  const upstream = new URL(baseUrl);
  upstream.pathname = `${upstream.pathname.replace(/\/+$/u, "")}${wildcardPath}`;
  upstream.search = requestUrl.search;
  upstream.hash = "";
  return upstream;
}

async function handleProxyRequest(
  context: CoreContext,
  runtimeFactory: RuntimeFactory,
): Promise<Response> {
  const leaseId = context.req.param("leaseId");
  const credential = await proxyCredential(
    context,
    runtimeFactory(context),
    leaseId,
  );
  if (credential === null) return context.body(null, 401);
  const requestUrl = new URL(context.req.url);
  if (
    requestUrl.pathname.includes(credential.leaseToken) ||
    requestUrl.search.includes(credential.leaseToken)
  ) {
    return context.body(null, 401);
  }
  const destination = upstreamUrl(
    requestUrl,
    leaseId,
    credential.baseUrl,
  );
  if (destination === null) return context.body(null, 401);

  const request = context.req.raw;
  const headers = stripHopByHop(request.headers);
  headers.delete("host");
  for (const [name, value] of request.headers) {
    if (value.endsWith(credential.leaseToken)) headers.delete(name);
  }
  headers.set(
    credential.tokenHeader,
    `${credential.tokenPrefix}${credential.root}`,
  );
  // TODO(house-canon): Route this legacy raw request through the canonical fetch boundary.
  const response = await fetch(destination, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? null
        : request.body,
    redirect: "manual",
    signal: request.signal,
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: stripHopByHop(response.headers),
  });
}

export function addProxyRoute(
  router: CoreRouter,
  runtimeFactory: RuntimeFactory,
): void {
  router.all("/proxy/:leaseId/*", (context) =>
    handleProxyRequest(context, runtimeFactory)
  );
}
