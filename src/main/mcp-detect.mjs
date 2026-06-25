// mcp-detect.mjs — does a connected source have an official MCP server, and is it DCR-eligible?
//
// The broker model (plans/blitzos-mcp-connections.md): when a source advertises an MCP endpoint
// AND its authorization server supports Dynamic Client Registration (RFC 7591), BlitzOS can register
// itself, run OAuth, and call upstream tools — with NO manually-created app. detectMcp() runs the
// detection cascade and returns enough metadata for mcp-broker.mjs to drive that flow.
//
// Cascade (first step to yield an endpoint wins; that endpoint is then CONFIRMED before we trust it):
//   1. well-known: GET https://<sourceId>/.well-known/mcp.json -> {endpoint}   (the standard; fully general)
//   2. curated EXCEPTIONS: only providers that neither self-advertise nor follow the convention (e.g. Sentry's .dev TLD)
//   3. remote registry (only if opts.registryUrl given): GET <registryUrl>/v1/mcp?sourceId= -> {endpoint}
//   4. mcp.<domain> CONVENTION: guess https://mcp.<apex>/mcp — a RUNTIME heuristic, ZERO curated data, validated below.
//      Most public MCP providers host here (verified live), so a NEW site is discovered with no per-site code.
//   5. confirm: GET <endpoint-origin>/.well-known/oauth-protected-resource<endpoint-path>  (RFC 9728)
//        -> authorization_servers[] (+ scopes_supported).  A bogus convention guess is rejected here.
//   6. AS metadata: GET <as>/.well-known/oauth-authorization-server (RFC 8414, path-aware then root),
//        fallback /.well-known/openid-configuration -> {registration_endpoint, authorization_endpoint, token_endpoint}
//   7. dcr = Boolean(registration_endpoint)
//
// Honesty rule: HTTP 200 is NOT proof — SPA hosts (x.com) serve an HTML app shell at every path with a
// 200. Every step parses JSON and validates SHAPE; an HTML/garbage body is treated as "not present", so a
// site with no real MCP server resolves to { available:false } instead of a false positive.
//
// Plain JS, Node 18+ (global fetch). No new deps. Per-sourceId TTL cache with an injectable now() for tests.

import { lookup as dnsLookup } from 'node:dns/promises'

const DEFAULT_TTL_MS = 10 * 60 * 1000 // 10 min — detection metadata is near-static; refreshed on miss/expiry
const DEFAULT_TIMEOUT_MS = 8000

// Module-level cache: sourceId -> { at:number, result }. Cleared via clearDetectCache() (tests).
const _cache = new Map()

// Curated EXCEPTIONS only — providers that have an official MCP server but neither self-advertise
// (/.well-known/mcp.json, tier 1) NOR host it at mcp.<their-domain> (the convention, tier 4), so nothing
// resolves them at runtime. Everything that follows the mcp.<domain> convention (Notion, Linear, Cloudflare,
// Asana, PayPal, Figma, Canva, Intercom, Webflow, Wix, Neon, Prisma, ... — verified 2026-06-22) needs NO entry
// here; it is found at runtime with zero per-site data. Keep this list MINIMAL — it shrinks as self-advertising
// spreads, and registry-server's MCP_ENDPOINTS is the optional remote superset (tier 3). NOT a per-site catalog.
const MCP_EXCEPTIONS = {
  'sentry.io': 'https://mcp.sentry.dev/mcp' // Sentry's MCP lives on a different TLD (.dev), so the convention misses it
  // (GitHub is api.githubcopilot.com/mcp — add once its DCR flow is verified.)
}

// ---- SSRF guard --------------------------------------------------------------
// connection_connect_mcp takes a FREE-FORM sourceId from the agent, AND the cascade follows endpoint/authServer
// URLs the (possibly attacker-influenced) source advertises. So EVERY outbound fetch is guarded here, at the one
// chokepoint (getJson): a host that is — or DNS-resolves to — loopback, link-local, or an RFC1918/ULA private
// range is REJECTED (treated as "not present"), so BlitzOS never probes internal/cloud-metadata endpoints (e.g.
// 169.254.169.254, localhost:8080, 10.x). Covers DNS rebinding by resolving the real host before the fetch.

