/*
 * Standalone (non-Electron) OS backend for the browser preview.
 *
 * A plain Node HTTP server that mirrors the Electron main-process surface model
 * (osActions / agentSocket) so the renderer can run over `fetch` + SSE instead of
 * IPC. The renderer reaches it via the Vite dev-server proxy (`/api` -> here), so
 * everything is same-origin and there is no CORS to fight. The agent works the
 * user's tools through the web surfaces it opens (open_window / read_window /
 * surface_control), not through any token API.
 */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, statSync, realpathSync, readdirSync } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { startBrowserHost } from './browser-host.mjs'
import { controlSession } from '../src/main/control-core.mjs'
// listWidgets/getWidgetSource/saveWidget moved INTO the shared os-tools.mjs registry (server no longer
// references them directly); the authoring guide is still served by an HTTP route here.
import { widgetAuthoringMd } from '../src/main/widget-catalog.mjs'
// Widget tool bridge — the CLOSED allowlist a sandboxed widget may call via blitz.tool (shared with Electron).
import { makeWidgetToolRunner, makeWidgetToolHandlers } from '../src/main/widget-tools.mjs'
// The ONE shared agent tool registry — the SAME module Electron's relay + localhost transports bind. The server
// supplies its own primitive ops (broadcast + headless-Chromium) so there is no server/Electron tool difference.
import { makeOsTools } from '../src/main/os-tools.mjs'
// Orchestrators (dynamic-workflows) toggle: the boot-task provider reads the per-agent flag off meta.json (the same
// shared serializer Electron uses). The Job model is retired — server mode is now purely orchestrator-driven.
import { readTerminalMeta } from '../src/main/terminal-manager.mjs'
// Shared perception kernel — the SAME modules the Electron main runs,
// so server mode gets the autonomy loop with no duplicated code.
// waitForEvents/latestSeq/EVENTS_REMINDER/isContentShared are consumed INSIDE the shared os-tools.mjs
// registry now (same module instance) — backend.mjs keeps only what its own HTTP routes + ingest use.
// (redactMoment is NOT consumed anywhere — it is currently uncalled repo-wide; see perception-core.mjs.)
import {
  ingestSignals,
  setContentShare,
  emitUserMessage,
  emitSurfaceAction,
  emitSystemMoment,
  setWorkspaceProvider,
  setTickSource,
  resetTickBaseline,
  absorbTickEcho,
  INJECT,
  DRAIN
} from '../src/main/perception-core.mjs'
import { AGENT_RUNTIME_CLAUDE, AGENT_RUNTIME_CODEX_SERVERLESS, normalizeAgentRuntime, prepareAgentLaunch, setBootTaskProvider, orchestratorBootTask } from '../src/main/agent-runtime.mjs'
// Boot journal (crash dirty-bit + root lease) — the SAME root-state store the Electron main uses.
import { openBootJournal, resolveWorkspace, appendChatMessage } from '../src/main/workspace.mjs'
// The SHARED relay lifecycle (connect + self-heal + watchdog + status) — the SAME module Electron uses, so
// the relay can't diverge between the two modes again. Only the adapter (publish url/status) differs.
import { startRelay } from '../src/main/relay.mjs'
// Shared "Agent activity" feed — the SAME module the Electron relay uses; only `emit` differs (SSE here).
import { withActivity } from '../src/main/activity.mjs'
// Shared multi-agent terminal lifecycle (tmux-backed, workspace-keyed) — SAME module Electron binds.
import { makeTerminalOps } from '../src/main/terminal-ops.mjs'
import { makeActionItems } from '../src/main/action-items.mjs'
import { makeConnectionOps } from '../src/main/connection-ops.mjs'
import { makeTabLink } from '../src/main/connection-tab-link.mjs'
import { makeSafariLink } from '../src/main/connection-safari-link.mjs'
import { createWorkspaceHost } from '../src/main/workspace-host.mjs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..') // BlitzOS package root

const PORT = Number(process.env.BACKEND_PORT || 8787)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '')

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

// ---------- HTTP server ----------

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
const FILE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', json: 'application/json', csv: 'text/csv', html: 'text/html; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav' }
const fileContentType = (p) => FILE_MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'

