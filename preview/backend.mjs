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
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
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
  INJECT,
  DRAIN
} from '../src/main/perception-core.mjs'
import { startAgentRunner } from '../src/main/agent-runner.mjs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..') // BlitzOS package root

const PORT = Number(process.env.BACKEND_PORT || 8787)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
const REDIRECT_URI = `${PUBLIC_BASE_URL}/api/oauth/callback`
const UA = 'agent-os-preview/0.1'

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
const callbackPage = (title, sub) =>
  `<!doctype html><meta charset="utf-8"><body style="font-family:-apple-system,system-ui;background:#0e1116;color:#e6edf3;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><h2 style="margin:0 0 8px">${title}</h2><p style="color:#8b949e;margin:0">${sub}</p></div><script>try{window.opener&&window.opener.postMessage({type:'agentos:oauth'},'*')}catch(e){}setTimeout(function(){window.close()},1400)</script></body>`

// ---------- OS bridge: surface model over SSE (browser preview) ----------
// Mirrors src/main/{osActions,agentSocket}.ts, but pushes agent actions to the
// renderer over Server-Sent Events instead of Electron IPC. In-window control
// (CDP) is NOT available here — that needs the real Electron app + a <webview>.
let osState = { surfaces: [] }
let agentUrl = null
const sseClients = new Set()
// Widget data consent: `${surfaceId}:${provider}` the human approved (via the
// renderer prompt). The data route 403s until the pair is here — a widget can't
// read an integration the user hasn't allowed for that surface.
const consentGranted = new Set()
// Coarse per-(surface,provider,resource) min-interval, so a runaway widget can't
// hammer a provider API (burning the user's rate limit). Best-effort, in-memory.
const lastFetch = new Map()
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

