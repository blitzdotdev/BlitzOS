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
  } catch (e) {
    console.error('[agent-os backend] SERVER MODE failed to start headless browser:', e?.message || e)
  }
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
- srcdoc — a sandboxed iframe of HTML you write inline; great for a quick tool/visualization (calculator, chart, timer).
- native — a built-in widget; component "note" = a post-it (props { text?, color?: yellow|pink|blue|green }).

## Tools (authoritative schemas at $BASE/tools.json)
- POST $BASE/open_window { url, x?, y?, w?, h?, title? } — open a website as a web surface; returns { id }.
- POST $BASE/create_surface { kind, x?, y?, w?, h?, title?, url?, html?, component?, props? } — create any kind.
- POST $BASE/move_surface { id, x, y }
- POST $BASE/close_surface { id }
- POST $BASE/go_to_primary
- POST $BASE/list_state — list the surfaces currently open.
- POST $BASE/surface_control { id, action: { action: "click"|"type"|"key"|"read"|"screenshot", selector?, x?, y?, text?, key? } } — act INSIDE a web surface (read text, click/type, screenshot).

Coordinates are world pixels; omit position to center in the user's view. Prefer srcdoc for things you can build inline; use open_window for real external sites. Use list_state and surface_control:read to see the screen before acting.
`

async function startOsAgentSocket() {
  try {
    const session = await connect({
      appId: process.env.AGENT_SOCKET_APP_ID || 'as_app_anon',
      baseUrl: process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev',
      appDescription: 'BlitzOS (browser preview): an agent OS desktop — open and arrange surfaces on an infinite canvas.',
      agentsMd: OS_AGENTS_MD,
      tools: [
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
            const id = a.id || randomUUID()
            broadcast({ type: 'create', surface: { ...a, id } })
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
            broadcast({ type: 'create', surface: { kind: 'web', ...a, id } })
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
            broadcast({ type: 'close', id: String(toolBody(body).id) })
            return { ok: true }
          }
        },
        { path: '/go_to_primary', description: 'Recenter the view on the primary workspace.', handler: () => { broadcast({ type: 'goToPrimary' }); return { ok: true } } },
        { path: '/list_state', description: 'List the surfaces currently open on the canvas.', handler: () => osState },
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
            if (!SERVER_MODE || !host || !host.has(id)) {
              return { status: 501, body: { error: 'in-window control needs server mode (BLITZ_SERVER_MODE=1) or the desktop app; this surface has no server browser target' } }
            }
            const r = await controlSession(host.session(id), action)
            if (!r.ok) return { status: 400, body: { error: r.error } }
            if (action.action === 'screenshot') return { image: r.result }
            if (action.action === 'read') return { text: r.result }
            return { ok: true }
          }
        }
      ]
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

  json(res, 404, { error: 'not found' })
})

// /api/os/stream — binary-ish WS carrying screencast frames out (server mode) and
// raw CDP input messages in ({t:'cdp', id, method, params} → that surface's session).
const streamWss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  if (u.pathname !== '/api/os/stream') {
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
      // Human input is forwarded as raw CDP (Input.dispatch* with CSS-px coords).
      if (m.t === 'cdp' && host && host.has(m.id) && typeof m.method === 'string') {
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
})