// Is a LITERAL IP string in a blocked range? IPv4: loopback 127/8, link-local 169.254/16, private 10/8,
// 172.16/12, 192.168/16, "this-host" 0/8. IPv6: ::1 (loopback), fe80::/10 (link-local), fc00::/7 (ULA),
// :: (unspecified), and IPv4-mapped ::ffff:a.b.c.d (re-checked as the embedded v4). Returns false for a
// non-IP string (a hostname is classified by DNS resolution instead).
function isBlockedIp(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!s) return true
  // IPv4 dotted-quad
  const m4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (m4) {
    const o = m4.slice(1).map((n) => Number(n))
    if (o.some((n) => n > 255)) return true // malformed → block
    const [a, b] = o
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    return false
  }
  if (s.includes(':')) {
    // IPv4-mapped IPv6 (::ffff:1.2.3.4) → judge by the embedded v4.
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)
    if (mapped) return isBlockedIp(mapped[1])
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true // fe80::/10
    const hi = parseInt(s.split(':')[0] || '0', 16)
    if (!Number.isNaN(hi) && (hi & 0xfe00) === 0xfc00) return true // fc00::/7 (ULA)
    return false
  }
  return false // not an IP literal
}

// Block obvious loopback HOSTNAMES without needing DNS (localhost and the .localhost reserved TLD always map to
// loopback per RFC 6761). Other hostnames are resolved via DNS in isBlockedHost.
function isLoopbackHostname(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost')
}

// Resolve a hostname and block if ANY resolved address is in a blocked range (defends DNS rebinding). A literal
// IP is checked directly (no DNS). On resolution failure we DO NOT block (a public host that's briefly
// unresolvable should fail the fetch naturally, not be mistaken for an internal target). `resolveDns:false`
// (set when a custom fetch is injected — tests/controlled transports) skips the DNS step but keeps the literal +
// loopback-hostname checks, so the guard is still exercised without real network resolution.
async function isBlockedHost(host, { resolveDns = true } = {}) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!h) return true
  if (isLoopbackHostname(h)) return true
  // A literal IP host: classify directly.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h.includes(':')) return isBlockedIp(h)
  if (!resolveDns) return false // hostname, DNS skipped (injected fetch) — literal/loopback already cleared it
  try {
    const addrs = await dnsLookup(h, { all: true })
    if (!Array.isArray(addrs) || addrs.length === 0) return false
    return addrs.some((a) => isBlockedIp(a.address))
  } catch {
    return false // unresolvable → let the fetch fail naturally rather than block a transient public host
  }
}

/**
 * Detect whether a source has a DCR-eligible MCP server.
 * @param {string} sourceId  a bare host like 'www.notion.com' (scheme/path are stripped if present)
 * @param {object} [opts]
 * @param {string} [opts.registryUrl]  curated registry base; tier-2 is skipped when absent
 * @param {number} [opts.ttlMs]        cache TTL (default 10 min)
 * @param {number} [opts.timeoutMs]    per-request timeout (default 8s)
 * @param {boolean}[opts.force]        bypass + refresh the cache for this sourceId
 * @param {() => number} [opts.now]    injectable clock (ms) for TTL; defaults to Date.now
 * @param {typeof fetch} [opts.fetch]  injectable fetch (tests); defaults to global fetch
 * @returns {Promise<{available:boolean, endpoint?:string, authServer?:string,
 *   asMeta?:{registration_endpoint?:string, authorization_endpoint?:string, token_endpoint?:string},
 *   scopes?:string[], dcr:boolean, via:string}>}
 */
export async function detectMcp(sourceId, opts = {}) {
  const key = normalizeSourceId(sourceId)
  if (!key) return notAvailable('invalid-source')

  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS

  if (!opts.force) {
    const hit = _cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.result
  }

  const result = await runCascade(key, opts)
  _cache.set(key, { at: now(), result })
  return result
}

/** Drop a cached entry (or the whole cache when no sourceId). Mainly for tests / re-auth. */
export function clearDetectCache(sourceId) {
  if (sourceId == null) { _cache.clear(); return }
  _cache.delete(normalizeSourceId(sourceId))
}

/**
 * TEST SEAM ONLY: pre-seed the detection cache for a sourceId so a caller (connectMcp) can be driven against a
 * loopback mock AS/MCP server without the SSRF guard rejecting the loopback host at detect time (the broker has
 * no SSRF guard and reaches whatever endpoint/asMeta the cached result names). Not used in production.
 */