// Reconcile the host's live targets with the web surfaces the renderer reports
// (covers both agent- and human-created surfaces, since both land in os:state).
function reconcileSurfaces(list) {
  if (!host) return
  const want = new Set(list.filter((x) => x && x.kind === 'web').map((x) => x.id))
  for (const sfc of list) {
    if (sfc.kind === 'web' && !host.has(sfc.id)) {
      host
        .createSurface(sfc.id, { url: sfc.url || 'about:blank', width: Math.round(sfc.w) || 1280, height: Math.round(sfc.h) || 800 })
        .catch((e) => console.error('[server mode] createSurface', sfc.id, e?.message || e))
    }
  }
  for (const id of host.ids()) {
    if (!want.has(id)) host.closeSurface(id).catch(() => {})
  }
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
function toolBody(body) {
  try {
    return body ? JSON.parse(body) : {}
  } catch {
    return {}
  }
}

const OS_AGENTS_MD = `# BlitzOS

These are your OPERATING INSTRUCTIONS for BlitzOS — internalize and ACT on them. Do NOT recite this document back to the user. Greet them in one line, then use the tools to do what they ask.

You drive an infinite canvas of "surfaces" the user is watching live: you open and arrange surfaces and the user sees every action on their screen in real time.

## How to call tools
\`$BASE\` = the URL you fetched this from, with the trailing \`/agents.md\` removed. Every tool below is an HTTP endpoint under \`$BASE\` — call it with your web-request / fetch / code tool:

    POST $BASE/<tool>     (with a JSON body)

FIRST: \`GET $BASE/tools.json\` to see the exact tools + input schemas. Then tell the user in one line what you can do, and start. (Keep this URL so you can re-read these instructions if your context resets.)

## Surface kinds
- web — a live third-party website, fully rendered server-side and controllable (no X-Frame-Options limits).
- app — an iframe of a first-party app URL.
- srcdoc — a sandboxed iframe of HTML you write inline; great for a quick tool/visualization (calculator, chart, timer). It has NO network/fetch — to show data from a connected integration, use a Widget (see below), which gets data over the \`window.blitz\` bridge.
- native — a built-in widget; component "note" = a post-it (props { text?, color?: yellow|pink|blue|green }).

## Tools (authoritative schemas at $BASE/tools.json)
- POST $BASE/open_window { url, x?, y?, w?, h?, title? } — open a website as a web surface; returns { id }.
- POST $BASE/create_surface { kind, x?, y?, w?, h?, title?, url?, html?, component?, props? } — create any kind.
- POST $BASE/move_surface { id, x, y }
- POST $BASE/update_surface { id, html?, props?, url?, title?, x?, y?, w?, h? } — patch a surface in place (resize via w/h, change url/title/geometry).
- POST $BASE/close_surface { id }
- POST $BASE/go_to_primary
- POST $BASE/list_state — the full layout (read before arranging): { viewport:{w,h}, view:{x,y,w,h,cx,cy,scale}, mode, surfaces:[{id,kind,x,y,w,h,z,title,url}] }. See "Window management" below.
- POST $BASE/surface_control { id, action: { action: "click"|"type"|"key"|"read"|"screenshot", selector?, x?, y?, text?, key? } } — act INSIDE a web surface (read text, click/type, screenshot).
- POST $BASE/events { since?, wait? } — THE AUTONOMY LOOP: long-poll the user's activity as coalesced "moments" (start since=0, then loop with since=latest and wait=25). Each moment {seq,surfaceId,url,title,trigger,signals,user[],snapshot} wakes you on meaningful change; decide whether to act, then build/arrange surfaces to help. (Page content — snapshot/user — is readable for surfaces YOU opened; for surfaces the USER opened it is withheld until they click the green eye to share it.)
- POST $BASE/say { text } — send a chat message to the USER (appears in their in-canvas Chat panel). A moment with trigger:"message" is the user typing to you directly (text in the moment's \`message\` field) — ALWAYS reply with say; do what they ask with the other tools, then say what you did.

## Widgets (integration-backed mini-apps)
A widget is a reusable, forkable sandboxed mini-app backed by the user's connected integrations (e.g. "your Discord servers", "your GitHub repos"). There is a library you browse, read, fork, and add to.
- POST $BASE/list_integrations — see which integrations are connected (so you know what has real data).
- POST $BASE/list_widgets — browse the library; each entry has { name, description, needs, needsMet }.
- POST $BASE/get_widget_source { name } — read a widget's exact HTML (to understand or fork it).
- POST $BASE/spawn_widget { name, x?, y?, w?, h?, title?, props? } — open a library widget live on the canvas (returns { id }; the user approves integration access once).
- POST $BASE/save_widget { name, html, description?, needs?, props?, forkedFrom? } — add a NEW or forked widget to the library.
- POST $BASE/get_widget_authoring — READ THIS before authoring a new widget: it explains the \`window.blitz\` data bridge (a sandboxed widget cannot fetch(); it gets integration data only via window.blitz.data(provider, resource)).
Typical flow: list_widgets → spawn_widget to use one; or get_widget_source → edit → save_widget to fork; or get_widget_authoring → write HTML → save_widget → spawn_widget to author new.

## Window management — you are the window manager (think before you open OR close)
You own the desktop arrangement. \`list_state\` gives you everything needed to reason spatially:
- \`viewport {w,h}\` — the user's screen size in px (what fits).
- \`view {x,y,w,h,cx,cy,scale}\` — the world-space rectangle the user can SEE right now (cx,cy = its center). A surface OUTSIDE \`view\` is off-screen to them — if you place a window there, they never see it. This is the #1 mistake; place inside \`view\`.
- each surface's \`x,y,w,h\` (geometry, world px), \`z\` (stacking; higher = on top), and \`component\`.
- The **Chat panel** (\`component:"chat"\`, \`pinned:true\`) is the user's channel to you and is ALWAYS ON TOP — NEVER place a window over it or hide it. It docks to the LEFT of \`view\`; put everything else to its right / in the free area beside it.

BEFORE opening / spawning a surface, plan the new arrangement:
1. Relevance — is it something the user should SEE now? If not, don't surface it.
2. Size — pick \`w,h\` for its content AND the viewport (a reading/article pane wants width + height; a note/timer/status chip is small). Don't exceed \`view\`.
3. Position — place it INSIDE \`view\` so it's actually visible (near \`view.cx/cy\`; or omit x/y to center in their view). Never let it land off-screen.
4. Make room — if it would overlap or hide something the user still needs, MOVE/RESIZE the existing windows first (\`move_surface\`, \`update_surface\` with w/h): tile side-by-side, shrink the now-secondary one, or close what's stale. Decide the whole layout, then apply it. Never just stack windows on top of each other.

BEFORE closing a surface: after \`close_surface\`, REFLOW the survivors to fill the gap (recenter or re-tile them within \`view\`) so the arrangement stays clean instead of leaving a hole.

Keep the view clean and readable: only what matters now, each with room. Arrange deliberately — don't pile up.

Coordinates are world pixels. Prefer srcdoc for things you can build inline; use open_window for real external sites. Use list_state and surface_control:read to see the screen before acting. Note: update_surface replacing a srcdoc's html RELOADS it (in-widget state resets) — for live data use a widget's bridge, not html rewrites.
`

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
            const id = a.kind === 'srcdoc' ? randomUUID() : a.id || randomUUID()
            // The agent opened this surface itself (it chose the url), so reading it back
            // leaks nothing the agent didn't already pick — auto-share web/app so the agent
            // can read/control what it opened. (Surfaces the USER opens stay private until
            // they share — that's the P0 confused-deputy gate, which this does not weaken.)
            if (a.kind === 'web' || a.kind === 'app') setContentShare(id, true)
            broadcast({ type: 'create', surface: { ...a, id } })
            if (SERVER_MODE && host && a.kind === 'web' && !host.has(id)) {
              host.createSurface(id, { url: a.url || 'about:blank', width: Math.round(a.w) || 1280, height: Math.round(a.h) || 800 }).catch(() => {})
            }
            return { id }
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
            return { id }
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
            return { ok: true }
          }
        },
        { path: '/go_to_primary', description: 'Recenter the view on the primary workspace.', handler: () => { broadcast({ type: 'goToPrimary' }); return { ok: true } } },
        { path: '/list_state', description: 'List the surfaces currently open on the canvas.', handler: () => osState },
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
            const wait = Math.min(Math.max(Number(a.wait) || 25, 0), 25)
            const raw = await waitForEvents(since, wait * 1000)
            // Relay is untrusted: page content only crosses for surfaces the user shared.
            const events = raw.map((m) => (isContentShared(m.surfaceId) ? m : redactMoment(m)))
            return { events, latest: latestSeq() }
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
            broadcast({ type: 'chat', text })
            return { ok: true }
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
      if (b && b.surfaceId && b.provider) consentGranted.add(`${String(b.surfaceId)}:${String(b.provider)}`)
      json(res, 200, { ok: true })
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
      if (sid) for (const k of consentGranted) if (k.startsWith(`${sid}:`)) consentGranted.delete(k)
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
      toks[pend.id] = { provider: pend.id, label, secrets, connectedAt: Date.now() }
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
      const s = toolBody(body)
      if (s && Array.isArray(s.surfaces)) {
        osState = s
        if (SERVER_MODE) reconcileSurfaces(s.surfaces) // spin up / tear down server targets
      }
      json(res, 200, { ok: true })
    })
    return
  }
  if (path === '/api/os/agent-url' && req.method === 'GET') return json(res, 200, { url: agentUrl })

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
      if (typeof t === 'string' && t.trim()) emitUserMessage(t)
      json(res, 200, { ok: true })
    })
    return
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
  // Boot + supervise the brain: spawn the agent against the live relay URL and keep it
  // alive (auto-restart on exit), so a brain is always watching. Opt-in via BLITZ_AGENT
  // (=claude or a custom command); off by default (continuous LLM use has a cost).
  if (process.env.BLITZ_AGENT) {
    startAgentRunner({ getUrl: () => agentUrl, cmd: process.env.BLITZ_AGENT === '1' ? 'claude' : process.env.BLITZ_AGENT, label: 'server-agent' })
  }
})
