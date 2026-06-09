/*
 * Standalone (non-Electron) integrations backend for the browser preview.
 *
 * Mirrors the Electron main-process integration layer (src/main/oauth.ts +
 * integrations.ts + tokenStore.ts) as a plain Node HTTP server so the renderer
 * can do REAL OAuth over `fetch` instead of IPC. The renderer reaches it via the
 * Vite dev-server proxy (`/api` -> here), so everything is same-origin and there
 * is no CORS to fight.
 *
 * Differences from the Electron version (by necessity, off-machine):
 *  - The OAuth redirect comes back to the PUBLIC tunnel callback, not 127.0.0.1.
 *  - The renderer opens the provider authorize URL (no shell.openExternal here).
 *  - Tokens are stored in preview/.tokens.json (gitignored) — NOT the Keychain.
 *
 * Reads the same integrations.config.json (clientId/secret per provider) as the
 * Electron app. A provider with no creds reports configured:false.
 */
import { createServer } from 'node:http'
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { connect } from '@agent-socket/sdk'
import { WebSocketServer } from 'ws'
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, statSync, realpathSync, readdirSync, appendFileSync } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { startBrowserHost } from './browser-host.mjs'
import { controlSession } from '../src/main/control-core.mjs'
// listWidgets/getWidgetSource/saveWidget moved INTO the shared os-tools.mjs registry (server no longer
// references them directly); WIDGET_AUTHORING_MD + the data registry are still used by HTTP routes here.
import { fetchProviderResource, PROVIDER_DATA, WIDGET_AUTHORING_MD } from '../src/main/widget-catalog.mjs'
// #51 general provider-access substrate (the agent makes whatever request it needs; token stays here).
import { callProvider, createApprovalLedger, createRateLimiter } from '../src/main/provider-call.mjs'
// Widget tool bridge — the CLOSED allowlist a sandboxed widget may call via blitz.tool (shared with Electron).
import { makeWidgetToolRunner, makeWidgetToolHandlers } from '../src/main/widget-tools.mjs'
// The ONE shared agent tool registry — the SAME module Electron's relay + localhost transports bind. The server
// supplies its own primitive ops (broadcast + headless-Chromium) so there is no server/Electron tool difference.
import { makeOsTools } from '../src/main/os-tools.mjs'
import { capturedScopes } from '../src/main/provider-specs.mjs'
// Shared perception kernel + resident brain — the SAME modules the Electron main runs,
// so server mode gets the autonomy loop with no duplicated code.
// waitForEvents/latestSeq/redactMoment/EVENTS_REMINDER/isContentShared are consumed INSIDE the shared
// os-tools.mjs registry now (same module instance) — backend.mjs keeps only what its own HTTP routes + ingest use.
import {
  ingestSignals,
  setContentShare,
  emitUserMessage,
  emitSurfaceAction,
  INJECT,
  DRAIN
} from '../src/main/perception-core.mjs'
import { startAgentRunner } from '../src/main/agent-runner.mjs'
import { createWorkspaceHost } from '../src/main/workspace-host.mjs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..') // BlitzOS package root

const PORT = Number(process.env.BACKEND_PORT || 8787)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
const REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/callback`
const UA = 'agent-os-preview/0.1'

// Workspaces: a ROOT folder holds many workspace folders. Default root is a gitignored sandbox dir.
// Back-compat: BLITZ_WORKSPACE (a single folder) sets root = its parent + initial = its basename;
// BLITZ_WORKSPACES_ROOT overrides the root directly. The active-workspace RUNTIME (hydrate / persist /
// watch+reconcile / switch / list / create / thumbnail) lives in the SHARED workspace host (created
// below, once `broadcast` + `reconcileSurfaces` exist) — the SAME module Electron main uses, so
// there is one implementation and no drift.
const WORKSPACES_ROOT = process.env.BLITZ_WORKSPACES_ROOT
  ? resolve(process.env.BLITZ_WORKSPACES_ROOT)
  : process.env.BLITZ_WORKSPACE
    ? dirname(resolve(process.env.BLITZ_WORKSPACE))
    : join(ROOT, 'preview', '.workspace')
const INITIAL_WS = process.env.BLITZ_WORKSPACE ? basename(resolve(process.env.BLITZ_WORKSPACE)) : 'Home'

// ---------- provider registry (ported from src/main/integrations.ts) ----------

const REGISTRY = [
  {
    id: 'gmail', name: 'Gmail', color: '#EA4335',
    helpUrl: 'https://console.cloud.google.com/apis/credentials',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
    usePkce: true, extra: { access_type: 'offline', prompt: 'consent' }
  },
  {
    id: 'github', name: 'GitHub', color: '#6e7681',
    helpUrl: 'https://github.com/settings/developers',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    scope: 'read:user repo', usePkce: true
  },
  {
    id: 'slack', name: 'Slack', color: '#4A154B',
    helpUrl: 'https://api.slack.com/apps',
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    scope: 'channels:history,groups:history,users:read', scopeParam: 'user_scope'
  },
  {
    id: 'jira', name: 'Jira', color: '#0052CC',
    helpUrl: 'https://developer.atlassian.com/console/myapps/',
    authorizeUrl: 'https://auth.atlassian.com/authorize',
    scope: 'read:jira-work read:jira-user offline_access',
    extra: { audience: 'api.atlassian.com', prompt: 'consent' }
  },
  {
    id: 'discord', name: 'Discord', color: '#5865F2',
    helpUrl: 'https://discord.com/developers/applications',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    scope: 'identify guilds'
  }
]
const defFor = (id) => REGISTRY.find((d) => d.id === id)
function helpText(d) {
  return `One-time: register an OAuth app at ${d.name}, set its redirect/callback URL to ${REDIRECT_URI}, then put ${d.id}.clientId + ${d.id}.clientSecret in integrations.config.json.`
}

// ---------- config + token store ----------

function loadConfig() {
  for (const p of [join(ROOT, 'integrations.config.json'), join(process.cwd(), 'integrations.config.json')]) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) } catch { /* ignore malformed */ }
  }
  return {}
}
const credsFor = (id) => loadConfig()[id] ?? {}

const TOKENS_FILE = join(__dirname, '.tokens.json')
function readTokens() { try { return JSON.parse(readFileSync(TOKENS_FILE, 'utf8')) } catch { return {} } }
function writeTokens(t) { writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2)) }

function statuses() {
  const toks = readTokens()
  return REGISTRY.map((d) => {
    const c = credsFor(d.id)
    const rec = toks[d.id]
    return {
      id: d.id, name: d.name, color: d.color, helpUrl: d.helpUrl, helpText: helpText(d),
      connected: !!rec, label: rec?.label ?? null, configured: !!(c.clientId && c.clientSecret)
    }
  })
}

// ---------- oauth helpers (ported from src/main/oauth.ts) ----------

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const pending = new Map() // state -> { id, codeVerifier }

function buildAuthorizeUrl(d, clientId, state, codeVerifier) {
  const u = new URL(d.authorizeUrl)
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', REDIRECT_URI)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set(d.scopeParam ?? 'scope', d.scope)
  u.searchParams.set('state', state)
  if (d.usePkce && codeVerifier) {
    u.searchParams.set('code_challenge', base64url(createHash('sha256').update(codeVerifier).digest()))
    u.searchParams.set('code_challenge_method', 'S256')
  }
  for (const [k, v] of Object.entries(d.extra ?? {})) u.searchParams.set(k, v)
  return u.toString()
}

async function postForm(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': UA }, body: new URLSearchParams(body) })
  return r.json()
}
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA }, body: JSON.stringify(body) })
  return r.json()
}
async function getJson(url, token) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': UA } })
  return r.json()
}

// Exchange the authorization code for a token + fetch an identity label.
// One branch per provider, ported verbatim from integrations.ts::connectProvider.
async function exchangeProvider(id, clientId, clientSecret, code, codeVerifier) {
  if (id === 'gmail') {
    const tok = await postForm('https://oauth2.googleapis.com/token', { code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code', code_verifier: codeVerifier })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const me = await getJson('https://openidconnect.googleapis.com/v1/userinfo', tok.access_token)
    return { label: me.email || 'google account', secrets: tok }
  }
  if (id === 'github') {
    const tok = await postForm('https://github.com/login/oauth/access_token', { client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code', code_verifier: codeVerifier })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const me = await getJson('https://api.github.com/user', tok.access_token)
    return { label: me.login || 'github user', secrets: tok }
  }
  if (id === 'slack') {
    const tok = await postForm('https://slack.com/api/oauth.v2.access', { client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT_URI })
    if (!tok.ok) throw new Error(`Slack: ${String(tok.error || 'oauth failed')}`)
    const authed = tok.authed_user || {}
    if (!authed.access_token) throw new Error('Slack returned no user token')
    const team = tok.team || {}
    return { label: `${String(authed.id || 'user')} @ ${String(team.name || 'workspace')}`, secrets: tok }
  }
  if (id === 'jira') {
    const tok = await postJson('https://auth.atlassian.com/oauth/token', { grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, code, redirect_uri: REDIRECT_URI })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const resources = await getJson('https://api.atlassian.com/oauth/token/accessible-resources', tok.access_token)
    const site = Array.isArray(resources) ? resources[0] : undefined
    return { label: site?.name || 'jira site', secrets: { ...tok, cloudId: site?.id, siteUrl: site?.url } }
  }
  if (id === 'discord') {
    const tok = await postForm('https://discord.com/api/oauth2/token', { client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
    if (!tok.access_token) throw new Error(String(tok.error_description || tok.error || 'token exchange failed'))
    const me = await getJson('https://discord.com/api/v10/users/@me', tok.access_token)
    return { label: me.username || 'discord user', secrets: tok }
  }
  throw new Error(`no flow for ${id}`)
}

// ---------- HTTP server ----------

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const FILE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json', csv: 'text/csv', html: 'text/html; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' }
const fileContentType = (p) => FILE_MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'
const callbackPage = (title, sub) =>
  `<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,system-ui;background:#0e1116;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><h2 style="margin:0 0 8px">${title}</h2><p style="color:#8b949e;margin:0">${sub}</p></div><script>try{window.opener&&window.opener.postMessage({type:'agentos:oauth'},'*')}catch(e){}setTimeout(function(){window.close()},1400)</script></body>`