// ---------- OS bridge: surface model over SSE (browser preview) ----------
// Mirrors src/main/{osActions,agentSocket}.ts, but pushes agent actions to the
// renderer over Server-Sent Events instead of Electron IPC. In-window control
// (CDP) is NOT available here — that needs the real Electron app + a <webview>.
let osState = { surfaces: [] }
// Boot-hydrated from the active workspace by the shared host (wsHost.hydrateOnBoot(), created below
// after broadcast + reconcileSurfaces exist). The renderer adopts it via a `hydrate` on SSE connect.
let agentUrl = null
let relay = null // the SHARED relay handle ({ getUrl, isOnline, stop }) — same module Electron uses (no divergence)
// Agents run as managed tmux terminals. Server mode remains opt-in via BLITZ_AGENT, but the backend can
// be Claude or Codex serverless via BLITZ_AGENT_BACKEND/BLITZ_AGENT_RUNTIME.
const rawAgentBackend = process.env.BLITZ_AGENT_BACKEND || process.env.BLITZ_AGENT_RUNTIME || ''
const rawAgentCmd = process.env.BLITZ_AGENT || ''
const rawAgentRuntime = rawAgentCmd && rawAgentCmd !== '1' ? normalizeAgentRuntime(rawAgentCmd) : ''
const rawAgentIsRuntime = rawAgentRuntime === AGENT_RUNTIME_CODEX_SERVERLESS || rawAgentRuntime === AGENT_RUNTIME_CLAUDE
const agentRuntime = rawAgentBackend ? normalizeAgentRuntime(rawAgentBackend) : rawAgentIsRuntime ? rawAgentRuntime : AGENT_RUNTIME_CLAUDE
const agentCmd = rawAgentCmd === '1' ? (agentRuntime === AGENT_RUNTIME_CODEX_SERVERLESS ? 'codex' : 'claude') : rawAgentIsRuntime ? (agentRuntime === AGENT_RUNTIME_CODEX_SERVERLESS ? 'codex' : 'claude') : rawAgentCmd
const launchAgent = process.env.BLITZ_AGENT
  ? (id, stage, title) => {
      const ws = wsHost.activePath()
      if (!ws || !agentUrl) return // not ready (no workspace / relay url yet) — boot resume retries
      const terminalsDir = join(ws, '.blitzos', 'terminals')
      const launch = prepareAgentLaunch({ sessionsDir: terminalsDir, id, url: agentUrl, cmd: agentCmd, runtime: agentRuntime })
      Promise.resolve(serverTerminalOps.spawnTerminal({
        id,
        kind: 'agent',
        command: launch.command,
        cwd: ws,
        stage,
        title: title || (id === '0' ? 'Agent' : `Agent ${id}`),
        agentRuntime: launch.agentRuntime,
        agentSessionId: launch.agentSessionId,
        claudeSessionId: launch.claudeSessionId,
        claudeEstablished: launch.established
      })).catch(() => {})
    }
  : null
// Boot-task mapper (server). Server mode has NO onboarding interview, so the duty is purely orchestrator-driven: an
// agent with the ORCHESTRATORS flag on its meta.json gets the duty to author + run blitzscript workflows; any other
// agent gets null. (prepareAgentLaunch re-reads this provider on every (re)launch.)
setBootTaskProvider((id) => {
  try {
    const ws = wsHost.activePath()
    const td = ws ? join(ws, '.blitzos', 'terminals') : null
    if (td && readTerminalMeta(td, String(id))?.orchestrators) return orchestratorBootTask()
  } catch { /* fall through */ }
  return null
})
const sseClients = new Set()

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
      // Host-side hard-nav sensor (parity with Electron's did-navigate emitter in osActions.ts): a
      // cross-document navigation kills the in-page sensor before it can report, so the CDP host
      // emits the nav signal into the SAME coalescer — moments flush immediately on real link
      // clicks, not only on SPA route changes.
      onNavigated: (id, url) => ingestSignals(id, [{ type: 'nav', url, t: Date.now() }]),
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
    // mode produces the moment stream over /events. The connected agents drive the OS;
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
  try {
    if (obj?.type === 'terminal-spawn' && obj?.terminal?.kind === 'agent' && obj.id != null) wsHost?.setChatStatus(String(obj.id), 'starting')
    else if (obj?.type === 'terminal-data' && obj.id != null) wsHost?.noteAgentActivity(String(obj.id), 'terminal')
    else if (obj?.type === 'terminal-stop' && obj.id != null) wsHost?.setChatStatus(String(obj.id), 'stopped')
    else if (obj?.type === 'terminal-exit' && obj.id != null) wsHost?.setChatStatus(String(obj.id), Number(obj.exitCode) ? 'error' : 'stopped')
    // W2 supervisor tick (server parity with Electron's osActions broadcast adapter): a BULK transaction
    // (hydrate/switch/reconcile from the shared workspace host) changes the world wholesale, so re-SEED the
    // tick baseline rather than diff it as a storm of phantom user/agent signals. (Before this, server mode
    // had NO self-reaction guard at all — a workspace switch / reconcile could self-wake the supervisor.)
    if (obj?.type === 'reconcile' || obj?.type === 'hydrate' || obj?.type === 'switch') resetTickBaseline()
  } catch {
    /* status sync is best-effort */
  }
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
// v2 bleed fix: stamp every perception moment with the active workspace (same as Electron main).
setWorkspaceProvider(() => { try { return wsHost.active() } catch { return null } })
// W2 supervisor tick (plans/blitzos-tick-diff-steer.md): feed the SAME host snapshot Electron does — surfaces
// (incl. props) + per-agent status + terminals — so server mode gets the steering heartbeat with no fork. The
// closure reads wsHost / serverTerminalOps lazily (declared below; only invoked at tick time, well after init).
// Self-reaction guard (TIMING-ROBUST, parity with Electron): the serverOps tool ops below call
// absorbTickEcho (a tool-origin surface/agent delta the next tick skips), and the broadcast adapter calls
// resetTickBaseline on a BULK transaction (reconcile/hydrate/switch). Both are timing-independent.
setTickSource(() => {
  try {
    return {
      surfaces: osState.surfaces || [],
      agentStatus: wsHost.chatStatusSnapshot(),
      terminals: serverTerminalOps.listTerminals().map((t) => ({ id: String(t.id), status: t.status, exitCode: t.exitCode ?? null })),
      workspace: wsHost.active()
    }
  } catch {
    return null
  }
})
const wsHost = createWorkspaceHost({
  root: WORKSPACES_ROOT,
  initialName: INITIAL_WS,
  // a BLITZ_WORKSPACE pin beats boot-where-you-left-off; a bare root override does not
  explicitInitial: !!process.env.BLITZ_WORKSPACE,
  getState: () => osState,
  setState: (s) => {
    osState = s
    reconcilePending(osState) // confirm/expire optimistic agent creates against the authoritative push
  },
  broadcast,
  getActionItems: () => serverActionItems.listActions(), // authoritative inbox items (reconciled into hydrate + onStatePush)
  onSurfaces: (surfaces) => (SERVER_MODE ? reconcileSurfaces(surfaces) : undefined),
  defaultMode: 'desktop', // single-canvas nav: mode is pinned to 'desktop' (wsHost ignores this and hard-pins it too)
  // An agent backend runs in a VISIBLE terminal in its stage (no headless brain). null ⇒ BLITZ_AGENT off.
  launchAgent: launchAgent ? (id, stage, title) => launchAgent(id, stage, title) : undefined,
  stopAgent: (id) => { serverTerminalOps.removeTerminal(id) } // closing an agent fully removes its terminal record (no auto-restart, no exited ghost)
})