export function _seedCache(sourceId, result, now = Date.now) {
  const key = normalizeSourceId(sourceId)
  if (key) _cache.set(key, { at: now(), result })
}

// ---- cascade ----------------------------------------------------------------

async function runCascade(sourceId, opts) {
  // Tier 1: the source's own advertisement.
  let endpoint = await probeWellKnownEndpoint(sourceId, opts)
  let via = 'well-known'

  // Tier 2: curated EXCEPTIONS — only providers that neither self-advertise nor follow the convention below.
  if (!endpoint && MCP_EXCEPTIONS[sourceId]) { endpoint = MCP_EXCEPTIONS[sourceId]; via = 'exception' }

  // Tier 3: remote curated registry (optional authoritative superset; only if a registryUrl is supplied).
  if (!endpoint && opts.registryUrl) {
    const fromReg = await probeRegistryEndpoint(sourceId, opts.registryUrl, opts)
    if (fromReg) { endpoint = fromReg; via = 'registry' }
  }

  // Tier 4: the mcp.<domain> CONVENTION — a RUNTIME heuristic with zero curated data. Most public MCP providers
  // host at mcp.<their-domain> (verified live 2026-06-22: notion, linear, cloudflare, asana, paypal, figma,
  // canva, intercom, webflow, wix, neon, prisma, sentry.dev). It's only a GUESS, but SAFE: the protected-resource
  // + DCR confirmation below validates it, so a non-existent mcp.<domain> or a non-MCP service there is rejected
  // as not-available. This is what lets a NEW site's MCP server be discovered with no per-site code at all.
  if (!endpoint) {
    const apex = String(sourceId).replace(/^www\./, '')
    endpoint = `https://mcp.${apex}/mcp`
    via = 'convention'
  }

  if (!endpoint) return notAvailable('no-endpoint')

  // Confirm: the endpoint must publish protected-resource metadata naming its authorization server(s).
  const prm = await fetchProtectedResource(endpoint, opts)
  if (!prm || !Array.isArray(prm.authorization_servers) || prm.authorization_servers.length === 0) {
    // An endpoint with no advertised AS can't be brokered (we can't run OAuth) -> not available to us.
    return notAvailable('no-protected-resource')
  }
  const authServer = firstString(prm.authorization_servers)
  if (!authServer) return notAvailable('no-protected-resource')
  const scopes = stringArray(prm.scopes_supported)

  // AS metadata: the DCR discriminator + the endpoints the broker needs.
  const asMeta = await fetchAuthServerMeta(authServer, opts)
  if (!asMeta) {
    // The PR metadata is valid but the AS doesn't publish discoverable metadata. We confirmed an MCP
    // endpoint exists, but can't self-register/auth, so dcr:false and available stays true-but-unbrokerable.
    return {
      available: true,
      endpoint,
      authServer,
      asMeta: undefined,
      scopes,
      dcr: false,
      via,
    }
  }

  const dcr = Boolean(asMeta.registration_endpoint)
  return {
    available: true,
    endpoint,
    authServer,
    asMeta: {
      registration_endpoint: asMeta.registration_endpoint,
      authorization_endpoint: asMeta.authorization_endpoint,
      token_endpoint: asMeta.token_endpoint,
    },
    scopes,
    dcr,
    via,
  }
}

// ---- tier 1: well-known mcp.json -------------------------------------------

async function probeWellKnownEndpoint(sourceId, opts) {
  const url = `https://${sourceId}/.well-known/mcp.json`
  const body = await getJson(url, opts)
  if (!body || typeof body !== 'object') return null
  const endpoint = httpUrlOrNull(body.endpoint)
  return endpoint
}

// ---- tier 2: curated registry ----------------------------------------------

async function probeRegistryEndpoint(sourceId, registryUrl, opts) {
  let url
  try {
    const base = new URL('/v1/mcp', registryUrl)
    base.searchParams.set('sourceId', sourceId)
    url = base.toString()
  } catch {
    return null // a malformed registryUrl just disables tier-2; never throws
  }
  const body = await getJson(url, opts)
  if (!body || typeof body !== 'object') return null
  return httpUrlOrNull(body.endpoint)
}

