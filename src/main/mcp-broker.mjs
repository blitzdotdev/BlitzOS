// The MCP BROKER — BlitzOS as the OAuth owner + the upstream MCP client. One shared module (plain .mjs, Node
// 18+ globals only) so the Electron main and the server backend both broker the same way. No new npm deps:
// node:http for the loopback listener, node:crypto for PKCE/state, global fetch for everything HTTP.
//
// What this owns (the mcp-broker.* contract, see plans/blitzos-mcp-connections.md):
//   - dcrRegister(asMeta, {clientName, redirectUri, scopes})  → dynamic client registration (RFC 7591)
//   - buildAuthorizeUrl({asMeta, clientId, scopes, redirectUri, resource})  → PKCE S256 + random state
//   - exchangeCode({asMeta, clientId, clientSecret?, code, verifier, redirectUri, resource})  → tokens
//   - refresh({asMeta, clientId, clientSecret?, refresh_token, resource?})  → fresh tokens (resource keeps the audience)
//   - startLoopback()  → {redirectUri, armAuthorize({asMeta, clientId, ...})→authUrl, waitForTokens(), cancel()} (two-phase: bind port → DCR → arm)
//   - mcpInitialize / mcpListTools / mcpCallTool  → streamable-HTTP MCP client (mcp-session-id, SSE+JSON)
//
// BlitzOS is the broker: it holds the OAuth secrets + tokens; headless agents never see a redirect or a
// WWW-Authenticate. PKCE is S256 always; state is a fresh random nonce per authorize (CSRF guard); the
// loopback redirect is 127.0.0.1-only and one-shot. The `resource` param (RFC 8707) binds the token to the
// MCP endpoint when the AS supports it. Tokens are returned to the caller (mcp-token-store persists them);
// this module NEVER logs a token, code, verifier, or secret.

import http from 'node:http'
import { randomBytes, createHash, randomUUID } from 'node:crypto'

const MCP_PROTOCOL_VERSION = '2025-06-18'
const DEFAULT_CLIENT_NAME = 'BlitzOS'
// Network timeouts: OAuth/registration are quick; an MCP tool call can be slow (the upstream may do real work).
const HTTP_TIMEOUT_MS = 30000
const MCP_CALL_TIMEOUT_MS = 120000
const LOOPBACK_TIMEOUT_MS = 600000 // 10 min for the human to approve in the browser

// ---------------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------------

// fetch with a hard timeout via AbortController (global fetch has no default timeout). Returns the Response;
// throws a descriptive Error on abort/network failure so the caller never hangs forever.
async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: ctrl.signal })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`request to ${redactUrl(url)} timed out after ${timeoutMs}ms`)
    throw new Error(`request to ${redactUrl(url)} failed: ${e?.message || e}`)
  } finally {
    clearTimeout(timer)
  }
}

// Strip any query string from a URL before it goes into an error/log message — an authorize URL carries the
// state + challenge, and a token endpoint should never leak its body, but URLs are the safe-to-show part.
function redactUrl(u) {
  try {
    const url = new URL(String(u))
    return url.origin + url.pathname
  } catch {
    return '[url]'
  }
}

// Read a Response body as text once, then try to JSON.parse it. Returns {json, text}. Never throws on a
// non-JSON body (some error responses are text/plain) — the caller decides what a missing field means.
async function readJsonResponse(res) {
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { json, text }
}

// Pull a human-readable error out of an OAuth/registration error response (RFC 6749 §5.2 shape, else raw).
function oauthError(json, text) {
  if (json && (json.error || json.error_description)) {
    return [json.error, json.error_description].filter(Boolean).join(': ')
  }
  return (text || '').slice(0, 300) || 'unknown error'
}

// ---------------------------------------------------------------------------------------------------------
// PKCE + state
// ---------------------------------------------------------------------------------------------------------

// base64url with no padding (RFC 7636 §A) — the alphabet OAuth expects for code_verifier/challenge + state.
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// A high-entropy PKCE verifier (RFC 7636: 43–128 chars). 32 random bytes → 43 base64url chars.
function makeVerifier() {
  return base64url(randomBytes(32))
}

// S256 challenge = base64url(SHA-256(verifier)). We ALWAYS use S256 (never 'plain').
function challengeS256(verifier) {
  return base64url(createHash('sha256').update(verifier).digest())
}

