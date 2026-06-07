// #51 — the provider capability table + the SSRF-safe path→URL core, shared by both transports
// (Electron main + the server backend), like control-core/perception-core. This module is PURE (no
// fetch, no tokens, no I/O) so the entire SSRF boundary is unit/fuzz-testable in isolation.
//
// It replaces the closed (provider,resource)→URL allowlist (widget-catalog.mjs PROVIDER_DATA) with a
// CAPABILITY TABLE: per provider, broad READ path-prefix patterns (so the agent can request whatever
// it needs) + a few enumerated, risk-tagged WRITE routes (human-gated by the engine). The token is NEVER
// here — auth() returns the header the engine fills from the caller-resolved record at fetch time.
//
// Security model lives in three layers, all enforced here:
//   1) baseUrl is OS-constructed, never caller-supplied.
//   2) the caller's `path` is validated + matched against a pattern (it fills slots, never the URL string).
//   3) the built URL's host/protocol/userinfo are RE-ASSERTED against the provider's literal host list.

// ---- normalize helpers for the seed resources (ported verbatim from widget-catalog PROVIDER_DATA so
// the back-compat shim produces byte-identical { items } output) ----
const normGithubRepos = (json) =>
  Array.isArray(json)
    ? json.map((r) => ({
        label: r.full_name || r.name,
        sub: r.description || undefined,
        badge: r.private ? 'private' : r.stargazers_count ? `★ ${r.stargazers_count}` : undefined,
        url: r.html_url
      }))
    : null
const normDiscordGuilds = (json) =>
  Array.isArray(json)
    ? json.map((g) => ({
        label: g.name,
        sub: g.owner ? 'owner' : undefined,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : undefined,
        url: `https://discord.com/channels/${g.id}`
      }))
    : null

/**
 * PROVIDER_SPECS[provider] = {
 *   hosts:    string[]   // the ONLY hosts the built URL may resolve to (the SSRF allowlist)
 *   apiBase:  string | (record)=>string   // OS-constructed base (jira needs the cloudId from the record)
 *   auth:     (record)=>({ [header]: value })   // the auth header the engine injects (token from record)
 *   headers:  string[]   // caller-supplied request headers allowed through (lower-case)
 *   reads:    string[]   // GET path-prefix patterns ( :param = one non-empty segment ); broad on purpose
 *   sensitive:string[]   // read prefixes that need explicit consent even for the agent (message bodies, etc.)
 *   routes:   Route[]    // exact (method,path) routes — resources (GET, used by the shim) + writes (gated)
 * }
 * Route = { name, method, path, query?, resource?, scopeReq?, risk?: 'write'|'destructive', normalize? }
 */