// 2C/2D parity with Electron (osActions): main is AUTHORITATIVE-ON-WRITE for agent mutations — apply each
// to osState immediately (existence is exact; on a HEADLESS server there may be NO renderer to echo a
// create, so this is the only thing that makes a create→operate sequence resolve), then broadcast for any
// connected renderer. Content/existence changes also flush durably so an `ok` ack survives a crash.
const serverPending = new Map()
const PENDING_TTL = 10_000
function surfaceExists(id) {
  return serverPending.has(id) || (osState.surfaces || []).some((s) => s.id === id)
}
function reconcilePending(s) {
  const now = Date.now()
  for (const [id, t] of serverPending) if ((s.surfaces || []).some((x) => x.id === id) || now - t > PENDING_TTL) serverPending.delete(id)
}
function durableFlush() {
  try {
    if (!wsHost.isSwitching()) wsHost.flush()
  } catch {
    /* best-effort */
  }
}
// Item 4: name where a non-active id lives so the agent can bring it (move_surface) or switch_workspace.
function noSuch(id) {
  const found = wsHost.locateSurface(String(id))
  if (found) return { ok: false, error: `surface "${id}" is in workspace "${found.name}", not the active one — move_surface it (to bring just this window here) or switch_workspace "${found.name}" (for that whole desktop)` }
  return { ok: false, error: `no surface "${id}" in any workspace` }
}
// Claim the root + read the previous run's dirty bit (kernel fault model — parity with Electron's
// index.ts). `concurrent` = the old record's pid is still alive: another BlitzOS owns this root
// (warn, never false-report a crash). Announced via a trigger:'system' moment for any watching
// agent + a chat line for the human (which lands in chat.md, the brains' boot memory).
const bootJournal = openBootJournal(WORKSPACES_ROOT, 'server')
wsHost.hydrateOnBoot()
if (bootJournal.concurrent) {
  console.error(
    `[agent-os backend] another BlitzOS (pid ${bootJournal.prev?.pid}, mode ${bootJournal.prev?.mode}) appears to be running on this workspaces root — two hosts on one root WILL fight over files. Close one of them.`
  )
} else if (bootJournal.dirty) {
  const when = new Date(bootJournal.lastAliveAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const line = `Recovered from a crash: the previous BlitzOS process died around ${when} without a clean shutdown. Workspaces were restored from disk; edits made in the last moments before the crash may have been lost.`
  console.error('[agent-os backend] ' + line)
  emitSystemMoment('crash', line, { at: bootJournal.lastAliveAt || Date.now() })
  try {
    wsHost.appendChat('agent', line)
  } catch {
    /* chat append is best-effort at boot */
  }
}

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

// The "Agent activity" feed (ACTIVITY_TOOLS / activityText / withActivity) is the SHARED
// core in src/main/activity.mjs — the SAME module the Electron relay (agentSocket.ts) uses,
// so it can't diverge. Here `emit` is the SSE broadcast; in Electron it's webContents.send.
// See `withActivity(makeOsTools(serverOps)…, broadcast)` in startServerRelay below.

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
    const surface = { ...a, id }
    serverPending.set(id, Date.now())
    osState = { ...osState, surfaces: [...(osState.surfaces || []), surface] }
    broadcast({ type: 'create', surface })
    if (SERVER_MODE && host && a.kind === 'web' && !host.has(id)) {
      host.createSurface(id, { url: a.url || 'about:blank', width: Math.round(Number(a.w)) || 1280, height: Math.round(Number(a.h)) || 800 }).catch(() => {})
    }
    durableFlush()
    return id
  },
  openWindow: (a) => {
    const id = randomUUID()
    setContentShare(id, true) // the agent opened this page — it can read what it opened
    const surface = { kind: 'web', ...a, id }
    serverPending.set(id, Date.now())
    osState = { ...osState, surfaces: [...(osState.surfaces || []), surface] }
    broadcast({ type: 'create', surface })
    if (SERVER_MODE && host && !host.has(id)) {
      host.createSurface(id, { url: a.url, width: Math.round(Number(a.w)) || 1280, height: Math.round(Number(a.h)) || 800 }).catch(() => {})
    }
    durableFlush()
    return id
  },
  moveSurface: (id, x, y) => {
    const i = String(id)
    if (!surfaceExists(i)) {
      // Not here — if it lives in another workspace, move_surface MEANS "bring it here + place it".
      const r = wsHost.bringSurfaceHere(i, Number(x), Number(y))
      if (r && r.ok) return { ok: true }
      return noSuch(i)
    }
    osState = { ...osState, surfaces: (osState.surfaces || []).map((s) => (s.id === i ? { ...s, x: Number(x), y: Number(y) } : s)) }
    broadcast({ type: 'move', id: i, x: Number(x), y: Number(y) })
    return { ok: true }
  },
  updateSurface: (id, patch) => {
    const i = String(id)
    if (!surfaceExists(i)) return noSuch(i)
    absorbTickEcho({ surfaces: [i] }) // W2: a tool-origin props edit must not self-wake the supervisor tick (the next tick skips this surface's delta; one-shot, per-delta)
    const props = patch.props
    osState = { ...osState, surfaces: (osState.surfaces || []).map((s) => (s.id === i ? { ...s, ...patch, props: { ...(s.props || {}), ...(props || {}) } } : s)) }
    broadcast({ type: 'update', id: i, patch })
    if (SERVER_MODE && host && host.has(i) && typeof patch.url === 'string') host.navigate(i, patch.url).catch(() => {})
    durableFlush()
    return { ok: true }
  },
  closeSurface: (id) => {
    const i = String(id)
    if (!surfaceExists(i)) return noSuch(i)
    serverPending.delete(i)
    osState = { ...osState, surfaces: (osState.surfaces || []).filter((s) => s.id !== i) }
    broadcast({ type: 'close', id: i })
    if (SERVER_MODE && host) host.closeSurface(i).catch(() => {})
    try { serverConnections?.handleSurfaceClosed(i) } catch { /* connection cleanup best-effort */ } // drop the connection if this was its widget
    wsHost.closeSurfaceFile(i) // delete the backing content file so it doesn't resurrect (no-renderer agent close)
    durableFlush()
    return { ok: true }
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
  // v2 bleed fix: a workspace-pinned agent's say routes to ITS OWN workspace's transcript when that
  // workspace isn't active (path-based append; its widgets hydrate on switch-in).
  say: (text, agentId, workspace) => {
    if (workspace && workspace !== wsHost.active()) {
      const dir = resolveWorkspace(WORKSPACES_ROOT, String(workspace), { mustExist: true })
      if (dir) return appendChatMessage(dir, 'agent', String(text), String(agentId ?? '0'))
    }
    return wsHost.appendChat('agent', String(text), agentId) // append to that agent's chat.md + broadcast
  },
  // steer (W2 supervisor): nudge a SPECIFIC agent — the relay-safe wake-a-target path. Mirrors Electron's
  // osUserMessage: append the directive AS the user to that agent's chat.md (appendChat('user') also flips it
  // to 'working' + echoes the widget) AND emit a 'message' moment that wakes ONLY that agent. `say` does NOT
  // wake the target (agent->user) and `user_say` is localhost-only, so this is the steering primitive.
  steer: (text, agentId) => {
    const aid = String(agentId ?? '0')
    wsHost.appendChat('user', String(text), aid)
    emitUserMessage(String(text), aid)
  },
  customizeWidget: (name, html, agentId, lang) => {
    const r = wsHost.customizeWidget(String(name), String(html), agentId, lang)
    // W2: a tool-origin widget edit must not self-wake the supervisor tick — absorb the affected surface id
    // the host reports (the chat widget's surface for a chat edit). The 'note' path doReconciles (a BULK
    // transition the broadcast adapter covers via resetTickBaseline), so it has no per-surface id here.
    if (r && r.ok && r.surfaceId) absorbTickEcho({ surfaces: [r.surfaceId] })
    return r
  },
  // Live OS theme (the onboarding wardrobe card / an agent picking an accent). Mirrors Electron's
  // osSetTheme: sanitize each role to a #rrggbb hex, then broadcast the SAME `set-theme` action the
  // shared renderer applies (App.tsx) — so theming works identically in both transports, not Electron-only.
  setTheme: (theme) => {
    const hex = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : null)
    const out = {}
    for (const k of ['accent', 'accentDeep', 'marker', 'positive', 'danger', 'info']) { const h = hex((theme || {})[k]); if (h) out[k] = h }
    if (!Object.keys(out).length) return { ok: false, error: 'pass at least one role as a #rrggbb hex (accent, marker, …)' }
    broadcast({ type: 'set-theme', theme: out })
    return { ok: true }
  },
  closeAgent: (id) => {
    absorbTickEcho({ agents: [String(id)] }) // W2: a tool-origin close changes the agent SET — the next tick skips this close (one-shot, per-delta)
    return wsHost.closeAgent(String(id))
  },
  renameAgent: (id, title) => wsHost.renameAgent(String(id), String(title ?? '')),
  // Open a new agent: register + surface it; addAgent launches its managed terminal (launchAgent).
  // focus:true (a USER '+ Agent') tells the renderer to follow the camera to the new stage.
  spawnAgent: async (title, focus = false) => {
    const id = wsHost.newAgentId()
    absorbTickEcho({ agents: [id] }) // W2: a tool-origin spawn changes the agent SET — the next tick skips this add (one-shot); a real status edge still wakes
    wsHost.addAgent(id, title, { focus })
    return { id, title: title || `Agent ${id}` }
  },
  // start_workflow (replaces the retired start_job) — SAME shape as Electron's electronOps: spawn a fresh agent with
  // the ORCHESTRATORS capability ON (its first bootstrap carries the orchestrator duty), then SEED it with the task
  // (+ any dropped context refs) as a 'user' chat line that wakes it (appendChat + emitUserMessage, the steer path).
  startWorkflow: (spec) => {
    const id = wsHost.newAgentId()
    absorbTickEcho({ agents: [id] }) // W2: a tool-origin spawn changes the agent SET — the next tick skips this add (one-shot); a real status edge still wakes
    wsHost.addAgent(id, spec?.title, { focus: true, orchestrators: true })
    const agent = { id, title: spec?.title || `Agent ${id}` }
    const refs = Array.isArray(spec?.contextRefs) && spec.contextRefs.length
      ? `\n\nContext (dropped onto the launcher):\n${spec.contextRefs.map((r) => `- ${r}`).join('\n')}` : ''
    const seed = `${String(spec?.task || '')}${refs}`
    try { wsHost.appendChat('user', seed, id); emitUserMessage(seed, id) } catch { /* the agent still boots with the duty */ }
    return { ok: true, agent }
  },
  systemUi: (name) => wsHost.systemUi(String(name)),
  systemUiInfo: (name) => wsHost.systemUiInfo(String(name)),
  groupIntoFolder: (name, ids, x, y, kind) => {
    // Normalize to { ok, ... } like Electron's osGroupIntoFolder — wsHost.group returns a bare { error } (no ok)
    // on failure, so without this the agent saw { error } on server vs { ok:false, error } on Electron (parity bug).
    const r = wsHost.group(String(name || 'Folder'), ids, Number(x) || 0, Number(y) || 0, kind === 'board' ? 'board' : 'folder')
    return r && 'ok' in r ? r : { ok: false, error: (r && r.error) || 'could not group' }
  }
}