// A fresh CSRF state nonce per authorize call.
function makeState() {
  return base64url(randomBytes(16))
}

// ---------------------------------------------------------------------------------------------------------
// AS-metadata accessors — be permissive about which endpoint names the AS published (DCR servers vary).
// asMeta is the OAuth Authorization Server metadata (RFC 8414) OR the subset the contract names:
//   {registration_endpoint, authorization_endpoint, token_endpoint}.
// ---------------------------------------------------------------------------------------------------------

function requireEndpoint(asMeta, key, human) {
  const v = asMeta && asMeta[key]
  if (!v || typeof v !== 'string') {
    throw new Error(`authorization server metadata is missing ${human || key}`)
  }
  return v
}

// Some servers offer S256 in code_challenge_methods_supported; if the field is present and lacks S256 we
// still proceed (S256 is mandatory-to-implement in PKCE), but this lets callers/tests sanity-check.
export function supportsS256(asMeta) {
  const m = asMeta?.code_challenge_methods_supported
  if (!Array.isArray(m)) return true // unspecified → assume the spec default (S256 supported)
  return m.includes('S256')
}

// ---------------------------------------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591) — POST the AS's registration_endpoint, get a client_id back.
// ---------------------------------------------------------------------------------------------------------

export async function dcrRegister(asMeta, { clientName = DEFAULT_CLIENT_NAME, redirectUri, scopes } = {}) {
  const endpoint = requireEndpoint(asMeta, 'registration_endpoint', 'a registration_endpoint (server is not DCR-capable)')
  if (!redirectUri) throw new Error('dcrRegister requires a redirectUri')

  // A minimal, spec-correct registration body. We register a NATIVE/public client doing the auth-code flow:
  //   - redirect_uris: our loopback callback (the only one we will ever present).
  //   - grant_types / response_types: authorization_code (+ refresh_token so the AS will issue refresh tokens).
  //   - token_endpoint_auth_method: 'none' is the right default for a public PKCE client. If the AS issues a
  //     client_secret anyway (confidential client), the caller carries it forward to exchange/refresh; both
  //     code paths send the secret only when present, so either shape works.
  const body = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  }
  // scope is space-delimited per RFC 7591; only send it when the caller asked for specific scopes.
  if (scopes) body.scope = normalizeScopes(scopes)

  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  })
  const { json, text } = await readJsonResponse(res)
  if (!res.ok || !json || !json.client_id) {
    throw new Error(`DCR failed at ${redactUrl(endpoint)} (HTTP ${res.status}): ${oauthError(json, text)}`)
  }
  // Pass through the full registration where useful; callers store client_id (+ secret if present).
  return {
    client_id: json.client_id,
    client_secret: json.client_secret || undefined,
    client_id_issued_at: json.client_id_issued_at,
    client_secret_expires_at: json.client_secret_expires_at,
    registration_client_uri: json.registration_client_uri,
    registration_access_token: json.registration_access_token
  }
}

// scopes may arrive as a string ("a b c") or an array (["a","b"]). Always emit the space-delimited string.
function normalizeScopes(scopes) {
  if (Array.isArray(scopes)) return scopes.filter(Boolean).join(' ')
  return String(scopes || '').trim()
}

// ---------------------------------------------------------------------------------------------------------
// Authorization request — build the URL with PKCE S256 + a random state (+ resource when given).
// Returns {url, verifier, state}; the caller MUST keep verifier+state to exchange the code and to validate
// the redirect's `state` (CSRF). startLoopback's armAuthorize does that validation for you.
// ---------------------------------------------------------------------------------------------------------

export function buildAuthorizeUrl({ asMeta, clientId, scopes, redirectUri, resource } = {}) {
  const authorizeEndpoint = requireEndpoint(asMeta, 'authorization_endpoint', 'an authorization_endpoint')
  if (!clientId) throw new Error('buildAuthorizeUrl requires a clientId')
  if (!redirectUri) throw new Error('buildAuthorizeUrl requires a redirectUri')

  const verifier = makeVerifier()
  const state = makeState()
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challengeS256(verifier),
    code_challenge_method: 'S256'
  })
  const scope = normalizeScopes(scopes)
  if (scope) params.set('scope', scope)
  // RFC 8707 resource indicator — binds the issued token to the MCP endpoint so it can't be replayed elsewhere.
  if (resource) params.set('resource', resource)

  const sep = authorizeEndpoint.includes('?') ? '&' : '?'
  return { url: authorizeEndpoint + sep + params.toString(), verifier, state }
}

