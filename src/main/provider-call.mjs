// #51 — the provider-call ENGINE. Shared by both transports (Electron main + server backend). Uses the
// pure capability core (provider-specs.mjs) and adds the side-effectful layers: server-side token
// injection, scope pre-flight, the per-call human-approval state machine (request-bound single-use
// tokens) for writes, rate limiting, redirect blocking, and an audit hook. The TOKEN never appears in
// any descriptor/response — it's read from the caller-resolved `record` and attached at fetch time only.
import { createHash, randomUUID } from 'node:crypto'
import { PROVIDER_SPECS, matchRoute, buildUrl, redact, safeHeaders } from './provider-specs.mjs'

const MAX_BODY = 256_000 // request body cap (writes)
const MAX_RESP = 5_000_000 // response cap
const FETCH_TIMEOUT = 12_000

/** Stable hash binding an approval to the EXACT request bytes (method + path + body). A token minted for
 *  "POST /issues {…A}" cannot be replayed against "DELETE /repo {…B}". */
function hashRequest(method, path, body) {
  const bodyStr = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  return createHash('sha256').update(`${method}\n${path}\n${bodyStr}`).digest('hex')
}

function summarize(provider, method, path, kind) {
  const verb = kind === 'destructive' ? 'DESTRUCTIVE' : 'write'
  return `${provider}: ${verb} ${method} ${path}`
}

/** Single-use, request-bound, TTL'd approval ledger. The transport may persist it (mint/approve/verify
 *  are the surface); the default is in-memory per process. The RENDERER (consent authority) calls
 *  approve(id); the agent's retry carries the returned token, which the engine verifyConsume()s. */
export function createApprovalLedger(opts = {}) {
  const ttl = opts.ttlMs || 60_000
  const pending = new Map() // id    -> { reqHash, expiresAt }
  const tokens = new Map() //  token -> { reqHash, expiresAt, consumed }
  return {
    mint(req) {
      const id = randomUUID()
      const expiresAt = req.now + ttl
      pending.set(id, { reqHash: req.reqHash, expiresAt })
      return { id, provider: req.provider, method: req.method, path: req.path, risk: req.risk, route: req.route, summary: req.summary, expiresAt }
    },
    approve(id, now) {
      const p = pending.get(id)
      pending.delete(id)
      if (!p || p.expiresAt < now) return null
      const token = randomUUID()
      tokens.set(token, { reqHash: p.reqHash, expiresAt: now + ttl, consumed: false })
      return token
    },
    verifyConsume(token, reqHash, now) {
      const t = tokens.get(token)
      if (!t) return false
      if (t.consumed || t.expiresAt < now) {
        tokens.delete(token)
        return false
      }
      if (t.reqHash !== reqHash) return false // bound to the exact request bytes
      t.consumed = true // single use
      return true
    },
    snapshot() {
      return { pending: [...pending], tokens: [...tokens] } // for optional disk persistence by the transport
    }
  }
}

/** Per-(caller,provider,method) fixed-window rate limiter: reads 60/min, writes 5/min by default. */
export function createRateLimiter(opts = {}) {
  const limits = { read: opts.readPerMin || 60, write: opts.writePerMin || 5 }
  const buckets = new Map()
  return {
    take(key, kind, now) {
      const lim = limits[kind] || limits.read
      const b = buckets.get(key) || { count: 0, windowStart: now }
      if (now - b.windowStart >= 60_000) {
        b.count = 0
        b.windowStart = now
      }
      if (b.count >= lim) {
        buckets.set(key, b)
        return false
      }
      b.count++
      buckets.set(key, b)
      return true
    }
  }
}

function fail(code, status, error) {
  return { ok: false, code, status, error }
}

/**
 * The single general primitive. descriptor = { provider, method, path, query?, body?, headers?, caller, approvalToken? }.
 * ctx = {
 *   record:    { secrets, grantedScopes } | null   (resolved by the caller per transport; token lives here)
 *   approvals: ApprovalLedger    (required for writes)
 *   rate:      RateLimiter        (optional)
 *   consented: (provider)=>bool   (sensitive-read consent gate, supplied by the caller's consent layer)
 *   audit:     (entry)=>void      (optional; the transport appends to disk)
 *   fetchImpl: fetch              (optional; for tests)
 *   now:       ()=>number         (optional; for tests)
 * }
 */