// Terminal ops — the SHARED workspace-keyed lifecycle (terminal-ops.mjs). Server seam: the active
// workspace folder + the SSE broadcast emit. Electron binds the SAME makeTerminalOps with its own seam.
const serverTerminalOps = makeTerminalOps({ getWorkspacePath: () => wsHost.activePath(), emit: broadcast, getUrl: () => agentUrl, agentCmd: agentCmd || 'claude', agentRuntime })
Object.assign(serverOps, serverTerminalOps)

// Action-items inbox — the SAME shared core Electron binds. Server seam: active workspace + SSE
// broadcast for UI; emitMoment wakes the watching agent (perception 'action' moment) on resolve.
const serverActionItems = makeActionItems({ getWorkspacePath: () => wsHost.activePath(), emit: broadcast, emitMoment: (action) => emitSurfaceAction('inbox', action) })
Object.assign(serverOps, serverActionItems)

// Connections — the SAME shared registry + per-source tool store + dispatch Electron binds (connection-ops.mjs).
// Server seam: active workspace folder + the server's createSurface (the representation widget). The tab
// (remote-paired extension) and window adapters bind through serverConnections.connectionBind / connectionNotify.
const serverConnections = makeConnectionOps({
  getWorkspacePath: () => wsHost.activePath(),
  createSurface: (desc) => serverOps.createSurface(desc),
  updateSurface: (id, patch) => serverOps.updateSurface(id, patch),
  closeSurface: (id) => serverOps.closeSurface(id),
  getSurfaces: () => osState.surfaces || [],
  isAgentAvailable: () => {
    try {
      return serverTerminalOps.listTerminals().some((t) => t.kind === 'agent' && t.status === 'running')
    } catch {
      return false
    }
  }
})
Object.assign(serverOps, serverConnections)