// ---------------------------------------------------------------------------------------------------------
// Token endpoint — authorization_code exchange and refresh_token. Both x-www-form-urlencoded (RFC 6749).
// A client_secret is sent ONLY when present (public PKCE client vs confidential client both supported).
// expires_at is an absolute epoch-ms so the token store can decide "is this still live" without re-reading
// expires_in semantics later.
// ---------------------------------------------------------------------------------------------------------

function computeExpiresAt(json) {
  // Prefer expires_in (seconds from now). If absent, leave undefined — the caller treats undefined as "no
  // known expiry" and may proactively refresh. We shave 60s so we refresh before the upstream rejects.
  if (typeof json.expires_in === 'number' && isFinite(json.expires_in)) {
    return Date.now() + Math.max(0, (json.expires_in - 60)) * 1000
  }
  return undefined
}

async function postToken(asMeta, params, { clientSecret } = {}) {
  const tokenEndpoint = requireEndpoint(asMeta, 'token_endpoint', 'a token_endpoint')
  // Confidential clients authenticate the secret. We send it in the body (client_secret_post) since that is
  // what DCR public-or-secret clients accept most widely; PKCE public clients send no secret at all.
  if (clientSecret) params.set('client_secret', clientSecret)

  const res = await fetchWithTimeout(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: params
  })
  const { json, text } = await readJsonResponse(res)
  if (!res.ok || !json || !json.access_token) {
    throw new Error(`token request failed at ${redactUrl(tokenEndpoint)} (HTTP ${res.status}): ${oauthError(json, text)}`)
  }
  return json
}

export async function exchangeCode({ asMeta, clientId, clientSecret, code, verifier, redirectUri, resource } = {}) {
  if (!clientId) throw new Error('exchangeCode requires a clientId')
  if (!code) throw new Error('exchangeCode requires a code')
  if (!verifier) throw new Error('exchangeCode requires the PKCE verifier')
  if (!redirectUri) throw new Error('exchangeCode requires the redirectUri (must match the authorize request)')

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier
  })
  if (resource) params.set('resource', resource)

  const json = await postToken(asMeta, params, { clientSecret })
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || undefined,
    expires_at: computeExpiresAt(json),
    token_type: json.token_type || 'Bearer',
    scope: json.scope || undefined
  }
}

export async function refresh({ asMeta, clientId, clientSecret, refresh_token, resource } = {}) {
  if (!clientId) throw new Error('refresh requires a clientId')
  if (!refresh_token) throw new Error('refresh requires a refresh_token')

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token,
    client_id: clientId
  })
  // RFC 8707 §2.2: the resource indicator SHOULD be sent on refresh too, so the newly issued access token keeps
  // the same audience binding as the original. An AS that enforces resource indicators would otherwise return a
  // refreshed token without the audience the MCP endpoint expects, causing the next call to 401.
  if (resource) params.set('resource', resource)

  const json = await postToken(asMeta, params, { clientSecret })
  return {
    access_token: json.access_token,
    // Refresh-token ROTATION: some servers return a new refresh_token on each refresh; carry it through so
    // the store rotates. When absent, the caller keeps the old one (it stays valid).
    refresh_token: json.refresh_token || undefined,
    expires_at: computeExpiresAt(json),
    token_type: json.token_type || 'Bearer',
    scope: json.scope || undefined
  }
}

// ---------------------------------------------------------------------------------------------------------
// Loopback authorize — TWO-PHASE so the registered redirect_uri EXACTLY equals the one used at authorize +
// exchange (RFC 8252 §7.3 only RECOMMENDS port-insensitive loopback matching; strict ASes do exact matching).
//
//   startLoopback()  → binds 127.0.0.1 on an ephemeral port, returns {redirectUri, armAuthorize, waitForTokens, cancel}.
//     redirectUri    : the concrete http://127.0.0.1:<port>/ — the caller registers THIS exact URI via DCR.
//     armAuthorize() : after DCR, build the PKCE authorize URL bound to redirectUri + arm the one-shot listener.
//     waitForTokens(): resolves once the redirect lands, state (CSRF) validates, and the code is exchanged.
//     cancel()       : tear the listener down (e.g. DCR failed before arming).
//
// The listener is bound up front (so the port is known for DCR) but only ACTS once armAuthorize has set the
// verifier/state; a stray request before arming gets a 503 and the wait keeps running.
// ---------------------------------------------------------------------------------------------------------