// ---- step 3: protected-resource metadata (RFC 9728) -------------------------
// well-known is at <origin>/.well-known/oauth-protected-resource<path> where <path> is the resource's
// path component. Per RFC 9728 a root resource may instead live at the bare .../oauth-protected-resource;
// we try the path-aware URL first, then the root, so both layouts resolve.

async function fetchProtectedResource(endpoint, opts) {
  let origin, path
  try {
    const u = new URL(endpoint)
    origin = u.origin
    path = u.pathname && u.pathname !== '/' ? u.pathname : ''
  } catch {
    return null
  }
  const candidates = []
  if (path) candidates.push(`${origin}/.well-known/oauth-protected-resource${path}`)
  candidates.push(`${origin}/.well-known/oauth-protected-resource`)
  for (const url of candidates) {
    const body = await getJson(url, opts)
    if (body && typeof body === 'object' && Array.isArray(body.authorization_servers)) return body
  }
  return null
}

// ---- step 4: authorization-server metadata (RFC 8414 + OIDC fallback) -------
// RFC 8414 inserts the well-known segment BEFORE the issuer path; in practice most servers also answer at
// the root. We try (path-aware oauth, root oauth, path-aware oidc, root oidc) and take the first that
// parses as JSON with a token_endpoint (the minimum that proves it's real AS metadata, not an HTML shell).

async function fetchAuthServerMeta(authServer, opts) {
  let origin, path
  try {
    const u = new URL(authServer)
    origin = u.origin
    path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : ''
  } catch {
    return null
  }
  const candidates = []
  if (path) candidates.push(`${origin}/.well-known/oauth-authorization-server${path}`)
  candidates.push(`${origin}/.well-known/oauth-authorization-server`)
  if (path) candidates.push(`${origin}/.well-known/openid-configuration${path}`)
  candidates.push(`${origin}/.well-known/openid-configuration`)

  for (const url of candidates) {
    const body = await getJson(url, opts)
    if (body && typeof body === 'object' && typeof body.token_endpoint === 'string') return body
  }
  return null
}

// ---- helpers ----------------------------------------------------------------

function normalizeSourceId(sourceId) {
  if (typeof sourceId !== 'string') return ''
  let s = sourceId.trim()
  if (!s) return ''
  // Accept a bare host, or a full URL/host-with-path — keep only the host.
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  try {
    return new URL(s).host.toLowerCase()
  } catch {
    return ''
  }
}

function notAvailable(via) {
  return { available: false, dcr: false, via }
}

function httpUrlOrNull(v) {
  if (typeof v !== 'string' || !v) return null
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : null
  } catch {
    return null
  }
}

function firstString(arr) {
  for (const v of arr) if (typeof v === 'string' && v) return v
  return null
}

function stringArray(v) {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x) => typeof x === 'string' && x)
  return out.length ? out : undefined
}

/**
 * GET a URL and parse it as JSON — but ONLY accept a body that truly is JSON.
 * Returns the parsed object/array on success, or null on any failure (non-2xx, network/timeout, HTML or
 * otherwise unparseable body). This is the load-bearing guard: SPA hosts answer every path with a 200 +
 * HTML, so status alone would false-positive. We never throw to the caller — detection is best-effort.
 */
async function getJson(url, opts) {
  const fetchImpl = opts.fetch || globalThis.fetch
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  // SSRF guard: never probe a host that is / resolves to loopback/link-local/private. Applies to the input
  // sourceId AND every endpoint/authServer URL the source advertised. DNS resolution is skipped only when a
  // custom fetch is injected (tests / controlled transports), where the literal + loopback-hostname checks still run.
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return null // an unparseable URL is "not present"
  }
  if (await isBlockedHost(host, { resolveDns: !opts.fetch })) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    })
    if (!res || !res.ok) return null
    // Fast reject obvious HTML before spending parse effort; still try JSON.parse if type is missing/odd.
    const ct = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || ''
    if (/text\/html/i.test(ct)) return null
    const text = await res.text()
    const trimmed = text.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null
    return JSON.parse(trimmed)
  } catch {
    return null // network error, abort/timeout, or invalid JSON — all mean "not present here"
  } finally {
    clearTimeout(timer)
  }
}