export const PROVIDER_SPECS = {
  github: {
    hosts: ['api.github.com'],
    apiBase: 'https://api.github.com',
    auth: (rec) => ({ authorization: `Bearer ${rec?.secrets?.access_token || ''}` }),
    headers: ['accept', 'content-type', 'x-github-api-version'],
    reads: ['/user', '/users/:user', '/repos/:owner/:repo', '/orgs/:org', '/notifications', '/search/:kind', '/gists'],
    sensitive: ['/repos/:owner/:repo/contents'],
    routes: [
      // seed resource (was PROVIDER_DATA.github.repos) — kept GET + byte-identical normalize for the shim
      { name: 'repos', method: 'GET', path: '/user/repos', query: { per_page: '50', sort: 'updated' }, resource: true, scopeReq: 'repo', normalize: normGithubRepos },
      // enumerated writes (gated by the engine; unreachable until reconnect grants the scope)
      { name: 'create-issue', method: 'POST', path: '/repos/:owner/:repo/issues', risk: 'write', scopeReq: 'repo' },
      { name: 'comment-issue', method: 'POST', path: '/repos/:owner/:repo/issues/:n/comments', risk: 'write', scopeReq: 'repo' },
      { name: 'delete-repo', method: 'DELETE', path: '/repos/:owner/:repo', risk: 'destructive', scopeReq: 'delete_repo' }
    ]
  },
  discord: {
    hosts: ['discord.com'],
    apiBase: 'https://discord.com/api/v10',
    auth: (rec) => ({ authorization: `Bearer ${rec?.secrets?.access_token || ''}` }),
    headers: ['accept', 'content-type'],
    reads: ['/users/@me', '/users/@me/guilds', '/users/@me/connections'],
    sensitive: [],
    routes: [{ name: 'guilds', method: 'GET', path: '/users/@me/guilds', resource: true, normalize: normDiscordGuilds }]
  },
  gmail: {
    hosts: ['gmail.googleapis.com', 'www.googleapis.com'],
    apiBase: 'https://gmail.googleapis.com',
    auth: (rec) => ({ authorization: `Bearer ${rec?.secrets?.access_token || ''}` }),
    headers: ['accept', 'content-type'],
    reads: ['/gmail/v1/users/me/messages', '/gmail/v1/users/me/threads', '/gmail/v1/users/me/labels', '/gmail/v1/users/me/profile'],
    sensitive: ['/gmail/v1/users/me/messages/:id', '/gmail/v1/users/me/threads/:id'], // message/thread BODIES
    routes: [{ name: 'send', method: 'POST', path: '/gmail/v1/users/me/messages/send', risk: 'write', scopeReq: 'https://www.googleapis.com/auth/gmail.send' }]
  },
  slack: {
    hosts: ['slack.com'],
    apiBase: 'https://slack.com/api',
    // Slack stores the USER token under authed_user (integrations.ts:211), not the top-level access_token.
    auth: (rec) => ({ authorization: `Bearer ${rec?.secrets?.authed_user?.access_token || rec?.secrets?.access_token || ''}` }),
    headers: ['accept', 'content-type'],
    reads: ['/conversations.list', '/conversations.history', '/users.info', '/users.list', '/auth.test'],
    sensitive: ['/conversations.history'],
    routes: [{ name: 'post-message', method: 'POST', path: '/chat.postMessage', risk: 'write', scopeReq: 'chat:write' }]
  },
  jira: {
    hosts: ['api.atlassian.com'],
    // base needs the cloudId captured at connect (integrations.ts:240).
    apiBase: (rec) => (rec?.secrets?.cloudId ? `https://api.atlassian.com/ex/jira/${rec.secrets.cloudId}` : ''),
    auth: (rec) => ({ authorization: `Bearer ${rec?.secrets?.access_token || ''}` }),
    headers: ['accept', 'content-type'],
    reads: ['/rest/api/3/search', '/rest/api/3/issue/:key', '/rest/api/3/myself', '/rest/api/3/project'],
    sensitive: [],
    routes: [
      { name: 'create-issue', method: 'POST', path: '/rest/api/3/issue', risk: 'write', scopeReq: 'write:jira-work' },
      { name: 'transition-issue', method: 'POST', path: '/rest/api/3/issue/:key/transitions', risk: 'write', scopeReq: 'write:jira-work' }
    ]
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ALL_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/** Split a path into non-empty segments. */
function segs(p) {
  return p.split('/').filter(Boolean)
}
/** Exact pattern match (same segment count). `:param` matches any one non-empty segment. */
function exactMatch(pattern, path) {
  const ps = segs(pattern)
  const xs = segs(path)
  if (ps.length !== xs.length) return false
  return ps.every((s, i) => (s.startsWith(':') ? xs[i].length > 0 : s === xs[i]))
}
/** Prefix pattern match: the pattern's segments are a prefix of the path's (so reads are broad). */
function prefixMatch(pattern, path) {
  const ps = segs(pattern)
  const xs = segs(path)
  if (xs.length < ps.length) return false
  return ps.every((s, i) => (s.startsWith(':') ? xs[i].length > 0 : s === xs[i]))
}

/** Validate a caller-supplied PROVIDER-RELATIVE path. Returns an error string, or null if safe. */
export function validatePath(path) {
  if (typeof path !== 'string' || path.length === 0) return 'path required'
  if (!path.startsWith('/')) return 'path must start with "/"'
  if (path.startsWith('//')) return 'protocol-relative path not allowed'
  if (path.includes('?') || path.includes('#')) return 'pass query via the query object, not in the path'
  if (path.includes('@') || path.includes('\\')) return 'illegal character in path'
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return 'control character in path'
  }
  let dec = path
  try {
    dec = decodeURIComponent(path)
  } catch {
    return 'malformed percent-encoding'
  }
  if (path.includes('..') || dec.includes('..') || dec.includes('//') || dec.includes('@') || dec.includes('\\')) return 'path traversal not allowed'
  return null
}

/** Match a (method, path) to a route or a broad read. Returns { kind, route? } or null.
 *  kind: 'resource' (seed GET) | 'read' (broad GET prefix) | 'write' | 'destructive'. */
export function matchRoute(spec, method, path) {
  if (!spec || !ALL_METHODS.has(method)) return null
  for (const r of spec.routes || []) {
    if (r.method === method && exactMatch(r.path, path)) {
      return { kind: r.risk || (r.resource ? 'resource' : 'read'), route: r }
    }
  }
  if (method === 'GET') {
    const sensitive = (spec.sensitive || []).some((p) => prefixMatch(p, path))
    if (sensitive) return { kind: 'read', sensitive: true }
    if ((spec.reads || []).some((p) => prefixMatch(p, path))) return { kind: 'read' }
  }
  return null // unknown write path / unmatched read → rejected (never a constructed arbitrary URL)
}

function resolveApiBase(spec, record) {
  return typeof spec.apiBase === 'function' ? spec.apiBase(record) : spec.apiBase
}

/** Build the absolute URL and RE-ASSERT the host/protocol/userinfo against the provider's allowlist.
 *  Returns { url, host } or { error, code }. This is the final SSRF gate. */
export function buildUrl(spec, path, query, record) {
  const base = resolveApiBase(spec, record)
  if (!base || typeof base !== 'string' || !base.startsWith('https://')) return { error: 'provider base unavailable (reconnect?)', code: 502 }
  const perr = validatePath(path)
  if (perr) return { error: perr, code: 400 }
  let u
  try {
    u = new URL(base.replace(/\/+$/, '') + path)
  } catch {
    return { error: 'could not build url', code: 400 }
  }
  if (u.protocol !== 'https:') return { error: 'non-https blocked', code: 400 }
  if (u.username || u.password) return { error: 'userinfo not allowed in url', code: 400 }
  if (!spec.hosts.includes(u.host)) return { error: `host "${u.host}" is not in this provider's allowlist`, code: 400 }
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (!/^[A-Za-z0-9_.:-]+$/.test(k)) return { error: `bad query key "${k}"`, code: 400 }
      if (v == null) continue
      u.searchParams.set(k, String(v))
    }
  }
  return { url: u.toString(), host: u.host }
}