export async function startLoopback() {
  const server = http.createServer()
  let settle // resolves/rejects the tokens promise; set below.
  let done = false
  let timer = null
  // Set by armAuthorize — the listener can only complete a flow once these are populated.
  let armed = null // { asMeta, clientId, clientSecret, resource, verifier, state }

  const tokensPromise = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  // A no-op consumer so a rejection never floats as an unhandledRejection when the caller cancelled WITHOUT ever
  // calling waitForTokens() (e.g. DCR failed before arming). The real caller still gets the rejection via the
  // promise returned from waitForTokens(); this swallows ONLY the dangling reference, not the caller's.
  tokensPromise.catch(() => {})

  // Always tear the listener down exactly once, on success, error, timeout, or cancel.
  function shutdown() {
    if (done) return
    done = true
    if (timer) clearTimeout(timer)
    try {
      server.close()
    } catch {
      // already closing
    }
  }
  // Explicit cancel (e.g. DCR failed before arming): tear down AND settle the wait so nothing awaits forever.
  function cancel() {
    const wasDone = done
    shutdown()
    if (!wasDone) settle.reject(new Error('loopback authorization cancelled'))
  }

  // Listen first so we know the port (loopback-only; never 0.0.0.0).
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : null
  if (!port) {
    shutdown()
    throw new Error('failed to bind a loopback port for the OAuth redirect')
  }
  const redirectUri = `http://127.0.0.1:${port}/`

  server.on('request', async (req, res) => {
    // Ignore favicon and any stray probe; only the redirect with our params matters.
    let reqUrl
    try {
      reqUrl = new URL(req.url, redirectUri)
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    const params = reqUrl.searchParams
    const gotCode = params.get('code')
    const gotState = params.get('state')
    const gotError = params.get('error')

    // Some browsers fetch /favicon.ico against the loopback; answer 204 and keep waiting for the real redirect.
    if (!gotCode && !gotError) {
      res.writeHead(204).end()
      return
    }

    // A redirect arrived before the authorize URL was armed (we never handed one out, so this is stray) —
    // tell the browser we're not ready and keep waiting for the real one.
    if (!armed) {
      res.writeHead(503).end('not ready')
      return
    }

    // CSRF: the returned state MUST equal the one we generated. A mismatch means a forged/replayed redirect.
    if (gotState !== armed.state) {
      respondHtml(res, 400, 'Authorization failed', 'State mismatch. You can close this tab and try again.')
      shutdown()
      settle.reject(new Error('OAuth state mismatch (possible CSRF) — authorization rejected'))
      return
    }

    if (gotError) {
      const desc = params.get('error_description') || ''
      respondHtml(res, 400, 'Authorization denied', escapeHtml([gotError, desc].filter(Boolean).join(': ')))
      shutdown()
      settle.reject(new Error(`authorization denied: ${[gotError, desc].filter(Boolean).join(': ')}`))
      return
    }

    // We have a code + a matching state. Exchange it for tokens (SAME redirectUri as registered+authorized), resolve.
    try {
      const tokens = await exchangeCode({ asMeta: armed.asMeta, clientId: armed.clientId, clientSecret: armed.clientSecret, code: gotCode, verifier: armed.verifier, redirectUri, resource: armed.resource })
      respondHtml(res, 200, 'BlitzOS connected', 'Authorization complete. You can close this tab and return to BlitzOS.')
      shutdown()
      settle.resolve(tokens)
    } catch (e) {
      respondHtml(res, 500, 'Authorization failed', escapeHtml(e?.message || String(e)))
      shutdown()
      settle.reject(e instanceof Error ? e : new Error(String(e)))
    }
  })

  // If the server errors AFTER we started listening (rare), fail the wait rather than hang.
  server.on('error', (e) => {
    shutdown()
    settle.reject(e instanceof Error ? e : new Error(String(e)))
  })

  // Phase 2: build the PKCE authorize URL bound to the already-known redirectUri and start the approval clock.
  function armAuthorize({ asMeta, clientId, clientSecret, scopes, resource } = {}) {
    if (!clientId) throw new Error('armAuthorize requires a clientId')
    const { url: authUrl, verifier, state } = buildAuthorizeUrl({ asMeta, clientId, scopes, redirectUri, resource })
    armed = { asMeta, clientId, clientSecret, resource, verifier, state }
    // Start the human-approval timeout only once the URL is actually out (not during DCR).
    timer = setTimeout(() => {
      shutdown()
      settle.reject(new Error(`authorization timed out after ${LOOPBACK_TIMEOUT_MS}ms (no browser redirect received)`))
    }, LOOPBACK_TIMEOUT_MS)
    return authUrl
  }

  return { redirectUri, armAuthorize, waitForTokens: () => tokensPromise, cancel }
}

function respondHtml(res, status, title, message) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;max-width:420px;padding:32px}.card h1{font-size:18px;font-weight:600;margin:0 0 8px}.card p{font-size:14px;color:#aaa;margin:0}</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p></div></body></html>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// ---------------------------------------------------------------------------------------------------------
// Streamable-HTTP MCP client — initialize → notifications/initialized → tools/list → tools/call.
// Transport rules (MCP streamable HTTP):
//   - POST JSON-RPC to the endpoint.
//   - Accept: 'application/json, text/event-stream' (the server may answer either way).
//   - The server returns an mcp-session-id header on initialize; we CAPTURE it and ECHO it on every later
//     request. Parse BOTH an SSE body ('data: {...}' lines) and a plain application/json body.
// ---------------------------------------------------------------------------------------------------------

let rpcSeq = 0
function nextId() {
  rpcSeq += 1
  return rpcSeq
}

// A transport-level HTTP failure carrying the response status, so a caller can branch on a 401 (token revoked
// / invalid) to drive a reactive refresh-and-retry instead of surfacing a hard error. Plain Error subclass.
function httpStatusError(message, status) {
  const e = new Error(message)
  e.status = status
  return e
}

// One JSON-RPC round-trip. Returns {status, sessionId, message} where message is the parsed JSON-RPC object
// (or null for a 202/empty notification ack). Throws on transport failure or an HTTP error with a body; an
// HTTP-error throw carries `.status` so callers can detect a 401 (revoked/invalid token → reactive refresh).
async function mcpPost(endpoint, body, { accessToken, session, timeoutMs = HTTP_TIMEOUT_MS } = {}) {
  if (!endpoint) throw new Error('mcp request requires an endpoint')
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION
  }
  if (accessToken) headers.authorization = `Bearer ${accessToken}`
  if (session) headers['mcp-session-id'] = session

  const res = await fetchWithTimeout(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs)
  const sessionId = res.headers.get('mcp-session-id') || null
  const text = await res.text()

  // A notification (no id) is acked with 202 + empty body; nothing to parse.
  if (!text || res.status === 202) {
    if (!res.ok) throw httpStatusError(`MCP request failed (HTTP ${res.status})`, res.status)
    return { status: res.status, sessionId, message: null }
  }

  const message = parseMcpBody(text, res.headers.get('content-type') || '')
  if (!res.ok) {
    // Surface an HTTP-level failure with whatever the server said (including a JSON-RPC error if it sent one).
    const detail = message?.error ? jsonRpcErrorText(message.error) : text.slice(0, 300)
    throw httpStatusError(`MCP request failed (HTTP ${res.status}): ${detail}`, res.status)
  }
  if (!message) {
    throw new Error(`MCP response was not parseable: ${text.slice(0, 200)}`)
  }
  return { status: res.status, sessionId, message }
}

