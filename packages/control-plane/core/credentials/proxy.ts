import { hashSecret, matchesStoredHash } from "../crypto.js";
import type { Db } from "../db.js";
import { first } from "../db.js";
import { isRecord, isString } from "../http.js";
import type { CoreContext, CoreRouter, RuntimeFactory } from "../runtime.js";
import { openRoot } from "./root-crypto.js";

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
  integration_name: string;
  root_ciphertext: string | null;
  config: string;
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
  return first<ProxyLeaseRow>(db, {
    q: `SELECT lease.token_hash, integration.name AS integration_name,
               integration.root_ciphertext, integration.config
        FROM credential_leases lease
        JOIN integrations integration ON integration.id = lease.integration_id
        WHERE lease.id = ?1
          AND lease.token_hash IN (${tokenParameters})
          AND lease.state = 'active'
          AND lease.expires_at > ?${nowParameter}
          AND integration.revoked_at IS NULL
          AND integration.kind = 'static'
          AND integration.custody = 'proxy'
        LIMIT 1`,
    v: [leaseId, ...candidates.map(({ hash }) => hash), now],
  });
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

async function proxyCredential(
  context: CoreContext,
  runtime: ReturnType<RuntimeFactory>,
  leaseId: string,
): Promise<ProxyCredential | null> {
  const candidates = await tokenCandidates(context.req.raw.headers);
  const lease = await proxyLease(runtime.db, leaseId, candidates, Date.now());
  if (lease === null || lease.root_ciphertext === null) return null;
  const config = parseProxyConfig(lease.config);
  if (config === null) return null;
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
    return {
      ...config,
      leaseToken: candidate.token,
      root: await openRoot(
        runtime.credentialMasterKey,
        lease.integration_name,
        lease.root_ciphertext,
      ),
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