// ---------- OS bridge: surface model over SSE (browser preview) ----------
// Mirrors src/main/{osActions,agentSocket}.ts, but pushes agent actions to the
// renderer over Server-Sent Events instead of Electron IPC. In-window control
// (CDP) is NOT available here — that needs the real Electron app + a <webview>.
let osState = { surfaces: [] }
// Boot-hydrated from the active workspace by the shared host (wsHost.hydrateOnBoot(), created below
// after broadcast + reconcileSurfaces exist). The renderer adopts it via a `hydrate` on SSE connect.
let agentUrl = null
const sseClients = new Set()
// Widget data consent: `${surfaceId}:${provider}` the human approved (via the
// renderer prompt). The data route 403s until the pair is here — a widget can't
// read an integration the user hasn't allowed for that surface.
const consentGranted = new Set()
// Coarse per-(surface,provider,resource) min-interval, so a runaway widget can't
// hammer a provider API (burning the user's rate limit). Best-effort, in-memory.
const lastFetch = new Map()
// #51: shared state for the general /provider_call substrate. providerConsent gates SENSITIVE agent
// reads (message bodies, repo contents) per provider — the human grants once via /api/os/provider-consent.
const providerConsent = new Set()
const providerApprovals = createApprovalLedger() // writes are refused in server mode, but the ledger is shared for parity
const providerRate = createRateLimiter()
const PROVIDER_AUDIT_LOG = join(__dirname, 'provider-audit.log')
const providerAudit = (e) => {
  try {
    appendFileSync(PROVIDER_AUDIT_LOG, JSON.stringify(e) + '\n')
  } catch {
    /* best-effort audit */
  }
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// ---------- SERVER MODE: live web surfaces via a headless browser ----------
// When BLITZ_SERVER_MODE=1, a server-side headless Chromium renders each `web`
// surface as a real top-level page (bypasses X-Frame-Options) and streams JPEG
// frames to the renderer's <canvas> over the /api/os/stream WS; CDP control
// (surface_control) becomes available, driven by the SHARED control-core.
const SERVER_MODE = process.env.BLITZ_SERVER_MODE === '1'
let host = null
const streamClients = new Set() // open /api/os/stream WebSockets
// Last screencast frame per surface id. A web page screencasts on CHANGE, so a STATIC page (e.g. a loaded
// news site) emits its frames once — at boot, before any renderer is connected — then goes quiet. Without a
// cache, a renderer that connects later (or after a workspace switch) shows a BLANK canvas until the page
// repaints. We replay the last frame to every newly-connected stream client so a hydrated web surface paints
// immediately.
const lastFrame = new Map() // surfaceId -> base64 jpeg

async function initServerMode() {
  if (!SERVER_MODE) return
  try {
    host = await startBrowserHost({
      chromiumPath: process.env.CHROMIUM,
      onFrame: (id, data) => {
        lastFrame.set(id, data) // cache for replay to late-connecting renderers (static pages emit once)
        const msg = JSON.stringify({ t: 'frame', id, data }) // base64 jpeg (binary framing = future opt)
        for (const ws of streamClients) {
          try {
            ws.send(msg)
          } catch {
            /* client gone */
          }
        }
      }
    })
    console.log('[agent-os backend] SERVER MODE on — web surfaces are live + CDP-controllable')
    // Perception parity: inject the SAME in-page sensors (INJECT) into each server
    // browser target via CDP and drain them into the SAME moment coalescer, so server
    // mode produces the moment stream over /events. The connected agent is the brain;
    // BlitzOS ships NO in-process decision logic.
    startServerPerception()
    // Phase 2: spin up server targets for any web surfaces restored from the workspace, so a
    // hydrated canvas is live even before a renderer connects + pushes.
    try {
      reconcileSurfaces(osState.surfaces)
    } catch {
      /* best-effort */
    }
  } catch (e) {
    console.error('[agent-os backend] SERVER MODE failed to start headless browser:', e?.message || e)
  }
}

// Per-surface sensor capture over CDP: evaluate INJECT (idempotent; re-installs after a
// navigation because the page reset the flag) then DRAIN, feeding raw signals to the
// shared coalescer. A supervisor keeps the capture intervals in sync with live targets.
const captureIntervals = new Map()
function ensureServerCapture(id) {
  if (!host || captureIntervals.has(id)) return
  const iv = setInterval(async () => {
    if (!host || !host.has(id)) {
      clearInterval(iv)
      captureIntervals.delete(id)
      return
    }
    try {
      const s = host.session(id)
      await s.send('Runtime.evaluate', { expression: INJECT, returnByValue: true })
      const r = await s.send('Runtime.evaluate', { expression: DRAIN, returnByValue: true })
      const raw = r?.result?.value
      if (Array.isArray(raw) && raw.length) ingestSignals(id, raw)
    } catch {
      /* target not ready / gone — the supervisor will clean up */
    }
  }, 350)
  captureIntervals.set(id, iv)
}
function startServerPerception() {
  setInterval(() => {
    if (!host) return
    for (const id of host.ids()) ensureServerCapture(id)
    for (const id of [...captureIntervals.keys()]) {
      if (!host.has(id)) {
        clearInterval(captureIntervals.get(id))
        captureIntervals.delete(id)
      }
    }
  }, 1000)
}

// The same-site gate for the mutating workspace routes. The server has no per-route auth and (in
// the demo) is reachable on a PUBLIC tunnel, so reject cross-site requests: a drive-by page must
// not switch/create the operator's workspaces. Same-origin (the renderer), localhost, and
// non-browser callers (no Origin / Sec-Fetch-Site) pass.
// NOTE: the localhost-origin allowance is closed by Sec-Fetch-Site on modern browsers (a cross-port
// localhost page sends Sec-Fetch-Site: cross-site → rejected at the check below). On a browser that
// omits Sec-Fetch-Site, a local page on another port could slip through; accepted for the prototype
// (kept so local dev, where the page origin differs from PUBLIC_BASE_URL, still works). Tighten to
// PUBLIC_BASE_URL-only before GA.
function sameSiteOnly(req) {
  const sfs = req.headers['sec-fetch-site']
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false
  const o = req.headers.origin
  if (o) {
    try {
      const og = new URL(o).origin
      if (og !== new URL(PUBLIC_BASE_URL).origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(og)) return false
    } catch {
      return false
    }
  }
  return true
}

// (The atomic workspace SWITCH now lives in the shared workspace host — wsHost.performSwitch, created
// below — so server mode + Electron share one implementation.)

// Reconcile the host's live targets with the web surfaces the renderer reports
// (covers both agent- and human-created surfaces, since both land in os:state).
// Returns a promise resolving when all target spin-ups/tear-downs settle — the SWITCH awaits it so
// an overlapping switch can't run teardown against a stale host.ids() snapshot (stranding a target).
// The steady-state callers (reconcile, initServerMode, POST state) ignore the promise — fine.
function reconcileSurfaces(list) {
  if (!host) return Promise.resolve()
  const want = new Set(list.filter((x) => x && x.kind === 'web').map((x) => x.id))
  const ps = []
  for (const sfc of list) {
    if (sfc.kind !== 'web') continue
    if (!host.has(sfc.id)) {
      ps.push(
        host
          .createSurface(sfc.id, { url: sfc.url || 'about:blank', width: Math.round(sfc.w) || 1280, height: Math.round(sfc.h) || 800 })
          .catch((e) => console.error('[server mode] createSurface', sfc.id, e?.message || e))
      )
    } else {
      // Existing web surface — keep its render viewport + screencast matched to the window size so a
      // resize doesn't stretch the stream (host.resize debounces + no-ops when the size is unchanged).
      ps.push(Promise.resolve(host.resize(sfc.id, Math.round(sfc.w) || 1280, Math.round(sfc.h) || 800)).catch(() => {}))
    }
  }
  for (const id of host.ids()) {
    if (!want.has(id)) ps.push(host.closeSurface(id).catch(() => {}))
  }
  return Promise.all(ps)
}
function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`
  for (const r of sseClients) {
    try {
      r.write(data)
    } catch {
      /* client gone */
    }
  }
}

// The SHARED workspace host: single owner of the active-workspace runtime (hydrate / persist /
// watch+reconcile / switch / list / create / thumbnail), used HERE and by Electron main (osActions).
// Server-only adapter bits: broadcast over SSE; realize web surfaces via reconcileSurfaces (headless
// targets — Electron passes a no-op since the renderer owns its <webview>s).
const wsHost = createWorkspaceHost({
  root: WORKSPACES_ROOT,
  initialName: INITIAL_WS,
  getState: () => osState,
  setState: (s) => {
    osState = s
  },
  broadcast,
  onSurfaces: (surfaces) => (SERVER_MODE ? reconcileSurfaces(surfaces) : undefined),
  defaultMode: 'canvas'
})
wsHost.hydrateOnBoot()

// #53: restore the human's persisted consent for the active workspace (so grants survive a restart).
// Re-run after a switch (loadConsent) to swap to the new workspace's grants.
function loadConsent() {
  consentGranted.clear()
  providerConsent.clear()
  const c = wsHost.consent()
  for (const s of c.surfaces) consentGranted.add(s)
  for (const p of c.providers) providerConsent.add(p)
}
function saveConsent() {
  wsHost.persistConsent({ surfaces: [...consentGranted], providers: [...providerConsent] })
}
loadConsent()

// Lazily-built widget-tool dispatcher (server transport). Mirrors the relay tool handlers — server-minted
// ids, broadcast to renderers, host target ops — but only for the CLOSED widget allowlist (widget-tools.mjs).
// Closures bind the live module vars at call time (requests arrive after init), so ordering is moot.
let _widgetToolRunner = null
function widgetToolRunner() {
  if (_widgetToolRunner) return _widgetToolRunner
  // Same CLOSED widget allowlist + handler logic as Electron (src/main/widgets.ts), bound to the SAME serverOps
  // the agent registry uses. One definition → the widget `blitz.tool` contract can't drift between desktop and
  // server (the divergence the consolidation audit found: id-as-{id}, validation, list_state shape, group errors).
  _widgetToolRunner = makeWidgetToolRunner(makeWidgetToolHandlers(serverOps))
  return _widgetToolRunner
}

function toolBody(body) {
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    return {}
  }
}

// One source of truth (the SAME .md the Electron relay serves): src/main/blitzos-agents.md.
const OS_AGENTS_MD = readFileSync(new URL('../src/main/blitzos-agents.md', import.meta.url), 'utf8')
// Fill the doc's {{CONNECTORS}} placeholder with the live wired/unwired line (mirror of integrations.ts).
function injectConnectors(md) {
  const nameOf = (s) => String(s.name || s.id || '?')
  const all = statuses()
  const conn = all.filter((s) => s.connected).map(nameOf)
  const off = all.filter((s) => !s.connected).map(nameOf)
  const parts = []
  if (conn.length) parts.push(`Connected: ${conn.join(', ')}`)
  if (off.length) parts.push(`Not connected: ${off.join(', ')}`)
  return md.replace('{{CONNECTORS}}', parts.join(' · ') || 'No connectors registered.')
}

// Tools whose calls are surfaced in the on-screen "Agent activity" log, so the user can
// SEE what the agent is doing during reply latency (polls/reads like /events, list_state,
// list_widgets are excluded as noise).
const ACTIVITY_TOOLS = new Set([
  '/open_window', '/create_surface', '/update_surface', '/move_surface', '/close_surface',
  '/surface_control', '/read_window', '/spawn_widget', '/save_widget', '/say', '/go_to_primary'
])

/** A short human label for an agent tool call, for the activity feed. */
function activityText(path, a) {
  a = a || {}
  const host = (u) => { try { return new URL(u).hostname } catch { return String(u || '').slice(0, 40) } }
  const sid = (id) => (id ? String(id).slice(0, 6) : '')
  switch (path) {
    case '/open_window': return `↗ open ${host(a.url)}`
    case '/create_surface': return `+ ${a.kind || 'surface'}${a.url ? ' ' + host(a.url) : ''}${a.component ? ' ' + a.component : ''}`
    case '/update_surface': return `✎ update ${sid(a.id)}${a.url ? ' → ' + host(a.url) : ''}`
    case '/move_surface': return `⇄ move ${sid(a.id)}`
    case '/close_surface': return `✕ close ${sid(a.id)}`
    case '/surface_control': return `⌖ ${a.action?.action || 'control'}${a.action?.selector ? ' ' + a.action.selector : ''}`
    case '/read_window': return `👁 read page ${sid(a.id)}`
    case '/spawn_widget': return `▣ widget ${a.name || ''}`
    case '/save_widget': return `💾 save widget ${a.name || ''}`
    case '/say': return '💬 replying'
    case '/go_to_primary': return '⌂ recenter'
    default: return path.replace(/^\//, '')
  }
}

/** Wrap action-tool handlers to broadcast an activity event (before running) so the
 *  on-screen Agent-activity panel shows what the agent is doing in real time. */
function withActivity(tools) {
  return tools.map((t) => {
    if (!ACTIVITY_TOOLS.has(t.path)) return t
    const orig = t.handler
    return {
      ...t,
      handler: (ctx) => {
        try { broadcast({ type: 'activity', at: Date.now(), text: activityText(t.path, toolBody(ctx?.body)) }) } catch {}
        return orig(ctx)
      }
    }
  })
}

// The server's binding of the SHARED tool registry (os-tools.mjs) — the primitive operations every shared
// handler calls. Same registry as Electron (agentSocket.ts / control-server.ts), different ops: broadcast over
// SSE + a headless-Chromium target instead of IPC+CDP. This is what makes "no server/Electron difference" hold —
// ONE definition of every tool's path/description/schema/handler; only these ~20 primitives differ per runtime.
const serverOps = {
  createSurface: (a) => {
    const id = randomUUID() // OS-mint (an untrusted caller must not pick an id to inherit a consent grant / clobber a file)
    // The agent opened this surface itself (it chose the url) — auto-share web/app so it can read what it opened.
    // (Surfaces the USER opens stay private until shared — the P0 confused-deputy gate; this does not weaken it.)
    if (a.kind === 'web' || a.kind === 'app') setContentShare(id, true)
    broadcast({ type: 'create', surface: { ...a, id } })
    if (SERVER_MODE && host && a.kind === 'web' && !host.has(id)) {
      host.createSurface(id, { url: a.url || 'about:blank', width: Math.round(Number(a.w)) || 1280, height: Math.round(Number(a.h)) || 800 }).catch(() => {})
    }
    return id
  },
  openWindow: (a) => {
    const id = randomUUID()
    setContentShare(id, true) // the agent opened this page — it can read what it opened
    broadcast({ type: 'create', surface: { kind: 'web', ...a, id } })
    if (SERVER_MODE && host && !host.has(id)) {
      host.createSurface(id, { url: a.url, width: Math.round(Number(a.w)) || 1280, height: Math.round(Number(a.h)) || 800 }).catch(() => {})
    }
    return id
  },
  moveSurface: (id, x, y) => broadcast({ type: 'move', id: String(id), x: Number(x), y: Number(y) }),
  updateSurface: (id, patch) => {
    const i = String(id)
    broadcast({ type: 'update', id: i, patch })
    if (SERVER_MODE && host && host.has(i) && typeof patch.url === 'string') host.navigate(i, patch.url).catch(() => {})
  },
  closeSurface: (id) => {
    const i = String(id)
    broadcast({ type: 'close', id: i })
    for (const k of consentGranted) if (k.startsWith(`${i}:`)) consentGranted.delete(k)
    if (SERVER_MODE && host) host.closeSurface(i).catch(() => {})
    wsHost.closeSurfaceFile(i) // delete the backing content file so it doesn't resurrect (no-renderer agent close)
  },
  goToPrimary: () => broadcast({ type: 'goToPrimary' }),
  // Raw full state (workspace identity threaded in). The shared os-tools list_state handler whittles this down
  // to layout fields via serializeStateForAgent — SAME on Electron (osGetState) — so html/transcript never leak
  // and both transports return an identical shape. Don't whitelist HERE or the two would diverge again.
  getState: () => ({ ...osState, workspace: wsHost.active(), workspace_path: wsHost.activePath() }),
  // siblings as OBJECTS {id,title,kind} — the shared create_surface handler filters out the new id then maps to titles.
  workspaceContext: () => ({
    workspace: wsHost.active(),
    workspace_path: wsHost.activePath(),
    siblings: (osState.surfaces || []).map((s) => ({ id: s.id, title: s.title, kind: s.kind }))
  }),
  listWorkspaces: () => {
    const activePath = wsHost.activePath()
    const root = activePath ? activePath.replace(/[/\\][^/\\]+$/, '') : ''
    return {
      workspaces: wsHost.list().map(({ name, nodeCount, updatedAt }) => ({ name, nodeCount, updatedAt, path: root ? `${root}/${name}` : '' })),
      active: wsHost.active(),
      activePath,
      root
    }
  },
  createWorkspace: (name) => {
    try {
      return { ok: true, name: wsHost.create(String(name)).name }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  },
  switchWorkspace: async (name) => {
    const r = await wsHost.performSwitch(String(name))
    return r.status === 200 ? { ok: true, active: r.body.active } : { ok: false, error: (r.body && r.body.error) || 'switch failed' }
  },
  readWindow: async (id, _script) => {
    // No raw eval over the relay (confused-deputy on a logged-in session) — the shared handler already drops
    // `script` for non-localhost transports, so server never evals. Safe DOM read only.
    if (!SERVER_MODE || !host || !host.has(id)) throw new Error('read_window needs server mode (or the desktop app); this surface has no server browser target')
    const r = await controlSession(host.session(id), { action: 'read' })
    if (!r.ok) throw new Error(r.error)
    return r.result
  },
  controlSurface: async (id, action) => {
    if (!SERVER_MODE || !host || !host.has(id)) return { ok: false, error: 'in-window control needs server mode (BLITZ_SERVER_MODE=1) or the desktop app; this surface has no server browser target' }
    return controlSession(host.session(id), action)
  },
  say: (text) => wsHost.appendChat('agent', String(text)), // append to chat.md + broadcast the transcript to the chat widget
  customizeWidget: (name, html) => wsHost.customizeWidget(String(name), String(html)),
  systemUi: (name) => wsHost.systemUi(String(name)),
  groupIntoFolder: (name, ids, x, y, kind) => {
    // Normalize to { ok, ... } like Electron's osGroupIntoFolder — wsHost.group returns a bare { error } (no ok)
    // on failure, so without this the agent saw { error } on server vs { ok:false, error } on Electron (parity bug).
    const r = wsHost.group(String(name || 'Folder'), ids, Number(x) || 0, Number(y) || 0, kind === 'board' ? 'board' : 'folder')
    return r && 'ok' in r ? r : { ok: false, error: (r && r.error) || 'could not group' }
  },
  providerCall: (descriptor) => {
    const toks = readTokens()
    const t = toks[descriptor.provider]
    const record = t ? { secrets: t.secrets, grantedScopes: t.grantedScopes } : null
    return callProvider(
      { ...descriptor, caller: { kind: 'agent', transport: 'server' } },
      { record, approvals: providerApprovals, rate: providerRate, consented: (p) => providerConsent.has(p), audit: providerAudit }
    )
  },
  integrationStatuses: () => statuses(),
  connectedProviders: () => Object.keys(readTokens())
}

async function startOsAgentSocket() {
  try {
    const session = await connect({
      appId: process.env.AGENT_SOCKET_APP_ID || 'as_app_anon',
      baseUrl: process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev',
      appDescription: 'BlitzOS (browser preview): an agent OS desktop — open and arrange surfaces on an infinite canvas.',
      agentsMd: injectConnectors(OS_AGENTS_MD),
      // The ONE shared registry, server-bound (serverOps). Same paths/descriptions/schemas/handlers as Electron;
      // mapped to the agent-socket tool shape. transport:relay — the server is untrusted like the relay (no
      // localhost trust), so the few security branches behave identically. Add/change a tool in os-tools.mjs once.
      tools: withActivity(
        makeOsTools(serverOps).map((t) => ({
          path: t.path,
          description: t.description,
          ...(t.input_schema ? { input_schema: t.input_schema } : {}),
          handler: ({ body }) => t.handler({ body: body || '', transport: 'relay' })
        }))
      )
    })
    const link = await session.mintAgentToken({ label: 'blitzos-preview' })
    agentUrl = link.url
    broadcast({ __agentUrl: agentUrl })
    console.log('[agent-os backend] agent-socket paste URL (drive the preview from any AI chat):\n  ' + agentUrl)
  } catch (e) {
    console.error('[agent-os backend] agent-socket connect failed (canvas + integrations still work):', e?.message || e)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', PUBLIC_BASE_URL)
  const path = url.pathname

  if (path === '/api/health') return json(res, 200, { ok: true, redirectUri: REDIRECT_URI })
  if (path === '/api/integrations' && req.method === 'GET') return json(res, 200, statuses())

  // POST /api/integrations/:id/start  -> { authorizeUrl } | { error, needsConfig }
  let m = path.match(/^\/api\/integrations\/([a-z]+)\/start$/)
  if (m && req.method === 'POST') {
    const d = defFor(m[1])
    if (!d) return json(res, 404, { error: 'unknown provider' })
    const c = credsFor(d.id)
    if (!c.clientId || !c.clientSecret) {
      return json(res, 200, { error: `Add ${d.id}.clientId and ${d.id}.clientSecret to integrations.config.json`, needsConfig: true })
    }
    const state = base64url(randomBytes(16))
    const codeVerifier = d.usePkce ? base64url(randomBytes(32)) : undefined
    pending.set(state, { id: d.id, codeVerifier })
    return json(res, 200, { authorizeUrl: buildAuthorizeUrl(d, c.clientId, state, codeVerifier), redirectUri: REDIRECT_URI })
  }

  // POST /api/integrations/:id/disconnect
  m = path.match(/^\/api\/integrations\/([a-z]+)\/disconnect$/)
  if (m && req.method === 'POST') {
    const toks = readTokens(); delete toks[m[1]]; writeTokens(toks)
    return json(res, 200, { ok: true })
  }

  // GET /api/integrations/:provider/:resource?surface=ID -> normalized {items:[...]}
  // The data backend for the widget bridge. CLOSED registry: (provider,resource) must
  // be in PROVIDER_DATA (no caller string builds a URL — SSRF guard). Consent-gated
  // per (surface, provider): 403 until the human approved it in the renderer.
  let dm = path.match(/^\/api\/integrations\/([a-z]+)\/([a-z0-9_-]+)$/)
  if (dm && req.method === 'GET') {
    const [, provider, resource] = dm
    // Own-property check so a resource like "__proto__"/"constructor" can't reach
    // Object.prototype (the registry is closed; only literal entries are valid).
    if (!hasOwn(PROVIDER_DATA, provider) || !hasOwn(PROVIDER_DATA[provider], resource)) {
      return json(res, 404, { error: `unknown data resource ${provider}/${resource}` })
    }
    // No consent gate (removed) — a widget reads its integration data directly. Closed registry + rate-limit remain.
    const surface = url.searchParams.get('surface') || provider
    const rk = `${surface}:${provider}:${resource}`
    const now = Date.now()
    if (now - (lastFetch.get(rk) || 0) < 500) return json(res, 429, { error: 'slow down', code: 'rate_limited' })
    lastFetch.set(rk, now)
    const token = readTokens()[provider]?.secrets?.access_token
    try {
      return json(res, 200, await fetchProviderResource(provider, resource, token))
    } catch (e) {
      return json(res, e?.code || 502, { error: e?.message || 'data fetch failed' })
    }
  }

  // POST /api/os/consent { surfaceId, provider } — the renderer records a human grant.
  if (path === '/api/os/consent' && req.method === 'POST') {
    let cbody = ''
    req.on('data', (c) => { cbody += c; if (cbody.length > 10_000) req.destroy() })
    req.on('end', () => {
      const b = toolBody(cbody)
      if (b && b.surfaceId && b.provider) {
        consentGranted.add(`${String(b.surfaceId)}:${String(b.provider)}`)
        saveConsent() // #53: persist so the grant survives a restart
      }
      json(res, 200, { ok: true })
    })
    return
  }

  // POST /api/os/provider-consent { provider, allow } — the human grants/revokes the agent's SENSITIVE
  // reads (message bodies, file contents) for a provider (#51). Non-sensitive reads never need this.
  if (path === '/api/os/provider-consent' && req.method === 'POST') {
    let cbody = ''
    req.on('data', (c) => {
      cbody += c
      if (cbody.length > 10_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(cbody)
      const provider = String(b.provider || '')
      if (provider) {
        if (b.allow === false) providerConsent.delete(provider)
        else providerConsent.add(provider)
        saveConsent() // #53: persist
      }
      json(res, 200, { ok: true, provider, allowed: providerConsent.has(provider) })
    })
    return
  }

  // POST /api/os/consent/revoke { surfaceId } — drop every grant for a surface
  // (its widget code changed, or it closed). Forces re-approval of the new code.
  if (path === '/api/os/consent/revoke' && req.method === 'POST') {
    let cbody = ''
    req.on('data', (c) => { cbody += c; if (cbody.length > 10_000) req.destroy() })
    req.on('end', () => {
      const sid = String(toolBody(cbody).surfaceId || '')
      if (sid) {
        for (const k of consentGranted) if (k.startsWith(`${sid}:`)) consentGranted.delete(k)
        saveConsent() // #53: persist the revoke
      }
      json(res, 200, { ok: true })
    })
    return
  }

  // GET /api/widget-authoring.md — the bridge-authoring guide (also a tool).
  if (path === '/api/widget-authoring.md' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    return res.end(WIDGET_AUTHORING_MD)
  }

  // GET /api/oauth/callback?code&state -> exchange + store, return a close-me page
  if (path === '/api/oauth/callback' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html' })
    const err = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (err) return res.end(callbackPage('Sign-in failed', String(err)))
    const pend = state && pending.get(state)
    if (!pend || !code) return res.end(callbackPage('Sign-in failed', 'state mismatch or expired — try again'))
    pending.delete(state)
    try {
      const c = credsFor(pend.id)
      const { label, secrets } = await exchangeProvider(pend.id, c.clientId, c.clientSecret, code, pend.codeVerifier)
      const toks = readTokens()
      // Record the granted scopes authoritatively at connect (#51) — the write scope-preflight checks these.
      toks[pend.id] = { provider: pend.id, label, secrets, grantedScopes: capturedScopes(secrets), connectedAt: Date.now() }
      writeTokens(toks)
      console.log(`[agent-os backend] connected ${pend.id} as ${label}`)
      return res.end(callbackPage('Connected ✓', 'You can close this tab and return to Agent OS.'))
    } catch (e) {
      console.error(`[agent-os backend] ${pend.id} exchange failed:`, e?.message || e)
      return res.end(callbackPage('Sign-in failed', String(e?.message || e)))
    }
  }

  // ---- OS bridge routes (surface model) ----
  if (path === '/api/os/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no' // discourage proxy buffering of the stream
    })
    res.write(': connected\n\n')
    if (agentUrl) res.write(`data: ${JSON.stringify({ __agentUrl: agentUrl })}\n\n`)
    // Phase 2: hand the connecting renderer the current canvas so it restores it (and flips
    // its hydrate gate). osState is the persisted-on-boot canvas, or the live one mid-session.
    res.write(
      `data: ${JSON.stringify({ type: 'hydrate', surfaces: osState.surfaces || [], camera: osState.camera || { x: 0, y: 0, scale: 1 }, mode: osState.mode || 'canvas', areaCount: osState.areaCount || 1, workspace: wsHost.active() })}\n\n`
    )
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }
  if (path === '/api/os/state' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => {
      body += c
      if (body.length > 2_000_000) req.destroy()
    })
    req.on('end', () => {
      wsHost.onStatePush(toolBody(body)) // persist (stale-push-guarded) + realize web surfaces
      json(res, 200, { ok: true })
    })
    return
  }
  if (path === '/api/os/agent-url' && req.method === 'GET') return json(res, 200, { url: agentUrl })
  // Serve a real workspace file as a canvas tile's content (#37) — JAILED to the active workspace
  // dir, never .blitzos (runtime/secret state), size-capped. Read-only GET.
  if (path === '/api/os/file' && req.method === 'GET') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    try {
      const root = realpathSync(resolve(wsHost.activePath()))
      // realpath the TARGET too, so a symlink inside the workspace can't escape the jail (blocker).
      const real = realpathSync(resolve(root, url.searchParams.get('path') || ''))
      if (real !== root && !real.startsWith(root + sep)) return json(res, 403, { error: 'forbidden' })
      if (/(^|[/\\])\.blitzos([/\\]|$)/i.test(real.slice(root.length))) return json(res, 403, { error: 'forbidden' })
      const st = statSync(real)
      if (!st.isFile() || st.size > 25 * 1024 * 1024) return json(res, 404, { error: 'not a servable file' })
      const ctype = fileContentType(real)
      // raster images render inline; SVG + everything else is forced to download so it can never run
      // as script on our origin (no stored-XSS via a .svg/.html dropped into the workspace).
      const inlineOk = ctype.startsWith('image/') && ctype !== 'image/svg+xml'
      const buf = readFileSync(real)
      res.writeHead(200, {
        'content-type': ctype,
        'content-length': buf.length,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'content-disposition': inlineOk ? 'inline' : `attachment; filename="${basename(real).replace(/["\\\r\n]/g, '')}"`
      })
      return res.end(buf)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }
  // List a subfolder's contents so a folder tile can OPEN (#44) — jailed to the active workspace,
  // never .blitzos, capped. Read-only.
  if (path === '/api/os/dir' && req.method === 'GET') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    // SHARED listing (workspace.mjs listDir → host.listDir): jailed, dotfiles hidden, capped at 1000 with
    // an honest {total,truncated}. Same impl as the Electron os:dir route, so the file manager matches.
    const r = wsHost.listDir(url.searchParams.get('path') || '')
    return r ? json(res, 200, r) : json(res, 404, { error: 'not found' })
  }
  // Receive a file the user DROPPED onto the canvas (#43): raw body bytes → jailed write into the
  // active workspace at the drop world-position → reconcile so the tile appears where it landed.
  // #52: group surfaces into a REAL folder (mkdir + mv their files into a subdir). Renderer Cmd+G posts here.
  if (path === '/api/os/group' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let gbody = ''
    req.on('data', (c) => {
      gbody += c
      if (gbody.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(gbody)
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : []
      if (!ids.length) return json(res, 400, { error: 'no members to group' })
      const r = wsHost.group(String(b.name || 'Folder'), ids, Number(b.x) || 0, Number(b.y) || 0, b.kind === 'board' ? 'board' : 'folder')
      return json(res, r && r.ok ? 200 : 400, r || { error: 'failed' })
    })
    return
  }
  if (path === '/api/os/upload' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      size += c.length
      if (size > 30 * 1024 * 1024) {
        aborted = true
        req.destroy()
      } else chunks.push(c)
    })
    req.on('aborted', () => (aborted = true))
    req.on('end', () => {
      if (aborted) return json(res, 413, { error: 'file too large (30MB max)' })
      try {
        const name = url.searchParams.get('name') || 'file'
        const x = Number(url.searchParams.get('x')) || 0
        const y = Number(url.searchParams.get('y')) || 0
        // A folder DROP uploads each file with its in-folder subpath (name has a '/') and passes
        // reconcile=0 so the canvas reconciles ONCE after the whole batch (a trailing /api/os/reconcile).
        const doReconcile = url.searchParams.get('reconcile') !== '0'
        const r = wsHost.ingestUpload(name, Buffer.concat(chunks), x, y, doReconcile)
        return json(res, r && r.ok ? 200 : 400, r || { error: 'failed' })
      } catch (e) {
        return json(res, 500, { error: String((e && e.message) || e) })
      }
    })
    req.on('error', () => {
      try {
        json(res, 400, { error: 'bad request' })
      } catch {
        /* response already sent */
      }
    })
    return
  }

  // POST /api/os/reconcile { x, y } — surface the canvas after a DEFERRED folder upload (the client
  // posts each folder file with reconcile=0, then calls this once so the new folder tile appears).
  if (path === '/api/os/reconcile' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let rbody = ''
    req.on('data', (c) => {
      rbody += c
      if (rbody.length > 10_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(rbody)
      const r = wsHost.reconcileAt(Number(b.x) || 0, Number(b.y) || 0)
      return json(res, r && r.ok ? 200 : 400, r || { error: 'failed' })
    })
    return
  }
  // POST /api/os/close-surface { id } — the renderer closed a window; delete its backing content file so
  // it doesn't pop back up on the next reconcile. Explicit by id (a partial push can never mass-delete).
  if (path === '/api/os/close-surface' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let xbody = ''
    req.on('data', (c) => {
      xbody += c
      if (xbody.length > 10_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(xbody)
      const r = wsHost.closeSurfaceFile(String(b.id || ''))
      return json(res, 200, r || { ok: false })
    })
    return
  }
  // POST /api/os/widget-tool { surfaceId, name, args } — a sandboxed widget calls an OS tool via
  // blitz.tool (gated by the `tools` capability in the renderer). Same CLOSED allowlist as Electron
  // (widget-tools.mjs); dispatches through the same primitives the relay tools use. provider_call
  // writes are still hard-refused in server mode (callProvider transport:'server').
  if (path === '/api/os/widget-tool' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let wbody = ''
    req.on('data', (c) => {
      wbody += c
      if (wbody.length > 1_000_000) req.destroy()
    })
    req.on('end', async () => {
      const b = toolBody(wbody)
      const r = await widgetToolRunner()(String(b.name || ''), b.args, { surfaceId: String(b.surfaceId || '') })
      return json(res, r && r.ok ? 200 : 400, r || { ok: false })
    })
    return
  }
  // POST /api/os/new-folder { name, kind, x, y } — "New Folder" (files) / "New Board" (windows+widgets).
  if (path === '/api/os/new-folder' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let nbody = ''
    req.on('data', (c) => {
      nbody += c
      if (nbody.length > 10_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(nbody)
      const r = wsHost.newFolder(String(b.name || 'Folder'), b.kind === 'board' ? 'board' : 'folder', Number(b.x) || 0, Number(b.y) || 0)
      return json(res, r && r.ok ? 200 : 400, r || { error: 'failed' })
    })
    return
  }
  // POST /api/os/surface-action — a sandboxed srcdoc widget fired an action back to the agent (server-mode
  // parity with the Electron os:surface-action IPC; mirrors /api/os/user-message → the moment stream).
  if (path === '/api/os/surface-action' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let sbody = ''
    req.on('data', (c) => {
      sbody += c
      if (sbody.length > 200_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(sbody)
      if (b && typeof b === 'object') {
        const { surfaceId, __blitz, ...action } = b
        void __blitz
        emitSurfaceAction(typeof surfaceId === 'string' ? surfaceId : 'unknown', action)
      }
      return json(res, 200, { ok: true })
    })
    return
  }

  // POST /api/os/content-share { surfaceId, on } — the human toggled "let the agent
  // read this surface" (P0 consent; gates the relay /events snapshot + read_window).
  if (path === '/api/os/content-share' && req.method === 'POST') {
    let cbody = ''
    req.on('data', (c) => { cbody += c; if (cbody.length > 10_000) req.destroy() })
    req.on('end', () => {
      const b = toolBody(cbody)
      if (b && typeof b.surfaceId === 'string') setContentShare(b.surfaceId, !!b.on)
      json(res, 200, { ok: true })
    })
    return
  }

  // POST /api/os/user-message { text } — the user typed to the agent in the Chat panel.
  if (path === '/api/os/user-message' && req.method === 'POST') {
    let cbody = ''
    req.on('data', (c) => { cbody += c; if (cbody.length > 20_000) req.destroy() })
    req.on('end', () => {
      const t = toolBody(cbody).text
      if (typeof t === 'string' && t.trim()) {
        wsHost.appendChat('user', t) // write the user's message to chat.md + echo it to the chat widget
        emitUserMessage(t) // …and wake the agent (trigger:'message' moment, redaction-exempt)
      }
      json(res, 200, { ok: true })
    })
    return
  }

  // ---- Workspaces (the launcher: list / create / switch). Human-UI only — deliberately NOT
  // agent-socket tools (spec §9.9: opening a workspace by name from an agent path is denied).
  // Same-site gated because the server has no per-route auth and runs on a public tunnel.
  if (path === '/api/os/workspaces' && req.method === 'GET') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    // strip the absolute host path — the renderer switches by name; don't leak the on-disk layout.
    const workspaces = wsHost.list().map(({ name, nodeCount, updatedAt, thumbTs }) => ({ name, nodeCount, updatedAt, thumbTs }))
    return json(res, 200, { workspaces, active: wsHost.active() })
  }
  if (path === '/api/os/workspaces' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let cbody = ''
    req.on('data', (c) => { cbody += c; if (cbody.length > 4096) req.destroy() })
    req.on('end', () => {
      try {
        const created = wsHost.create(toolBody(cbody).name)
        json(res, 200, { ok: true, name: created.name })
      } catch (e) {
        const status = e && e.code === 'EEXIST' ? 409 : 400
        json(res, status, { ok: false, error: e?.message || 'create failed' })
      }
    })
    return
  }
  if (path === '/api/os/workspace/switch' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let cbody = ''
    req.on('data', (c) => { cbody += c; if (cbody.length > 4096) req.destroy() })
    req.on('end', async () => {
      try {
        const r = await wsHost.performSwitch(toolBody(cbody).name)
        if (r.status === 200) loadConsent() // #53: swap to the new workspace's persisted consent
        json(res, r.status, r.body)
      } catch (e) {
        console.error('[workspace] switch failed:', e?.message || e)
        json(res, 500, { error: 'switch failed' })
      }
    })
    return
  }

  // POST /api/os/workspace/thumb { workspace, dataUrl } — the renderer uploads a captured snapshot of
  // the primary area (a data:image/jpeg) as that workspace's thumbnail (last-seen, Mission-Control
  // style). Stored at .blitzos/state/thumb.jpg (gitignored, agent-read-denied), overwritten each time.
  if (path === '/api/os/workspace/thumb' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    const tchunks = []
    let tlen = 0
    req.on('data', (c) => { tlen += c.length; if (tlen > 4_000_000) return req.destroy(); tchunks.push(c) }) // 4MB BYTE cap (not UTF-16 units)
    req.on('end', () => {
      try {
        const b = toolBody(Buffer.concat(tchunks).toString('utf8'))
        const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.dataUrl || ''))
        if (!m) return json(res, 400, { error: 'expected a data:image/jpeg;base64 URL' })
        const buf = Buffer.from(m[1], 'base64')
        if (buf.length > 3_000_000) return json(res, 413, { error: 'thumbnail too large' })
        if (!wsHost.writeThumb(b.workspace, buf)) return json(res, 404, { error: 'no such workspace' })
        json(res, 200, { ok: true })
      } catch (e) {
        json(res, 500, { error: e?.message || 'thumb write failed' })
      }
    })
    return
  }
  // GET /api/os/workspace/thumb?name=X — serve the cached primary-area thumbnail (404 if none yet).
  // NOTE: a thumbnail is RENDERED PIXELS of the board (can contain third-party page content), served
  // under the same posture as the other /api/os routes — sameSiteOnly + the tunnel's CF Access gate,
  // no per-route bearer. Tighten to a bearer before any GA / public (non-CF-Access) deploy.
  if (path === '/api/os/workspace/thumb' && req.method === 'GET') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    const buf = wsHost.readThumb(url.searchParams.get('name'))
    if (!buf) return json(res, 404, { error: 'no thumbnail' })
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' })
    return res.end(buf)
  }

  json(res, 404, { error: 'not found' })
})