// Parse a streamable-HTTP MCP response body. SSE bodies are a sequence of "event:"/"data:" lines; the JSON-RPC
// message is on one or more 'data:' lines (a single event may split its data across lines, which are joined).
// A plain JSON body is parsed directly. We return the LAST complete JSON-RPC object found (a tool result is one
// message; if the server streamed progress events first, the final data event is the result/response).
function parseMcpBody(text, contentType) {
  const trimmed = text.trim()
  // Plain JSON path: either advertised, or the body simply starts with { or [.
  if (contentType.includes('application/json') || (!contentType.includes('text/event-stream') && (trimmed.startsWith('{') || trimmed.startsWith('[')))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // fall through to SSE parsing in case the content-type lied
    }
  }

  // SSE path: split into events on blank lines, collect each event's data lines, JSON.parse, keep the last
  // object that carries a JSON-RPC payload (has an id/result/error, or is a notification we can ignore).
  let last = null
  const events = trimmed.split(/\r?\n\r?\n/)
  for (const ev of events) {
    const dataLines = []
    for (const line of ev.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line)
      if (m) dataLines.push(m[1])
    }
    if (!dataLines.length) continue
    const payload = dataLines.join('\n').trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const obj = JSON.parse(payload)
      // Keep responses (have id) over server-initiated notifications, but remember the latest either way.
      if (obj && (obj.id !== undefined || obj.result !== undefined || obj.error !== undefined)) last = obj
      else if (last == null) last = obj
    } catch {
      // a non-JSON data line (e.g. a keepalive comment) — skip it
    }
  }
  if (last != null) return last

  // Last resort: maybe it was JSON after all.
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function jsonRpcErrorText(err) {
  if (!err) return 'unknown JSON-RPC error'
  const parts = []
  if (err.code !== undefined) parts.push(`code ${err.code}`)
  if (err.message) parts.push(err.message)
  if (err.data) parts.push(typeof err.data === 'string' ? err.data : JSON.stringify(err.data))
  return parts.join(': ') || 'unknown JSON-RPC error'
}

