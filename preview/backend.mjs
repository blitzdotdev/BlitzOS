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
import {
  listWidgets,
  getWidgetSource,
  saveWidget,
  fetchProviderResource,
  PROVIDER_DATA,
  WIDGET_AUTHORING_MD
} from '../src/main/widget-catalog.mjs'
// #51 general provider-access substrate (the agent makes whatever request it needs; token stays here).
import { callProvider, createApprovalLedger, createRateLimiter } from '../src/main/provider-call.mjs'
// Widget tool bridge — the CLOSED allowlist a sandboxed widget may call via blitz.tool (shared with Electron).
import { makeWidgetToolRunner } from '../src/main/widget-tools.mjs'
import { capturedScopes } from '../src/main/provider-specs.mjs'
// Shared perception kernel + resident brain — the SAME modules the Electron main runs,
// so server mode gets the autonomy loop with no duplicated code.
import {
  ingestSignals,
  waitForEvents,
  latestSeq,
  setContentShare,
  isContentShared,
  redactMoment,
  emitUserMessage,
  emitSurfaceAction,
  EVENTS_REMINDER,
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

async function initServerMode() {
  if (!SERVER_MODE) return
  try {
    host = await startBrowserHost({
      chromiumPath: process.env.CHROMIUM,
      onFrame: (id, data) => {
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

// Workspace context returned by create_surface/open_window + list_state — IDENTICAL shape to the Electron
// os-tools.ts handler (no server/Electron difference): which desktop, where the folder is (file-authoring
// hint), and the sibling surface titles (clutter-vs-continuation signal the agent acts on per agents.md).
function serverWorkspaceCtx(excludeId) {
  return {
    workspace: wsHost.active(),
    workspace_path: wsHost.activePath(),
    siblings: (osState.surfaces || []).filter((s) => s.id !== excludeId).map((s) => s.title)
  }
}

// Lazily-built widget-tool dispatcher (server transport). Mirrors the relay tool handlers — server-minted
// ids, broadcast to renderers, host target ops — but only for the CLOSED widget allowlist (widget-tools.mjs).
// Closures bind the live module vars at call time (requests arrive after init), so ordering is moot.
let _widgetToolRunner = null
function widgetToolRunner() {
  if (_widgetToolRunner) return _widgetToolRunner
  _widgetToolRunner = makeWidgetToolRunner({
    create_surface: (a) => {
      if (!a.kind) throw new Error('kind required')
      const id = randomUUID() // OS-mint (a widget must not pick an id to inherit a consent grant)
      if (a.kind === 'web' || a.kind === 'app') setContentShare(id, true)
      broadcast({ type: 'create', surface: { ...a, id } })
      if (SERVER_MODE && host && a.kind === 'web' && !host.has(id)) host.createSurface(id, { url: a.url || 'about:blank', width: Math.round(Number(a.w)) || 1280, height: Math.round(Number(a.h)) || 800 }).catch(() => {})
      return { id }
    },
    open_window: (a) => {
      if (typeof a.url !== 'string') throw new Error('url required')
      const id = randomUUID()
      setContentShare(id, true)
      broadcast({ type: 'create', surface: { kind: 'web', ...a, id } })
      if (SERVER_MODE && host && !host.has(id)) host.createSurface(id, { url: a.url, width: Math.round(Number(a.w)) || 1280, height: Math.round(Number(a.h)) || 800 }).catch(() => {})
      return { id }
    },
    move_surface: (a) => (broadcast({ type: 'move', id: String(a.id), x: Number(a.x), y: Number(a.y) }), { ok: true }),
    update_surface: (a) => {
      const id = String(a.id || '')
      if (!id) throw new Error('id required')
      const patch = { ...a }
      delete patch.id
      broadcast({ type: 'update', id, patch })
      if (SERVER_MODE && host && host.has(id) && typeof a.url === 'string') host.navigate(id, a.url).catch(() => {})
      return { ok: true }
    },
    close_surface: (a) => {
      const id = String(a.id || '')
      broadcast({ type: 'close', id })
      for (const k of consentGranted) if (k.startsWith(`${id}:`)) consentGranted.delete(k)
      if (SERVER_MODE && host) host.closeSurface(id).catch(() => {})
      wsHost.closeSurfaceFile(id)
      return { ok: true }
    },
    group: (a) => {
      const ids = Array.isArray(a.ids) ? a.ids.map(String) : []
      if (!ids.length) throw new Error('no members to group')
      return wsHost.group(String(a.name || 'Folder'), ids, Number(a.x) || 0, Number(a.y) || 0, a.kind === 'board' ? 'board' : 'folder')
    },
    go_to_primary: () => (broadcast({ type: 'goToPrimary' }), { ok: true }),
    list_state: () => ({ ...osState, surfaces: (osState.surfaces || []).map((s) => ({ id: s.id, kind: s.kind, x: s.x, y: s.y, w: s.w, h: s.h, z: s.z, zoom: s.zoom, title: s.title, url: s.url, component: s.component, pinned: s.pinned })) }),
    provider_call: (a) => {
      const toks = readTokens()
      const t = toks[a.provider]
      const record = t ? { secrets: t.secrets, grantedScopes: t.grantedScopes } : null
      return callProvider(
        { provider: String(a.provider || ''), method: a.method, path: String(a.path || ''), query: a.query, body: a.body, approvalToken: a.approvalToken, caller: { kind: 'agent', transport: 'server' } },
        { record, approvals: providerApprovals, rate: providerRate, consented: (p) => providerConsent.has(p), audit: providerAudit }
      )
    }
  })
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

async function startOsAgentSocket() {
  try {
    const session = await connect({
      appId: process.env.AGENT_SOCKET_APP_ID || 'as_app_anon',
      baseUrl: process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev',
      appDescription: 'BlitzOS (browser preview): an agent OS desktop — open and arrange surfaces on an infinite canvas.',
      agentsMd: OS_AGENTS_MD,
      tools: withActivity([
        {
          path: '/create_surface',
          description: 'Create a surface (kind: web | app | srcdoc | native). web/app take url; srcdoc takes html; native takes component+props.',
          input_schema: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { type: 'string', enum: ['web', 'app', 'srcdoc', 'native'] },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              title: { type: 'string' }, url: { type: 'string' }, html: { type: 'string' },
              component: { type: 'string' }, props: { type: 'object' }
            }
          },
          handler: ({ body }) => {
            const a = toolBody(body)
            if (!a.kind) return { status: 400, body: { error: 'kind required' } }
            // srcdoc ids are server-minted: a consent grant is keyed by surface id, so
            // an untrusted caller must not be able to choose one and inherit a grant.
            // Always OS-mint the id (the agent gets it back in the response). Honoring an
            // agent-supplied id let two surfaces collide on one content-file path -> clobber.
            const id = randomUUID()
            // The agent opened this surface itself (it chose the url), so reading it back
            // leaks nothing the agent didn't already pick — auto-share web/app so the agent
            // can read/control what it opened. (Surfaces the USER opens stay private until
            // they share — that's the P0 confused-deputy gate, which this does not weaken.)
            if (a.kind === 'web' || a.kind === 'app') setContentShare(id, true)
            broadcast({ type: 'create', surface: { ...a, id } })
            if (SERVER_MODE && host && a.kind === 'web' && !host.has(id)) {
              host.createSurface(id, { url: a.url || 'about:blank', width: Math.round(a.w) || 1280, height: Math.round(a.h) || 800 }).catch(() => {})
            }
            return { id, ...serverWorkspaceCtx(id) } // same return shape as Electron (agents.md contract)
          }
        },
        {
          path: '/open_window',
          description: 'Open a third-party site as a web surface. Returns its id.',
          input_schema: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, title: { type: 'string' } }
          },
          handler: ({ body }) => {
            const a = toolBody(body)
            if (typeof a.url !== 'string') return { status: 400, body: { error: 'url required' } }
            const id = randomUUID()
            setContentShare(id, true) // the agent opened this page — it can read what it opened
            broadcast({ type: 'create', surface: { kind: 'web', ...a, id } })
            if (SERVER_MODE && host && !host.has(id)) {
              host.createSurface(id, { url: a.url, width: Math.round(a.w) || 1280, height: Math.round(a.h) || 800 }).catch(() => {})
            }
            return { id, ...serverWorkspaceCtx(id) }
          }
        },
        {
          path: '/move_surface',
          description: 'Move a surface to (x, y) world pixels.',
          input_schema: { type: 'object', required: ['id', 'x', 'y'], properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
          handler: ({ body }) => {
            const a = toolBody(body)
            broadcast({ type: 'move', id: String(a.id), x: Number(a.x), y: Number(a.y) })
            return { ok: true }
          }
        },
        {
          path: '/close_surface',
          description: 'Close a surface by id.',
          input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
          handler: ({ body }) => {
            const id = String(toolBody(body).id)
            broadcast({ type: 'close', id })
            for (const k of consentGranted) if (k.startsWith(`${id}:`)) consentGranted.delete(k)
            if (SERVER_MODE && host) host.closeSurface(id).catch(() => {})
            wsHost.closeSurfaceFile(id) // delete the backing content file so it doesn't resurrect (no-renderer agent close)
            return { ok: true }
          }
        },
        { path: '/go_to_primary', description: 'Recenter the view on the primary workspace.', handler: () => { broadcast({ type: 'goToPrimary' }); return { ok: true } } },
        // Workspace control — SAME tools as Electron (os-tools.ts). No server/Electron difference: the agent
        // manages the user's folder-backed desktops here too (auth/login for server mode is a later concern).
        {
          path: '/list_workspaces',
          description:
            "List the user's workspaces (separate folder-backed desktops, each its own folder = its own memory). Returns { workspaces:[{name,nodeCount,updatedAt,path}], active, activePath, root }. CALL THIS FIRST: reason about WHERE the task belongs before building.",
          handler: () => {
            const activePath = wsHost.activePath()
            const root = activePath ? activePath.replace(/[/\\][^/\\]+$/, '') : ''
            return {
              workspaces: wsHost.list().map(({ name, nodeCount, updatedAt }) => ({ name, nodeCount, updatedAt, path: root ? `${root}/${name}` : '' })),
              active: wsHost.active(),
              activePath,
              root
            }
          }
        },
        {
          path: '/create_workspace',
          description: 'Create a NEW empty workspace (a fresh desktop) for an UNRELATED task. Returns { ok, name }. Follow with switch_workspace.',
          input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          handler: ({ body }) => {
            const name = String(toolBody(body).name || '').trim()
            if (!name) return { status: 400, body: { error: 'name required' } }
            try {
              return { ok: true, name: wsHost.create(name).name }
            } catch (e) {
              return { status: 400, body: { error: String((e && e.message) || e) } }
            }
          }
        },
        {
          path: '/switch_workspace',
          description: 'Move the user to a workspace by name (their canvas swaps to that desktop). Use after create_workspace. Returns { ok, active }.',
          input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          handler: async ({ body }) => {
            const name = String(toolBody(body).name || '').trim()
            if (!name) return { status: 400, body: { error: 'name required' } }
            const r = await wsHost.performSwitch(name)
            return r.status === 200 ? { ok: true, active: r.body.active } : { status: r.status, body: r.body }
          }
        },
        {
          path: '/list_state',
          description: 'List the surfaces currently open on the canvas.',
          // Whitelist layout fields only — html + props ride the state push for serialization,
          // but the agent's list_state view must not leak full srcdoc HTML or the chat transcript.
          handler: () => ({
            ...osState,
            workspace: wsHost.active(), // same shape as Electron os-tools list_state (agents.md reads workspace_path)
            workspace_path: wsHost.activePath(),
            surfaces: (osState.surfaces || []).map((s) => ({
              id: s.id,
              kind: s.kind,
              x: s.x,
              y: s.y,
              w: s.w,
              h: s.h,
              z: s.z,
              zoom: s.zoom,
              title: s.title,
              url: s.url,
              component: s.component,
              pinned: s.pinned
            }))
          })
        },
        {
          path: '/provider_call',
          description:
            'Make an authenticated request to a CONNECTED integration (provider) and get the JSON back — ' +
            'use this to build whatever the user needs (their unread mail, repos, issues, messages, …). ' +
            'The OS injects the credential server-side; you NEVER see the token. Reads (GET) are broad: ' +
            'pass any path under the provider\'s API. Writes (POST/PUT/PATCH/DELETE) need a human approval ' +
            'and are unavailable in server mode. Args: {provider, method?, path, query?, body?}. ' +
            'Connected providers + scopes are in list_integrations. A sensitive read (message bodies, file ' +
            'contents) returns code:"consent_required" until the human approves that provider once.',
          input_schema: {
            type: 'object',
            required: ['provider', 'path'],
            properties: {
              provider: { type: 'string' },
              method: { type: 'string' },
              path: { type: 'string', description: 'provider-relative, e.g. /user/repos or /gmail/v1/users/me/messages?…via query' },
              query: { type: 'object' },
              body: {},
              approvalToken: { type: 'string' }
            }
          },
          handler: async ({ body }) => {
            const b = toolBody(body)
            const toks = readTokens()
            const t = toks[b.provider]
            const record = t ? { secrets: t.secrets, grantedScopes: t.grantedScopes } : null
            return callProvider(
              {
                provider: String(b.provider || ''),
                method: b.method,
                path: String(b.path || ''),
                query: b.query,
                body: b.body,
                approvalToken: b.approvalToken,
                caller: { kind: 'agent', transport: 'server' }
              },
              { record, approvals: providerApprovals, rate: providerRate, consented: (p) => providerConsent.has(p), audit: providerAudit }
            )
          }
        },
        {
          path: '/group',
          description:
            'Group surfaces into a REAL folder on disk: makes a subdirectory and MOVES the given surfaces\' ' +
            'files into it. kind:"folder" (default) → ONE collapsed tile (drill in to browse), best for many ' +
            'items / a repo. kind:"board" → the items stay SPLAYED on the canvas as a sub-board (small curated ' +
            'set). A real filesystem folder either way, so it persists. Args: {name, ids:[surfaceId], kind?}.',
          input_schema: {
            type: 'object',
            required: ['ids'],
            properties: { name: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, kind: { type: 'string', enum: ['folder', 'board'] }, x: { type: 'number' }, y: { type: 'number' } }
          },
          handler: ({ body }) => {
            const b = toolBody(body)
            const ids = Array.isArray(b.ids) ? b.ids.map(String) : []
            if (!ids.length) return { ok: false, error: 'no members to group' }
            return wsHost.group(String(b.name || 'Folder'), ids, Number(b.x) || 0, Number(b.y) || 0, b.kind === 'board' ? 'board' : 'folder')
          }
        },
        {
          path: '/read_window',
          description: 'Read what is INSIDE a web surface (its DOM): url, title, and visible text. Only kind "web" (server mode).',
          input_schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } }
          },
          handler: async ({ body }) => {
            const b = toolBody(body)
            const id = typeof b.id === 'string' ? b.id : ''
            if (!id) return { status: 400, body: { error: 'id required' } }
            if (!SERVER_MODE || !host || !host.has(id)) {
              return { status: 501, body: { error: 'read_window needs server mode (or the desktop app); this surface has no server browser target' } }
            }
            // Reading a logged-in surface only crosses the relay if the user shared it (P0).
            if (!isContentShared(id)) {
              return { status: 403, body: { error: 'content not shared — ask the user to enable "share with agent" on this surface', code: 'not_shared' } }
            }
            // No raw eval over the relay (confused-deputy on a logged-in session) — safe DOM read only.
            const action = { action: 'read' }
            const r = await controlSession(host.session(id), action)
            if (!r.ok) return { status: 400, body: { error: r.error } }
            return { result: r.result }
          }
        },
        {
          path: '/update_surface',
          description: 'Patch a surface in place: set html (srcdoc), props (native, e.g. note text), url, title, or geometry (x,y,w,h).',
          input_schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              html: { type: 'string' }, url: { type: 'string' }, title: { type: 'string' },
              props: { type: 'object' },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }
            }
          },
          handler: ({ body }) => {
            const b = toolBody(body)
            const id = typeof b.id === 'string' ? b.id : ''
            if (!id) return { status: 400, body: { error: 'id required' } }
            const patch = { ...b }
            delete patch.id
            broadcast({ type: 'update', id, patch })
            // server mode: a url change navigates the live target
            if (SERVER_MODE && host && host.has(id) && typeof b.url === 'string') host.navigate(id, b.url).catch(() => {})
            return { ok: true }
          }
        },
        {
          path: '/surface_control',
          description: 'Act INSIDE a web surface: click, type, press a key, read text, or screenshot. Only kind "web"; requires server mode. Put the surface id in the body.',
          input_schema: {
            type: 'object',
            required: ['id', 'action'],
            properties: {
              id: { type: 'string' },
              action: {
                type: 'object',
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['click', 'type', 'key', 'read', 'screenshot'] },
                  selector: { type: 'string' },
                  x: { type: 'number' }, y: { type: 'number' },
                  text: { type: 'string' }, perKey: { type: 'boolean' },
                  key: { type: 'string', description: 'Enter | Tab | ArrowDown | ...' }
                }
              }
            }
          },
          handler: async ({ body }) => {
            const b = toolBody(body)
            const id = typeof b.id === 'string' ? b.id : ''
            const action = b.action || {}
            if (!id || !action.action) return { status: 400, body: { error: 'id and action.action required' } }
            // eval stays localhost-only — never over the relay (confused-deputy on a logged-in session).
            if (action.action === 'eval') return { status: 403, body: { error: 'eval is not available over the relay' } }
            // Reading/screenshotting a logged-in surface only crosses the relay if shared (P0).
            if ((action.action === 'read' || action.action === 'screenshot') && !isContentShared(id)) {
              return { status: 403, body: { error: 'content not shared — enable "share with agent" on this surface to read or screenshot it', code: 'not_shared' } }
            }
            if (!SERVER_MODE || !host || !host.has(id)) {
              return { status: 501, body: { error: 'in-window control needs server mode (BLITZ_SERVER_MODE=1) or the desktop app; this surface has no server browser target' } }
            }
            const r = await controlSession(host.session(id), action)
            if (!r.ok) return { status: 400, body: { error: r.error } }
            if (action.action === 'screenshot') return { image: r.result }
            if (action.action === 'read') return { text: r.result }
            return { ok: true }
          }
        },
        {
          path: '/events',
          description:
            "Long-poll the user's activity, coalesced into framed 'moments' (batched ~15s; flushed immediately on navigation or going idle after acting). Each moment: {seq,surfaceId,url,title,trigger,signals,user[],snapshot}. THE AUTONOMY LOOP: start since=0, loop with since=latest and wait=25; on each moment decide whether to act, then build/arrange surfaces to help. (Page content — snapshot/user — is withheld for surfaces the user hasn't shared with the agent.)",
          input_schema: { type: 'object', properties: { since: { type: 'number' }, wait: { type: 'number' } } },
          handler: async ({ body }) => {
            const a = toolBody(body)
            const since = Number(a.since) || 0
            const wait = Math.min(Math.max(a.wait == null ? 25 : Number(a.wait) || 0, 0), 25) // default 25, but honor an explicit wait:0 (the startup latest-read)
            const raw = await waitForEvents(since, wait * 1000)
            // Relay is untrusted: page content only crosses for surfaces the user shared.
            const events = raw.map((m) => (isContentShared(m.surfaceId) ? m : redactMoment(m)))
            return { events, latest: latestSeq(), reminder: EVENTS_REMINDER }
          }
        },
        {
          path: '/say',
          description:
            "Send a chat message to the USER — appears in their in-canvas Chat panel. Use this to reply when a moment has trigger:'message' (the user typed to you), or to proactively tell them what you did. Plain text.",
          input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
          handler: ({ body }) => {
            const text = String(toolBody(body).text || '')
            if (!text) return { status: 400, body: { error: 'text required' } }
            wsHost.appendChat('agent', text) // append to chat.md + broadcast the transcript to the chat widget
            return { ok: true }
          }
        },
        {
          path: '/customize_widget',
          description:
            "Rewrite a built-in OS widget's UI — currently {name:'chat'} (the chat panel). The UI is a workspace " +
            'file (blitz-chat.html) you fully replace; it live-reloads. Build it with the Blitz UI kit injected ' +
            'into every widget: <blitz-titlebar>/<blitz-list>/<blitz-message role=user|agent>/<blitz-input> + the ' +
            '--blitz-* tokens, and window.blitz (onProps(p=>render(p.messages)), sendMessage(text)). Read the ' +
            'current source with get_system_ui first. Args: {name, html}.',
          input_schema: { type: 'object', required: ['name', 'html'], properties: { name: { type: 'string' }, html: { type: 'string' } } },
          handler: ({ body }) => {
            const b = toolBody(body)
            const r = wsHost.customizeWidget(String(b.name || ''), String(b.html || ''))
            return r && r.ok ? { ok: true, file: r.rel } : { status: 400, body: { error: (r && r.error) || 'failed' } }
          }
        },
        {
          path: '/get_system_ui',
          description: "Read a built-in widget's current UI source before editing it (the fork pattern). Args: {name:'chat'}. Returns {html}.",
          input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          handler: ({ body }) => {
            const html = wsHost.systemUi(String(toolBody(body).name || ''))
            return html == null ? { status: 404, body: { error: 'unknown widget' } } : { html }
          }
        },
        {
          path: '/list_widgets',
          description:
            'Browse the widget library: reusable, forkable mini-apps (sandboxed HTML) backed by the user’s connected integrations. Returns each widget’s name, description, and which integrations it needs (needsMet=true if connected). Use get_widget_source to read one, spawn_widget to open it.',
          handler: () => {
            const connected = readTokens()
            return {
              widgets: listWidgets().map((w) => ({ ...w, needsMet: (w.needs || []).every((n) => !!connected[n]) })),
              connected: Object.keys(connected)
            }
          }
        },
        {
          path: '/get_widget_source',
          description:
            'Read the exact, forkable HTML source of a library widget by name (to understand or fork it). Returns { name, html, needs, props, version, origin }.',
          input_schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
          handler: ({ body }) => {
            const name = String(toolBody(body).name || '')
            const w = getWidgetSource(name)
            if (!w) return { status: 404, body: { error: `no widget named "${name}"` } }
            return w
          }
        },
        {
          path: '/spawn_widget',
          description:
            'Open a library widget on the canvas as a live sandboxed surface. It fetches its data through the OS bridge; the user approves integration access once. Returns { id } (and needsConnect:[...] if a required integration is not connected). Use list_widgets for names.',
          input_schema: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
              title: { type: 'string' }, props: { type: 'object' }
            }
          },
          handler: ({ body }) => {
            const a = toolBody(body)
            const w = getWidgetSource(String(a.name || ''))
            if (!w) return { status: 404, body: { error: `no widget named "${a.name}"` } }
            const id = randomUUID()
            const surface = { kind: 'srcdoc', id, html: w.html, props: { ...(w.props || {}), ...(a.props || {}) }, title: a.title || w.name }
            for (const k of ['x', 'y', 'w', 'h']) if (a[k] != null) surface[k] = Number(a[k])
            broadcast({ type: 'create', surface })
            const connected = readTokens()
            const needsConnect = (w.needs || []).filter((n) => !connected[n])
            return needsConnect.length ? { id, needsConnect } : { id }
          }
        },
        {
          path: '/save_widget',
          description:
            'Save a NEW or forked widget (sandboxed HTML using the window.blitz bridge) into the library so it can be browsed and reused. Call get_widget_authoring FIRST to learn the bridge. Returns { name, version }.',
          input_schema: {
            type: 'object',
            required: ['name', 'html'],
            properties: {
              name: { type: 'string', description: 'a-z 0-9 -, 2-49 chars' },
              html: { type: 'string' },
              description: { type: 'string' },
              needs: { type: 'array', items: { type: 'string' } },
              props: { type: 'object' },
              forkedFrom: { type: 'string' }
            }
          },
          handler: ({ body }) => {
            const a = toolBody(body)
            try {
              return saveWidget(a)
            } catch (e) {
              return { status: 400, body: { error: e?.message || 'save failed' } }
            }
          }
        },
        {
          path: '/list_integrations',
          description:
            'List the integrations (Discord, GitHub, Gmail, Jira, Slack) and whether each is connected — so you know which widgets can show real data and what to ask the user to connect.',
          handler: () => ({ integrations: statuses() })
        },
        {
          path: '/get_widget_authoring',
          description:
            'Get the widget-authoring guide: how to write a widget that reads integration data via the sandboxed window.blitz bridge. Read this BEFORE authoring a new widget with save_widget.',
          handler: () => ({ markdown: WIDGET_AUTHORING_MD })
        }
      ])
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
    const surface = url.searchParams.get('surface') || ''
    if (!surface || !consentGranted.has(`${surface}:${provider}`)) {
      return json(res, 403, { error: `consent required for ${provider}`, code: 'consent_required', provider })
    }
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