// The BlitzOS Connector extension links here too (a self-hosted LOCAL server = localhost, same as Electron).
// A connected tab becomes a per-source tool provider. (Remote-server tab pairing over an authenticated WSS is
// a later refinement; the localhost path covers the co-located case the feature targets.)
const serverTabLink = makeTabLink({ connectionOps: serverConnections, token: process.env.BLITZ_CONNECTOR_TOKEN || '' })
serverConnections.setTabLink(serverTabLink)
serverTabLink
  .start()
  .then((r) => {
    if (r.ok) console.log('[agent-os backend] connector link on 127.0.0.1:' + r.port)
  })
  .catch(() => {})
// Safari tabs via Apple Events (only works when the server is co-located on a Mac with Safari; harmless else).
serverConnections.setSafariLink(makeSafariLink({ connectionOps: serverConnections }))

// Start the agent-socket relay via the SHARED lifecycle module (relay.mjs) — connect + self-heal + watchdog +
// status all live there now (one impl, Electron too). The server only supplies its tools + the adapter: how to
// publish the URL/status to the browser (SSE broadcast); URL changes refresh .blitzos/relay-url.
function startServerRelay() {
  relay = startRelay(
    {
      appId: process.env.AGENT_SOCKET_APP_ID || 'as_app_anon',
      baseUrl: process.env.AGENT_SOCKET_RELAY || 'https://agentsocket.dev',
      appDescription: 'BlitzOS (browser preview): an agent OS desktop — open and arrange surfaces on an infinite canvas.',
      agentsMd: OS_AGENTS_MD,
      label: 'blitzos-preview',
      // The ONE shared registry, server-bound (serverOps). Same paths/descriptions/schemas/handlers as Electron;
      // mapped to the agent-socket tool shape. transport:relay — the server is untrusted like the relay (no
      // localhost trust), so the few security branches behave identically. Add/change a tool in os-tools.mjs once.
      tools: withActivity(
        makeOsTools(serverOps).map((t) => ({
          path: t.path,
          description: t.description,
          ...(t.input_schema ? { input_schema: t.input_schema } : {}),
          handler: ({ body }) => t.handler({ body: body || '', transport: 'relay' })
        })),
        (ev) => {
          try { wsHost?.noteAgentActivity(ev.agentId || '0', ev.tool === '/say' ? 'say' : 'tool') } catch { /* best-effort */ }
          broadcast(ev) // emit each activity event over SSE (Electron emits via webContents.send)
        }
      )
    },
    {
      onUrl: (u) => {
        agentUrl = u
        wsHost.setRelayUrl(u) // publish to .blitzos/relay-url so reattached agents self-heal onto the fresh url
        broadcast({ __agentUrl: agentUrl })
        console.log('[agent-os backend] agent-socket paste URL (drive the preview from any AI chat):\n  ' + agentUrl)
      },
      onStatus: (online) => broadcast({ type: 'agentStatus', online, agentUrl, agent: !!process.env.BLITZ_AGENT })
    }
  )
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', PUBLIC_BASE_URL)
  const path = url.pathname

  if (path === '/api/health')
    return json(res, 200, {
      ok: true,
      // relay + agent health, so `curl /api/health` (or start-all's doctor) can tell if the agent path is live
      relayOnline: !!(relay && relay.isOnline()),
      agentUrl,
      agent: !!process.env.BLITZ_AGENT,
      workspace: wsHost.active()
    })

  // GET /api/widget-authoring.md — the bridge-authoring guide (also a tool).
  if (path === '/api/widget-authoring.md' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
    return res.end(widgetAuthoringMd())
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
    // Send the current relay/agent status immediately so the toolbar pill shows online/offline on first
    // paint (don't make a fresh tab wait up to 20s for the next watchdog tick).
    res.write(`data: ${JSON.stringify({ type: 'agentStatus', online: !!(relay && relay.isOnline()), agentUrl, agent: !!process.env.BLITZ_AGENT })}\n\n`)
    // Phase 2: hand the connecting renderer the current canvas so it restores it (and flips
    // its hydrate gate). osState is the persisted-on-boot canvas, or the live one mid-session.
    // Repaint persisted connection widgets whose connection isn't live → "disconnected" (parity with Electron).
    // Single-canvas nav: ONE home region, no stages — so no stageCount/stageOrder/currentStage is sent
    // (the field is pinned 'desktop' where unset; legacy persisted 'canvas' is ignored).
    const hydrateSurfaces = wsHost.hydrateSurfaces().map((s) => {
      try {
        return serverConnections.rewriteHydratedSurface(s) || s
      } catch {
        return s
      }
    })
    res.write(
      `data: ${JSON.stringify({ type: 'hydrate', surfaces: hydrateSurfaces, camera: osState.camera || { x: 0, y: 0, scale: 1 }, mode: osState.mode || 'desktop', workspace: wsHost.active() })}\n\n`
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
  // Terminal I/O from a TerminalView in the browser (mirrors /api/os/state): keystrokes,
  // resize, and a one-shot scrollback read for repaint. Drive the SAME shared terminal ops as the tools.
  if (path === '/api/os/terminal-input' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { ok: serverTerminalOps.sendToTerminal(String(b.id || ''), String(b.data ?? '')) }) })
    return
  }
  if (path === '/api/os/terminal-resize' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { ok: serverTerminalOps.resizeTerminal(String(b.id || ''), Number(b.cols) || 80, Number(b.rows) || 24) }) })
    return
  }
  if (path === '/api/os/terminal-read' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { text: serverTerminalOps.readTerminal(String(b.id || '')) }) })
    return
  }
  if (path === '/api/os/terminal-spawn' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); Promise.resolve(serverTerminalOps.spawnTerminal({ command: b.command, title: b.title, kind: b.kind, cwd: b.cwd })).then((s) => json(res, 200, { terminal: s })).catch(() => json(res, 200, { terminal: null })) })
    return
  }
  // Open a new AGENT from the UI (the "+ Agent" button). serverOps.spawnAgent mints the id,
  // surfaces its widget (broadcast), and supervises its agent over the relay.
  if (path === '/api/os/agent-spawn' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); Promise.resolve(serverOps.spawnAgent(b.title != null ? String(b.title) : undefined, b.focus != null ? !!b.focus : true)).then((s) => json(res, 200, { agent: s })).catch(() => json(res, 200, { agent: null })) })
    return
  }
  // Close an agent (stop its terminal + remove its widget/files/stage) — the UI Close button / agent tool.
  if (path === '/api/os/agent-close' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, serverOps.closeAgent(String(b.id || ''))) })
    return
  }
  // Rename an agent (cosmetic title) — the UI rename / agent tool.
  if (path === '/api/os/agent-rename' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, serverOps.renameAgent(String(b.id || ''), String(b.title ?? ''))) })
    return
  }
  // Clear an agent's context (the chat widget's "new context" button) — rotate its claude session id +
  // restart → empty conversation. Mirrors the Electron os:chat-control 'clear' op (no divergence).
  if (path === '/api/os/agent-clear' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); Promise.resolve(serverTerminalOps.clearAgentContext(String(b.id || '0'))).then((okv) => json(res, 200, { ok: !!okv })).catch(() => json(res, 200, { ok: false })) })
    return
  }
  if (path === '/api/os/terminal-list' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy() })
    req.on('end', () => json(res, 200, { terminals: serverTerminalOps.listTerminals() }))
    return
  }
  if (path === '/api/os/terminal-stop' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { ok: serverTerminalOps.stopTerminal(String(b.id || '')) }) })
    return
  }
  // Permanently remove a (dead or live) terminal from the tray — prune it from the workspace. Never the agent.
  if (path === '/api/os/terminal-remove' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { ok: serverTerminalOps.removeTerminal(String(b.id || '')) }) })
    return
  }
  if (path === '/api/os/terminal-restart' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); Promise.resolve(serverTerminalOps.restartTerminal(String(b.id || ''))).then((s) => json(res, 200, { terminal: s })).catch(() => json(res, 200, { terminal: null })) })
    return
  }
  // Action-items inbox — the renderer (human) loads/resolves/clears items (mirrors the terminal routes).
  if (path === '/api/os/action-list' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { actions: serverActionItems.listActions(b.status) }) })
    return
  }
  if (path === '/api/os/action-resolve' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { ok: serverActionItems.resolveAction(String(b.id || ''), b.resolution ? String(b.resolution) : 'done') }) })
    return
  }
  if (path === '/api/os/action-clear' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { const b = toolBody(body); json(res, 200, { ok: serverActionItems.clearAction(String(b.id || '')) }) })
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
      try { serverConnections?.handleSurfaceClosed(String(b.id || '')) } catch { /* best-effort */ } // user closed a widget → drop its connection
      const r = wsHost.closeSurfaceFile(String(b.id || ''))
      return json(res, 200, r || { ok: false })
    })
    return
  }
  // POST /api/os/widget-tool { surfaceId, name, args } — a sandboxed widget calls an OS tool via
  // blitz.tool (gated by the `tools` capability in the renderer). Same CLOSED allowlist as Electron
  // (widget-tools.mjs); dispatches through the same primitives the relay tools use.
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
  if (path === '/api/os/rename-folder' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let rbody = ''
    req.on('data', (c) => {
      rbody += c
      if (rbody.length > 10_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(rbody)
      const r = wsHost.renameFolder(String(b.path || ''), String(b.name || ''))
      return json(res, r && r.ok ? 200 : 400, r || { error: 'failed' })
    })
    return
  }
  if (path === '/api/os/move-into-folder' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let mbody = ''
    req.on('data', (c) => {
      mbody += c
      if (mbody.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(mbody)
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : []
      const r = wsHost.moveIntoFolder(String(b.folderPath || ''), ids)
      return json(res, r && r.ok ? 200 : 400, r || { error: 'failed' })
    })
    return
  }
  if (path === '/api/os/move-out-of-folder' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let mbody = ''
    req.on('data', (c) => {
      mbody += c
      if (mbody.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(mbody)
      const paths = Array.isArray(b.paths) ? b.paths.map(String) : []
      const r = wsHost.moveOutOfFolder(paths, Number(b.x) || 0, Number(b.y) || 0)
      return json(res, r && r.ok ? 200 : 400, r || { error: 'failed' })
    })
    return
  }
  if (path === '/api/os/open-folder-entry' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let obody = ''
    req.on('data', (c) => {
      obody += c
      if (obody.length > 10_000) req.destroy()
    })
    req.on('end', () => {
      const b = toolBody(obody)
      const r = wsHost.openFolderEntry(String(b.path || ''), Number(b.x) || 0, Number(b.y) || 0)
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
      const cb = toolBody(cbody)
      const t = cb.text
      const sid = cb.agentId != null ? String(cb.agentId) : '0' // which agent the human typed into
      if (typeof t === 'string' && t.trim()) {
        wsHost.appendChat('user', t, sid) // write the user's message to that agent's chat.md + echo to its widget
        emitUserMessage(t, sid) // …and wake ONLY that agent (trigger:'message' moment, redaction-exempt)
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
        json(res, r.status, r.body)
      } catch (e) {
        console.error('[workspace] switch failed:', e?.message || e)
        json(res, 500, { error: 'switch failed' })
      }
    })
    return
  }
  // Delete a workspace + its folder (human-only, from Mission Control). The host guards the active/last
  // cases and switches away first if the deleted one is current — so the active may change here too.
  if (path === '/api/os/workspace/delete' && req.method === 'POST') {
    if (!sameSiteOnly(req)) return json(res, 403, { error: 'forbidden' })
    let cbody = ''
    req.on('data', (c) => { cbody += c; if (cbody.length > 4096) req.destroy() })
    req.on('end', async () => {
      try {
        const r = await wsHost.removeWorkspace(toolBody(cbody).name)
        json(res, r.ok ? 200 : 400, r)
      } catch (e) {
        console.error('[workspace] delete failed:', e?.message || e)
        json(res, 500, { ok: false, error: 'delete failed' })
      }
    })
    return
  }

  // POST /api/os/workspace/thumb { workspace, dataUrl } — the renderer uploads a captured snapshot of
  // the primary stage (a data:image/jpeg) as that workspace's thumbnail (last-seen, Mission-Control
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
  // GET /api/os/workspace/thumb?name=X — serve the cached primary-stage thumbnail (404 if none yet).
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
  // Connect to the agent-socket relay (shared self-healing lifecycle in relay.mjs) so a pasted URL can drive it.
  startServerRelay()
  // Server mode: bring up the headless browser host for live web surfaces.
  initServerMode()
  // Phase 3: watch the workspace folder so external file edits (agent/Finder/git) reflect live.
  wsHost.startWatch()
  // Boot agents: each backend runs in a VISIBLE tmux terminal in its stage. Survivors are
  // reattached (tmux outlives the process); only the DEAD ones are re-exec'd with persisted
  // backend metadata. Opt-in via BLITZ_AGENT (off by default — continuous LLM use has a cost). The relay URL is
  // minted async, so poll until it's up, then resume once (after survivors are adopted, to avoid double-launch).
  if (process.env.BLITZ_AGENT) {
    let resumed = false
    let tries = 0
    const t = setInterval(() => {
      if (!agentUrl) { if (++tries > 150) clearInterval(t); return } // cap ~2min so we don't poll forever if the relay never connects
      clearInterval(t)
      if (resumed) return
      resumed = true
      Promise.resolve(serverTerminalOps.whenRestored())
        .catch(() => {})
        .then(() => wsHost.resumeAgentsOnBoot())
    }, 800)
  }
  // (the relay self-heal + watchdog + status heartbeat now live in the shared relay.mjs — see startServerRelay)
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
  try { serverTerminalOps.stopHosts() } catch { /* ignore */ } // flush transcripts + close tmux control clients; the agents' terminals SURVIVE (reattached next boot)
  try {
    if (host) await host.stop()
  } catch {
    /* ignore */
  }
  bootJournal.markClean() // LAST: "clean shutdown" means everything above flushed first
  process.exit(0)
}
process.on('SIGTERM', gracefulExit)
process.on('SIGINT', gracefulExit)