// initialize → returns {session, result}. Captures the mcp-session-id and sends the required
// notifications/initialized follow-up (echoing the session) so the server marks the session ready.
export async function mcpInitialize(endpoint, accessToken) {
  const { sessionId, message } = await mcpPost(endpoint, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: DEFAULT_CLIENT_NAME, version: '1' }
    }
  }, { accessToken })

  if (message?.error) {
    throw new Error(`MCP initialize error: ${jsonRpcErrorText(message.error)}`)
  }

  // Per the MCP 2025-06-18 lifecycle the client MUST send notifications/initialized after a successful
  // initialize, BEFORE any other request — this is a protocol-layer mandate, INDEPENDENT of the streamable-HTTP
  // session-id (a session-id is a transport concern; the handshake is not). So we send it UNCONDITIONALLY,
  // echoing the session only when the server issued one. A stateless/session-less server that still enforces
  // the lifecycle would otherwise reject tools/list and tools/call on an un-initialized session. A 202/empty
  // ack is expected; a hard transport failure surfaces (we never silently skip the required notification).
  try {
    await mcpPost(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, { accessToken, session: sessionId || undefined })
  } catch (e) {
    throw new Error(`MCP initialized notification failed: ${e?.message || e}`)
  }

  return { session: sessionId, result: message?.result }
}

// tools/list → returns the tools array ([{name, description, inputSchema}, ...]). Echoes the session.
export async function mcpListTools(endpoint, accessToken, session) {
  const { message } = await mcpPost(endpoint, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/list',
    params: {}
  }, { accessToken, session })

  if (message?.error) {
    throw new Error(`MCP tools/list error: ${jsonRpcErrorText(message.error)}`)
  }
  const tools = message?.result?.tools
  return Array.isArray(tools) ? tools : []
}

// tools/call → returns the raw JSON-RPC result object ({content, isError, ...}). We do NOT swallow an
// isError result into a fake success — the honesty rule: the caller surfaces the real effect. A JSON-RPC
// transport error throws; a tool-level error comes back in result.isError for the caller to relay truthfully.
export async function mcpCallTool(endpoint, accessToken, session, name, args) {
  if (!name) throw new Error('mcpCallTool requires a tool name')
  const { message } = await mcpPost(endpoint, {
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: { name, arguments: args || {} }
  }, { accessToken, session, timeoutMs: MCP_CALL_TIMEOUT_MS })

  if (message?.error) {
    throw new Error(`MCP tools/call(${name}) error: ${jsonRpcErrorText(message.error)}`)
  }
  return message?.result
}