// /api/os/stream — binary-ish WS carrying screencast frames out (server mode) and
// raw CDP input messages in ({t:'cdp', id, method, params} → that surface's session).
// Methods the renderer may drive over the stream WS. Anything else (Runtime.evaluate,
// Network.*, Page.captureScreenshot, etc.) is rejected so the WS can't be a backdoor for
// arbitrary CDP against a logged-in surface.
const ALLOWED_STREAM_METHODS = new Set([
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Page.navigate',
  'Page.reload'
])
const streamWss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname !== '/api/os/stream') {
    socket.destroy()
    return
  }
  // Reject cross-origin upgrades — a page you happen to visit can't open this WS.
  // Same-origin (the served renderer) and non-browser/loopback clients pass; the
  // method allowlist below is the hard gate on what any client can actually do.
  const origin = req.headers.origin
  let allowOrigin = ''
  try {
    allowOrigin = new URL(PUBLIC_BASE_URL).origin
  } catch {
    /* ignore */
  }
  if (origin && origin !== allowOrigin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    socket.destroy()
    return
  }
  streamWss.handleUpgrade(req, socket, head, (ws) => {
    streamClients.add(ws)
    // Replay the last frame of every live surface so a just-connected renderer paints immediately
    // (a static page won't emit a fresh frame on its own). Only for surfaces the host still has.
    for (const [id, data] of lastFrame) {
      if (host && host.has(id)) {
        try { ws.send(JSON.stringify({ t: 'frame', id, data })) } catch { /* client gone */ }
      } else {
        lastFrame.delete(id)
      }
    }
    ws.on('close', () => streamClients.delete(ws))
    ws.on('message', async (raw) => {
      let m
      try {
        m = JSON.parse(raw.toString())
      } catch {
        return
      }
      // Human input is forwarded as raw CDP — but ONLY input/navigation methods
      // (never Runtime.evaluate / Network.* / screenshot), so this WS can't be an
      // arbitrary-CDP backdoor into a logged-in surface.
      if (m.t === 'cdp' && host && host.has(m.id) && typeof m.method === 'string' && ALLOWED_STREAM_METHODS.has(m.method)) {
        try {
          await host.session(m.id).send(m.method, m.params || {})
        } catch {
          /* target gone */
        }
      }
    })
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agent-os backend] listening on http://127.0.0.1:${PORT}`)
  console.log(`[agent-os backend] OAuth redirect URI to register: ${REDIRECT_URI}`)
  console.log(`[agent-os backend] providers configured: ${statuses().filter((s) => s.configured).map((s) => s.id).join(', ') || '(none — add integrations.config.json)'}`)
  // Connect to the agent-socket relay so a pasted URL can drive the preview.
  startOsAgentSocket()
  // Server mode: bring up the headless browser host for live web surfaces.
  initServerMode()
  // Phase 3: watch the workspace folder so external file edits (agent/Finder/git) reflect live.
  wsHost.startWatch()
  // Boot + supervise the brain: spawn the agent against the live relay URL and keep it
  // alive (auto-restart on exit), so a brain is always watching. Opt-in via BLITZ_AGENT
  // (=claude or a custom command); off by default (continuous LLM use has a cost).
  if (process.env.BLITZ_AGENT) {
    startAgentRunner({ getUrl: () => agentUrl, cmd: process.env.BLITZ_AGENT === '1' ? 'claude' : process.env.BLITZ_AGENT, label: 'server-agent' })
  }
})

// On shutdown, gracefully close the browser so its profile (cookies/localStorage = the
// user's logins) is flushed to disk before we exit. Best-effort + bounded.
let shuttingDown = false
async function gracefulExit() {
  if (shuttingDown) return
  shuttingDown = true
  // Flush a pending workspace write FIRST (before the possibly-slow host.stop), so a surface
  // created/moved right before quit lands on disk — otherwise hydrate restores the stale state.
  wsHost.flush()
  wsHost.stopWatch() // close fs watchers (handle hygiene)
  try {
    if (host) await host.stop()
  } catch {
    /* ignore */
  }
  process.exit(0)
}
process.on('SIGTERM', gracefulExit)
process.on('SIGINT', gracefulExit)