const TOKEN_KEY_RE = /token|secret|password|authorization|refresh|client_secret|webhook|api[_-]?key/i

/** Default-deny response filter: deep-strip any key that looks like a credential, at any depth, so a
 *  read response (Slack oauth echoes, integration configs, webhook urls) can never leak a token. */
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (TOKEN_KEY_RE.test(k)) continue
      out[k] = redact(val)
    }
    return out
  }
  return v
}

/** Caller-supplied headers, lower-cased + filtered to the provider's allowlist (auth/cookie/host etc.
 *  are dropped, never merged — the engine sets auth itself). */
export function safeHeaders(spec, headers) {
  const out = {}
  if (!headers || typeof headers !== 'object') return out
  const allow = new Set(spec.headers || [])
  for (const [k, v] of Object.entries(headers)) {
    const lk = String(k).toLowerCase()
    if (allow.has(lk) && typeof v === 'string') out[lk] = v
  }
  return out
}

/** The (provider, resource-name) → route lookup the back-compat shim uses (PROVIDER_DATA replacement). */
export function resourceRoute(provider, resourceName) {
  const spec = PROVIDER_SPECS[provider]
  if (!spec) return null
  return (spec.routes || []).find((r) => r.resource && r.name === resourceName) || null
}

/** "provider/resource" strings still servable as the simple data resources (for docs + the shim). */
export function listResourceNames() {
  const out = []
  for (const [p, spec] of Object.entries(PROVIDER_SPECS)) {
    for (const r of spec.routes || []) if (r.resource) out.push(`${p}/${r.name}`)
  }
  return out
}