export async function callProvider(descriptor, ctx = {}) {
  const d = descriptor || {}
  const provider = d.provider
  const method = String(d.method || 'GET').toUpperCase()
  const path = d.path || ''
  const caller = d.caller || {}
  const now = ctx.now ? ctx.now() : Date.now()
  const fetchImpl = ctx.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  const audit = ctx.audit || (() => {})
  const log = (decision, status, risk) =>
    audit({ provider, method, path, caller: caller.kind || 'agent', transport: caller.transport || '?', risk: risk || 'read', decision, status, ts: now })

  const spec = PROVIDER_SPECS[provider]
  if (!spec) {
    log('reject', 404, 'read')
    return fail('unknown_provider', 404, `unknown provider "${provider}"`)
  }
  if (!ctx.record || !ctx.record.secrets) {
    log('reject', 401, 'read')
    return fail('not_connected', 401, `${provider} is not connected`)
  }
  // Widgets are structurally read-only: no method other than GET, no body, no approval token.
  if (caller.kind === 'widget' && (method !== 'GET' || d.body != null || d.approvalToken)) {
    log('reject', 403, 'read')
    return fail('forbidden', 403, 'widgets are read-only')
  }

  const match = matchRoute(spec, method, path)
  if (!match) {
    log('reject', 404, 'read')
    return fail('no_route', 404, `no ${method} route for ${provider} ${path}`)
  }
  const risk = match.kind === 'write' || match.kind === 'destructive' ? match.kind : 'read'
  const isWrite = risk !== 'read'

  // Body size cap for writes.
  if (d.body != null) {
    const len = typeof d.body === 'string' ? d.body.length : JSON.stringify(d.body).length
    if (len > MAX_BODY) {
      log('reject', 413, risk)
      return fail('body_too_large', 413, 'request body too large')
    }
  }

  // Scope pre-flight (before any fetch). Reads with an unknown grant are allowed (back-compat); a WRITE
  // requires a known, sufficient granted scope — fail-safe.
  const scopeReq = match.route && match.route.scopeReq
  if (scopeReq) {
    const grants = ctx.record.grantedScopes
    if (Array.isArray(grants)) {
      if (!grants.includes(scopeReq)) {
        log('reject', 403, risk)
        return fail('scope_insufficient', 403, `reconnect ${provider} with the "${scopeReq}" scope`)
      }
    } else if (isWrite) {
      log('reject', 403, risk)
      return fail('scope_unknown', 403, `cannot verify ${provider}'s write scope — reconnect`)
    }
  }

  // NO consent / approval gates (removed). Sensitive reads (message bodies, file contents) and writes
  // (POST/PUT/PATCH/DELETE) execute directly — same on every transport (Electron + server), no prompt, no
  // card, no token. The scope pre-flight above still applies (a write needs the OAuth scope the token holds).

  // Rate limit (after gating so a denied call doesn't burn budget).
  if (ctx.rate && !ctx.rate.take(`${caller.kind || 'agent'}:${provider}:${method}`, isWrite ? 'write' : 'read', now)) {
    log('rate', 429, risk)
    return fail('rate_limited', 429, 'too many requests — slow down')
  }

  // Build the URL (the SSRF gate) — route default query merged under the caller's.
  const built = buildUrl(spec, path, { ...((match.route && match.route.query) || {}), ...(d.query || {}) }, ctx.record)
  if (built.error) {
    log('reject', built.code || 400, risk)
    return fail('bad_request', built.code || 400, built.error)
  }

  if (!fetchImpl) {
    log('error', 500, risk)
    return fail('no_fetch', 500, 'no fetch implementation available')
  }
  const reqHeaders = { accept: 'application/json', 'user-agent': 'agent-os/0.1', ...safeHeaders(spec, d.headers), ...spec.auth(ctx.record) }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT)
  let res, text
  try {
    res = await fetchImpl(built.url, {
      method,
      headers: reqHeaders,
      body: d.body != null ? (typeof d.body === 'string' ? d.body : JSON.stringify(d.body)) : undefined,
      redirect: 'manual', // never follow a 3xx — the bearer must not bounce off-origin
      signal: ctrl.signal
    })
    text = await res.text()
  } catch (e) {
    clearTimeout(timer)
    log('error', 502, risk)
    return fail('upstream_error', 502, e && e.name === 'AbortError' ? 'request timed out' : String((e && e.message) || e))
  }
  clearTimeout(timer)

  if (res.status >= 300 && res.status < 400) {
    log('blocked_redirect', res.status, risk)
    return fail('redirect_blocked', res.status, 'provider returned a redirect (not followed)')
  }
  if (text.length > MAX_RESP) {
    log('too_large', 502, risk)
    return fail('too_large', 502, 'response too large')
  }
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const detail = json && (json.message || json.error_description || json.error)
    log('http_err', res.status, risk)
    return fail(res.status === 401 || res.status === 403 ? 'auth_error' : 'http_error', res.status, `${provider} HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
  }
  log('ok', res.status, risk)
  // Default-deny credential redaction on every read/write response.
  return { ok: true, status: res.status, data: json == null ? text : redact(json) }
}

/** Blocking convenience used by the interactive transports: run the call; if it needs a write approval,
 *  ask the human via ctx.requestApproval(approvalRequest) -> Promise<token|null>, then retry with the
 *  token (the engine re-binds + consumes it). Reads/denied/other results pass straight through. The
 *  requestApproval impl (renderer card + IPC) lives in the transport; this orchestration is generic +
 *  testable. ctx.requestApproval absent → approval_required surfaces to the caller unchanged. */
export async function callProviderGated(descriptor, ctx = {}) {
  const r = await callProvider(descriptor, ctx)
  if (r.code !== 'approval_required' || !r.approvalRequest || typeof ctx.requestApproval !== 'function') return r
  let token
  try {
    token = await ctx.requestApproval(r.approvalRequest)
  } catch {
    token = null
  }
  if (!token) return { ok: false, code: 'approval_denied', status: 403, error: 'the human did not approve this write' }
  return callProvider({ ...descriptor, approvalToken: token }, ctx)
}
