import { BrowserWindow, ipcMain, webContents, app } from 'electron'
import { randomUUID } from 'crypto'
import { join, dirname, basename, resolve } from 'path'
import { controlWindow, type ControlAction, type ControlResult } from './cdp'
import { dropConsent } from './widgets'
import { ingestSignals, emitSurfaceAction, emitUserMessage, emitAnnotation, setContentShare, dropContentShare, setWorkspaceProvider, INJECT, DRAIN } from './events'
import { createWorkspaceHost } from './workspace-host.mjs'
import { safeName, appendChatMessage, resolveWorkspace } from './workspace.mjs'

export type SurfaceKind = 'native' | 'srcdoc' | 'web' | 'app'

export interface SurfaceDescriptor {
  id?: string
  kind: SurfaceKind
  x?: number
  y?: number
  w?: number
  h?: number
  title?: string
  url?: string
  html?: string
  component?: string
  props?: Record<string, unknown>
}

export interface OsState {
  surfaces: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number; title: string; url?: string; component?: string; z?: number; props?: Record<string, unknown> }>
  camera?: { x: number; y: number; scale: number }
  view?: { cx: number; cy: number }
  mode?: string
  // #45 workspace areas: how many tiled desktops + which is active + the current one's world rect (so
  // the agent places surfaces in the area the human is looking at, not blindly at the origin).
  areaCount?: number
  currentArea?: number
  currentAreaRect?: { x: number; y: number; w: number; h: number }
  workspace?: string
  // The active workspace's absolute folder path (~/Blitz/<name>). The filesystem IS the canvas: a LOCAL
  // agent authors surfaces by writing files INTO this folder (.html=panel, .md=note, .weblink=web) and the
  // host's watcher materializes them in ~250ms. Surfaced so the agent knows WHERE to write.
  workspace_path?: string
}

let getWin: () => BrowserWindow | null = () => null
let cached: OsState = { surfaces: [] }
// The workspaces root this process runs on (~/Blitz unless overridden) — index.ts needs it for the
// boot journal (root-level runtime state lives at <root>/.blitzos/state.json).
let wsRoot = ''
// 2C/2D: main is AUTHORITATIVE-ON-WRITE for agent mutations. Each create/update/move/close is applied
// to `cached` immediately (so a create→operate in the same tick — faster than the renderer round-trip —
// resolves, and so existence checks are exact), then the IPC is sent for the renderer to reflect. The
// renderer stays the authority: its next `os:state` push replaces `cached` wholesale, reconciling away
// any optimistic drift. `pendingCreates` covers the window before that first echo. Content/existence
// changes (create/update/close) also force a durable flush so an `ok` ack means the write survives a
// crash — the gap that lost a note this session.
const pendingCreates = new Map<string, number>()
const PENDING_TTL = 10_000
function surfaceExists(id: string): boolean {
  return pendingCreates.has(id) || (cached.surfaces || []).some((s) => s.id === id)
}
/** Reconcile optimistic creates against an authoritative renderer snapshot: confirmed (now in the push)
 *  or stale (renderer never echoed within the TTL) → forget. */
function reconcilePending(s: OsState): void {
  const now = Date.now()
  for (const [id, t] of pendingCreates) {
    if ((s.surfaces || []).some((x) => x.id === id) || now - t > PENDING_TTL) pendingCreates.delete(id)
  }
}
/** Persist `cached` NOW (not on the 500ms debounce) so an agent write is durable at ack time. Guarded
 *  against a mid-switch flush (the host owns the folder then) and best-effort (durability, never a throw). */
function durableFlush(): void {
  try {
    if (wsHost && !wsHost.isSwitching()) wsHost.flush()
  } catch {
    /* best-effort */
  }
}
// The SHARED workspace host (created in initOsActions, once app paths exist) — the SAME module the
// server backend uses, so workspaces are ONE feature across both modes. Electron adapter: broadcast =
// os:action IPC; web surfaces are <webview>s the renderer owns (onSurfaces no-op); mode 'desktop'.
let wsHost: ReturnType<typeof createWorkspaceHost> | null = null
// surfaceId -> the webview guest's WebContents id (so we can read its DOM)
const webviewIds = new Map<string, number>()

/** Wire the renderer<->main control channel. Renderer pushes state on change. */
export function initOsActions(getWindow: () => BrowserWindow | null): void {
  getWin = getWindow

  // The shared workspace host. Root honors BLITZ_WORKSPACES_ROOT / BLITZ_WORKSPACE (parity with the
  // server backend), defaulting to ~/Blitz (user-browseable folders). SAME module as the server.
  const root = process.env.BLITZ_WORKSPACES_ROOT
    ? resolve(process.env.BLITZ_WORKSPACES_ROOT)
    : process.env.BLITZ_WORKSPACE
      ? dirname(resolve(process.env.BLITZ_WORKSPACE))
      : join(app.getPath('home'), 'Blitz')
  let initialName = process.env.BLITZ_WORKSPACE ? basename(resolve(process.env.BLITZ_WORKSPACE)) : 'Home'
  if (!safeName(initialName)) initialName = 'Home'
  wsRoot = root
  // v2 bleed fix: every perception moment is stamped with the workspace that was active when it
  // happened, so workspace-pinned agents (/events {workspace}) never see another desktop's activity.
  setWorkspaceProvider(() => wsHost?.active() || null)
  wsHost = createWorkspaceHost({
    root,
    initialName,
    // a BLITZ_WORKSPACE pin beats boot-where-you-left-off; a bare root override does not
    explicitInitial: !!process.env.BLITZ_WORKSPACE,
    getState: () => cached,
    setState: (s) => {
      cached = s as OsState
      reconcilePending(cached) // confirm/expire optimistic agent creates against the authoritative push
    },
    broadcast: (obj) => getWin()?.webContents.send('os:action', obj),
    onSurfaces: () => {}, // the renderer owns its <webview>s in Electron
    defaultMode: 'canvas', // BlitzOS is canvas-first: new Electron boards open on the infinite canvas
    // A chat session's claude runs in a VISIBLE terminal in its area; index.ts wires this from the shared
    // agent-session core + the session-ops (it owns the relay url). Absent ⇒ no agent auto-launch.
    launchAgent: (id, area, title) => launchAgentHook?.(id, area, title)
  })
  wsHost.hydrateOnBoot()
  wsHost.startWatch()

  // Workspace launcher / Mission-Control IPC — mirrors the server's /api/os/workspace* routes.
  ipcMain.handle('workspace:list', () => ({
    workspaces: wsHost!.list().map(({ name, nodeCount, updatedAt, thumbTs }) => ({ name, nodeCount, updatedAt, thumbTs })),
    active: wsHost!.active()
  }))
  ipcMain.handle('workspace:create', (_e, name: string) => {
    try {
      return { ok: true, name: wsHost!.create(name).name }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'create failed' }
    }
  })
  ipcMain.handle('workspace:switch', async (_e, name: string) => {
    const r = await wsHost!.performSwitch(name)
    return r.status === 200 ? { ok: true, active: r.body.active } : { ok: false, error: r.body.error }
  })
  ipcMain.handle('workspace:capture', (_e, name: string) => osCaptureThumb(name))
  // Delete a workspace + its folder (human-only, from Mission Control; never an agent tool — destructive).
  // The host guards the active/last cases and switches away first if needed.
  ipcMain.handle('workspace:delete', async (_e, name: string) => {
    try {
      return await wsHost!.removeWorkspace(name)
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'delete failed' }
    }
  })
  // The renderer pulls its hydrate once its onAction listener is mounted (race-free; absorbs the
  // teammate's request-hydrate, replacing the old main-push on did-finish-load).
  ipcMain.on('workspace:request-hydrate', () => osSendHydrate())

  // The chat HUB widget manages its sessions over the bridge: 'new' mints a session (the agent spawns
  // on-demand on its first message); 'rename' sets a session's sidebar title (the agent auto-names).
  ipcMain.handle('os:chat-control', (_e, payload: { op?: unknown; args?: Record<string, unknown> }) => {
    const op = String(payload?.op || '')
    const args = (payload?.args && typeof payload.args === 'object' ? payload.args : {}) as Record<string, unknown>
    if (op === 'new') return osSpawnChatSession(typeof args.title === 'string' ? args.title : undefined)
    if (op === 'rename') return osRenameChatSession(String(args.id ?? '0'), String(args.title ?? ''))
    if (op === 'stop') return osStopChatSession(String(args.id ?? '0')) // human hit Stop: kill the brain, clear thinking
    if (op === 'switch') return { ok: true } // active session is widget-side state; nothing to persist (yet)
    return { ok: false, error: `unknown chat op: ${op}` }
  })

  ipcMain.on('os:state', (_e, state: OsState) => {
    if (state && Array.isArray(state.surfaces)) wsHost?.onStatePush(state)
  })
  ipcMain.on('os:webview', (_e, m: { surfaceId: string; wcid: number }) => {
    if (m && m.surfaceId) {
      webviewIds.set(m.surfaceId, m.wcid)
      ensureCapture(m.surfaceId)
      ensureNavEmitter(m.surfaceId, m.wcid)
    }
  })
  // A srcdoc surface fired an action back (e.g. "approve" in a triage panel).
  // Strip the envelope and emit it into the agent's event stream.
  ipcMain.on('os:surface-action', (_e, payload: Record<string, unknown>) => {
    if (!payload || typeof payload !== 'object') return
    const { surfaceId, __blitz, ...action } = payload as { surfaceId?: unknown; __blitz?: unknown } & Record<string, unknown>
    void __blitz
    emitSurfaceAction(typeof surfaceId === 'string' ? surfaceId : 'unknown', action)
  })
  // The human toggled "let the agent read this surface" (P0 content consent).
  ipcMain.on('os:content-share', (_e, m: { surfaceId?: unknown; on?: unknown }) => {
    if (m && typeof m.surfaceId === 'string') setContentShare(m.surfaceId, !!m.on)
  })
  // The human typed a message to the agent in the in-canvas Chat.
  ipcMain.on('os:user-message', (_e, payload: unknown) => {
    // payload is { text, sessionId } (object) — tolerate a bare string (older renderer) → session '0'.
    const text = typeof payload === 'string' ? payload : String((payload as { text?: unknown })?.text ?? '')
    const sid = payload && typeof payload === 'object' && (payload as { sessionId?: unknown }).sessionId != null ? String((payload as { sessionId?: unknown }).sessionId) : '0'
    if (text.trim()) {
      wsHost?.appendChat('user', text, sid) // write to that session's chat.md + echo to its widget
      emitUserMessage(text, sid) // wake ONLY that session's agent (trigger:'message')
      onChatActivity?.(sid, true) // on-demand: spawn this session's brain if it isn't running, and keep it alive
    }
  })
  // The human placed a spatial annotation on a surface + asked about that point (item 5b). The question
  // lands in chat (so it reads as a normal turn the agent answers) AND wakes the agent with a surface-
  // anchored 'annotation' moment carrying the point. Routes to the primary watcher ('0').
  ipcMain.on('os:annotate', (_e, p: { id?: unknown; surfaceId?: unknown; text?: unknown; xPct?: unknown; yPct?: unknown }) => {
    const surfaceId = String(p?.surfaceId ?? '')
    const text = String(p?.text ?? '').trim()
    if (!surfaceId || !text) return
    const xPct = Number(p?.xPct) || 0
    const yPct = Number(p?.yPct) || 0
    // The chat message carries the full annotation ref (id + surface + point) so a click recalls the
    // bubble even after a reload; the agent gets the surface-anchored moment.
    wsHost?.appendChat('user', text, '0', { id: String(p?.id ?? ''), surfaceId, xPct, yPct })
    emitAnnotation(surfaceId, text, { xPct, yPct })
    onChatActivity?.('0', true)
  })
  // Capture a web surface's current frame (capturePage — no debugger) for folder previews.
  ipcMain.handle('surface:capture', async (_e, surfaceId: string) => {
    const wcid = webviewIds.get(surfaceId)
    if (wcid == null) return null
    const wc = webContents.fromId(wcid)
    if (!wc || wc.isDestroyed()) return null
    try {
      const img = await wc.capturePage()
      return img.toDataURL()
    } catch {
      return null
    }
  })
}

// ---- perception (Electron): inject the shared in-page SENSORS (INJECT, from
// perception-core via events.ts) into each <webview> guest and drain them on a loop
// into the shared moment coalescer (ingestSignals). The sensor scripts + coalescer are
// the SAME ones server mode uses (preview/backend.mjs), so there is no drift.
// Re-injects on navigation (os:webview re-fires on each dom-ready); self-cleans when
// the guest is gone.

const captureIntervals = new Map<string, ReturnType<typeof setInterval>>()

// Host-side hard-navigation sensor. A real CROSS-DOCUMENT navigation destroys the page — and
// with it the in-page sensor and its undrained signal buffer — before the 600ms href poll can
// report it; the sensor re-injected on the new page initializes lastHref to the NEW url, so
// in-page detection only ever catches SAME-document (SPA) route changes. Main is the authority
// for cross-document navs: emit the nav signal from did-navigate so "flush immediately on
// navigation" holds for ordinary link clicks too. Registration arrives on dom-ready — after the
// initial load's did-navigate — so every event seen here is a real subsequent navigation (link,
// redirect, reload), never the boot load. The pre-nav buffer (e.g. the causing click) dies with
// the page: accepted — the nav moment records the transition, and the re-injected sensor's
// baseline `content` push refreshes the snapshot on the next drain.
const navWired = new Set<number>()
function ensureNavEmitter(surfaceId: string, wcid: number): void {
  if (navWired.has(wcid)) return
  const wc = webContents.fromId(wcid)
  if (!wc || wc.isDestroyed()) return
  navWired.add(wcid)
  wc.on('did-navigate', (_e, url) => ingestSignals(surfaceId, [{ type: 'nav', url, t: Date.now() }]))
  wc.once('destroyed', () => navWired.delete(wcid))
}

function ensureCapture(surfaceId: string): void {
  // (re)install the listener; idempotent within a page, fresh after a navigation
  osReadWindow(surfaceId, INJECT).catch(() => {})
  if (captureIntervals.has(surfaceId)) return
  const iv = setInterval(async () => {
    try {
      const raw = (await osReadWindow(surfaceId, DRAIN)) as Array<Record<string, unknown>>
      ingestSignals(surfaceId, raw)
    } catch {
      clearInterval(iv)
      captureIntervals.delete(surfaceId)
    }
  }, 350)
  captureIntervals.set(surfaceId, iv)
}

const DEFAULT_READ = `(() => {
  const ae = document.activeElement;
  const txt = (document.body && document.body.innerText || '').replace(/\\n{2,}/g,'\\n').trim();
  return {
    url: location.href,
    title: document.title,
    typingIn: ae ? { tag: ae.tagName, id: ae.id || null, cls: (ae.className||'').slice(0,80) || null, type: ae.getAttribute && ae.getAttribute('type'), value: (ae.value || ae.textContent || '').slice(0,120) } : null,
    text: txt.slice(0, 1500)
  };
})()`

/** Run JS inside a web surface and return the (JSON-serializable) result. */
export async function osReadWindow(id: string, script?: string): Promise<unknown> {
  const wcid = webviewIds.get(id)
  if (wcid == null) {
    const kind = cached.surfaces.find((s) => s.id === id)?.kind
    if (kind === 'srcdoc' || kind === 'native')
      throw new Error(
        `surface ${id} is a sandboxed ${kind} widget — read_window only works on \`web\` surfaces. To verify a widget's data, read its props from list_state, not its DOM.`
      )
    // Item 4: a web surface in ANOTHER workspace isn't live (not rendered) — name where it is so the agent
    // brings it here (move_surface) or switches, then it becomes readable.
    if (!surfaceExists(id)) {
      const found = wsHost ? wsHost.locateSurface(id) : null
      if (found) throw new Error(`surface ${id} is in workspace "${found.name}", not the active one — move_surface it here (or switch_workspace "${found.name}") to make it live, then read it`)
    }
    throw new Error(`surface ${id} has no readable web content yet`)
  }
  const wc = webContents.fromId(wcid)
  if (!wc || wc.isDestroyed()) throw new Error(`web content for ${id} is gone`)
  return wc.executeJavaScript(script && script.trim() ? script : DEFAULT_READ, true)
}

function send(type: string, payload: Record<string, unknown> = {}): void {
  getWin()?.webContents.send('os:action', { type, ...payload })
}

/** Send an arbitrary os:action to the renderer — the Electron emit seam for shared cores (e.g. session events). */
export function osBroadcast(action: Record<string, unknown>): void {
  getWin()?.webContents.send('os:action', action)
}

/** Create any surface kind. Returns its id. */
export function osCreateSurface(desc: SurfaceDescriptor): string {
  // srcdoc ids are server-minted: a consent grant is keyed by surface id, so an
  // untrusted caller must not be able to pick one and inherit a prior grant.
  // Always OS-mint the id (parity with the relay backend): honoring a caller-supplied id let
  // two surfaces collide on one content-file path -> clobber on serialize.
  const id = randomUUID()
  // The agent opened this surface itself (it chose the url), so reading it back leaks
  // nothing the agent didn't pick — auto-share web/app so it can read/control what it
  // opened. Surfaces the USER opens stay private until they share (the P0 gate).
  if (desc.kind === 'web' || desc.kind === 'app') setContentShare(id, true)
  const surface = { ...desc, id }
  // Authoritative-on-write: record it now (existence is exact for an immediate operate) + persist so a
  // freshly-created surface survives a crash before the renderer's echo. The renderer reconciles geometry/z
  // on its next push; writeIfChanged makes the re-persist a no-op.
  pendingCreates.set(id, Date.now())
  cached = { ...cached, surfaces: [...(cached.surfaces || []), surface as OsState['surfaces'][number]] }
  send('create', { surface })
  durableFlush()
  return id
}

/** Convenience: open a third-party site as a web surface. */
export function osOpenWindow(p: {
  url: string
  x?: number
  y?: number
  w?: number
  h?: number
  title?: string
}): string {
  return osCreateSurface({ kind: 'web', ...p })
}

/** Result of an agent surface mutation — `ok:false` when the target id is not in the active workspace,
 *  so the tool layer returns a TRUE error instead of a silent no-op (2C). */
export interface MutationResult {
  ok: boolean
  error?: string
}
// Item 4: when an id isn't in the active workspace, locate it elsewhere and turn the dead-end into a
// navigable instruction — the agent decides (per its own policy): pull JUST this window here
// (move_surface, which brings it), or switch_workspace for that whole desktop.
function noSuch(id: string): MutationResult {
  const found = wsHost ? wsHost.locateSurface(id) : null
  if (found) return { ok: false, error: `surface "${id}" is in workspace "${found.name}", not the active one — move_surface it (to bring just this window here) or switch_workspace "${found.name}" (for that whole desktop)` }
  return { ok: false, error: `no surface "${id}" in any workspace` }
}

export function osMoveSurface(id: string, x: number, y: number): MutationResult {
  if (!surfaceExists(id)) {
    // Not here — but if it lives in another workspace, move_surface MEANS "bring it here + place it"
    // (the agent wants just this one window). Preserves the id so the agent's handle keeps working.
    const r = wsHost ? wsHost.bringSurfaceHere(id, x, y) : null
    if (r && r.ok) return { ok: true }
    return noSuch(id)
  }
  cached = { ...cached, surfaces: (cached.surfaces || []).map((s) => (s.id === id ? { ...s, x, y } : s)) }
  send('move', { id, x, y }) // geometry rides the normal persist debounce — a lost move is harmless
  return { ok: true }
}
/** Patch an existing surface (e.g. update a srcdoc's html, a note's text, geometry). */
export function osUpdateSurface(id: string, patch: Record<string, unknown>): MutationResult {
  if (!surfaceExists(id)) return noSuch(id)
  // Apply the SAME merge the renderer does (props deep-merge, other fields assign) so the durable flush
  // persists exactly what the agent set — this is the note-memory write whose loss we're fixing.
  const props = patch.props as Record<string, unknown> | undefined
  cached = {
    ...cached,
    surfaces: (cached.surfaces || []).map((s) => (s.id === id ? { ...s, ...patch, props: { ...(s.props || {}), ...(props || {}) } } : s))
  }
  send('update', { id, patch })
  durableFlush()
  return { ok: true }
}
export function osCloseSurface(id: string): MutationResult {
  if (!surfaceExists(id)) return noSuch(id)
  dropConsent(id)
  dropContentShare(id)
  pendingCreates.delete(id)
  cached = { ...cached, surfaces: (cached.surfaces || []).filter((s) => s.id !== id) }
  send('close', { id })
  durableFlush() // persist the removal so a crash can't resurrect it from a stale workspace.json
  return { ok: true }
}
export function osGoToPrimary(): void {
  send('goToPrimary')
}
/** Agent → user: append a chat message to a session's chat.md and broadcast it to that session's widget.
 *  `workspace` (v2 bleed fix) routes a PINNED agent's say to ITS OWN workspace's transcript: when it
 *  names a workspace that is not the active one, the message is appended to that folder's chat file
 *  directly (no broadcast — its widgets aren't live; they hydrate the transcript on switch-in). */
export function osSay(text: string, sessionId = '0', workspace?: string): void {
  if (workspace && wsHost && workspace !== wsHost.active()) {
    const dir = wsRoot ? resolveWorkspace(wsRoot, workspace, { mustExist: true }) : null
    if (dir) {
      appendChatMessage(dir, 'agent', text, String(sessionId))
      return
    }
    // unknown workspace name → fall through to the active chat rather than silently dropping the message
  }
  wsHost?.appendChat('agent', text, sessionId)
  onChatActivity?.(String(sessionId), false) // keep an EXISTING local brain alive through long work; never spawn
}
/** The agent customizes a session's widget UI (blitz-[<id>-]<name>.html) — currently 'chat'. Live-reloads. */
export function osCustomizeWidget(name: string, html: string, sessionId = '0'): { ok: boolean; rel?: string; error?: string } {
  return wsHost ? wsHost.customizeWidget(String(name), String(html), sessionId) : { ok: false, error: 'no workspace host' }
}
/** Read a built-in widget's current UI source (workspace file or shipped default) — read-before-edit. */
export function osSystemUi(name: string): string | null {
  return wsHost ? wsHost.systemUi(String(name)) : null
}
// Chat activity hook (legacy seam, kept for liveness signals): a USER MESSAGE (spawn=true) may bring an
// agent up; an AGENT REPLY (spawn=false) only re-arms liveness — it must NEVER spawn one, or an EXTERNAL
// agent driving over the relay (whose /say also lands in osSay) would conscript a duplicate and both answer.
let onChatActivity: ((sessionId: string, spawn: boolean) => void) | null = null
export function setOnChatActivity(fn: (sessionId: string, spawn: boolean) => void): void {
  onChatActivity = fn
}
// index.ts owns the relay url + session-ops, so it registers HOW to launch a chat session's claude in a
// tmux terminal. osActions handles the workspace-side (mint id + hub registration); addChatSession then
// calls launchAgent via the host adapter. index.ts registers this when an agent command is available
// (BLITZ_AGENT, or a detected `claude` CLI).
let launchAgentHook: ((sessionId: string, area: number, title?: string) => void) | null = null
export function setLaunchAgent(fn: (sessionId: string, area: number, title?: string) => void): void {
  launchAgentHook = fn
}
/** Ensure a session's agent is up WITHOUT a chat message — the onboarding director uses this to start
 *  the resident interviewer at board-ready (its standing duty rides the bootstrap). Prefers the tmux
 *  launcher (re-exec replaces any stale terminal); falls back to the legacy activity hook. */
export function osKickBrain(sessionId = '0'): void {
  const sid = String(sessionId)
  if (launchAgentHook) {
    launchAgentHook(sid, sid === '0' ? 0 : 0)
    return
  }
  onChatActivity?.(sid, true)
}
// The human hit Stop on a session. index.ts owns the agent processes, so it registers the KILLER here and
// osStopChatSession fires it. Kept separate from onChatActivity so a stop can never be misread as activity.
let onChatStop: ((sessionId: string) => void) | null = null
export function setOnChatStop(fn: (sessionId: string) => void): void {
  onChatStop = fn
}
/** Open a new chat session: mint its id, register it in the hub; addChatSession launches its claude
 *  terminal (via the launchAgent seam, when wired). focus is accepted for API parity (hub switches client-side). */
export function osSpawnChatSession(title?: string, focus = false): { id: string; title: string } {
  if (!wsHost) throw new Error('no workspace host')
  const id = wsHost.newChatSessionId()
  wsHost.addChatSession(id, title, { focus })
  return { id, title: title || `Chat ${id}` }
}
/** Set a chat session's sidebar title (the agent auto-names; the human can rename). */
export function osRenameChatSession(id: string, title: string): { ok: boolean; id?: string; title?: string; error?: string } {
  return wsHost ? wsHost.renameChatSession(String(id), String(title)) : { ok: false, error: 'no workspace host' }
}
/** The human hit Stop on a session: kill its agent process NOW (index.ts hook) and clear its 'thinking'
 *  status (workspace host re-pushes the hub). The session + transcript stay — Stop is a halt, not a delete. */
export function osStopChatSession(id: string): { ok: boolean; id?: string; error?: string } {
  const sid = String(id)
  onChatStop?.(sid)
  return wsHost ? wsHost.stopChatSession(sid) : { ok: false, error: 'no workspace host' }
}
/** The chat sessions in the active workspace (always '0' + any persisted agent sessions) — for boot-resume. */
export function osChatSessionIds(): string[] {
  return wsHost ? wsHost.chatSessionIds() : ['0']
}
/** Boot: re-exec the claude terminal for every chat session on the current relay url (+ --resume). */
export function osResumeAgentsOnBoot(): void {
  wsHost?.resumeAgentsOnBoot()
}
/** Publish the current relay url to .blitzos/relay-url so reattached agents self-heal onto it (no brain to restart). */
export function osSetRelayUrl(url: string | null | undefined): void {
  wsHost?.setRelayUrl(url)
}
/** #52: group surfaces into a REAL folder on disk (mkdir + mv their files into a subdir), via the shared
 *  workspace host. Returns the host result. The reconcile that follows surfaces the new folder as a tile. */
export function osGroupIntoFolder(name: string, ids: string[], x?: number, y?: number, kind?: 'board' | 'folder'): { ok: boolean; folder?: string; moved?: number; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.group(String(name || 'Folder'), Array.isArray(ids) ? ids.map(String) : [], Number(x) || 0, Number(y) || 0, kind === 'board' ? 'board' : 'folder')
  return 'ok' in r ? r : { ok: false, error: r.error }
}
/** Drop real OS paths (files AND folders) onto the canvas — the Electron drag-drop path. Copies each
 *  into the active workspace folder (a folder copies RECURSIVELY → one collapsed tile) and reconciles
 *  at the drop point so the tiles land where dropped. The browser has no FS path, so server mode uploads
 *  bytes via /api/os/upload instead. */
export function osIngestPaths(paths: string[], x: number, y: number): { ok: boolean; copied?: number; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.ingestPaths(Array.isArray(paths) ? paths.map(String) : [], Number(x) || 0, Number(y) || 0)
  return 'ok' in r ? r : { ok: false, error: r.error }
}
/** "New Folder" / "New Board" (the right-click desktop action): make an EMPTY real folder in the active
 *  workspace and reconcile at (x,y). kind:'board' → a '.board' on-canvas folder (#54). */
export function osNewFolder(name: string, kind: 'board' | 'folder' | undefined, x: number, y: number): { ok: boolean; folder?: string; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.newFolder(String(name || 'Folder'), kind === 'board' ? 'board' : 'folder', Number(x) || 0, Number(y) || 0)
  return 'ok' in r ? r : { ok: false, error: r.error }
}
/** List a normal folder's contents for the file-manager overlay (the Electron counterpart of the server
 *  /api/os/dir route — same shared host.listDir, jailed to the active workspace). */
export function osListDir(rel: string): { path: string; entries: unknown[]; total: number; truncated: boolean } | null {
  return wsHost ? wsHost.listDir(String(rel || '')) : null
}
/** CLOSE a surface = delete its backing content file (explicit by id) so it doesn't resurrect on the next
 *  reconcile. The renderer calls this from store.closeSurface for every close (user, agent, Delete key). */
export function osCloseSurfaceFile(id: string): { ok: boolean; removed?: string } {
  return wsHost ? wsHost.closeSurfaceFile(String(id)) : { ok: false }
}
/** Agent-facing workspace control (Mission-Control parity): list / create / switch the user's folder-backed
 *  workspaces (separate desktops, each its own folder = its own memory). Lets the agent give an UNRELATED
 *  task its own clean workspace and move the user there instead of polluting the current one — the SAME
 *  shared host the human's launcher uses. */
export function osListWorkspaces(): {
  workspaces: Array<{ name: string; nodeCount: number; updatedAt: number; path: string }>
  active: string
  activePath: string
  root: string
} {
  if (!wsHost) return { workspaces: [], active: '', activePath: '', root: '' }
  // activePath = ~/Blitz/<active>; its parent is the workspaces root, so every workspace's folder is
  // join(root, name). The agent uses these absolute paths to author by writing files into a workspace.
  const activePath = wsHost.activePath()
  const root = activePath ? dirname(activePath) : ''
  return {
    workspaces: wsHost.list().map(({ name, nodeCount, updatedAt }) => ({ name, nodeCount, updatedAt, path: root ? join(root, name) : '' })),
    active: wsHost.active(),
    activePath,
    root
  }
}
/** Active workspace identity + absolute folder path + a light inventory (surface titles/kinds). Threaded
 * into create_surface's RETURN so the agent sees, at the point of action: which desktop it's on, WHERE the
 * folder is (a local agent authors by writing files into it), and what's already there (clutter-vs-
 * continuation). Content-agnostic — just the inventory; the agent decides significance. */
export function osWorkspaceContext(): { workspace: string; workspace_path: string; siblings: Array<{ id: string; title: string; kind: string }> } {
  return {
    workspace: wsHost ? wsHost.active() : cached.workspace || '',
    workspace_path: wsHost ? wsHost.activePath() : '',
    siblings: (cached.surfaces || []).map((s) => ({ id: s.id, title: s.title, kind: s.kind }))
  }
}
export function osCreateWorkspace(name: string): { ok: boolean; name?: string; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  try {
    return { ok: true, name: wsHost.create(String(name || '')).name }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'create failed' }
  }
}
export async function osSwitchWorkspace(name: string): Promise<{ ok: boolean; active?: string; error?: string }> {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = await wsHost.performSwitch(String(name || ''))
  return r.status === 200
    ? { ok: true, active: r.body.active as string | undefined }
    : { ok: false, error: r.body.error as string | undefined }
}
/** #53: per-workspace consent persistence for the Electron transports (widget grants + sensitive-read
 *  providers), via the shared host. Load on boot, persist (merge) on each grant. */
export function osLoadConsent(): { surfaces: string[]; providers: string[] } {
  return wsHost ? wsHost.consent() : { surfaces: [], providers: [] }
}
export function osPersistConsent(c: { surfaces?: string[]; providers?: string[] }): void {
  wsHost?.persistConsent(c)
}
/** The workspaces root this process runs on (set by initOsActions; '' before init). */
export function osWorkspacesRoot(): string {
  return wsRoot
}
/** Reverse-map a guest's WebContents to its surface id (anchors a permission prompt to the requesting
 *  surface). Null for the desktop renderer or an unregistered guest. */
export function osSurfaceIdForWebContents(wc: { id: number } | null | undefined): string | null {
  if (!wc || wc.id == null) return null
  for (const [sid, wcid] of webviewIds) if (wcid === wc.id) return sid
  return null
}
/** Absolute path of the active workspace folder (where a guest download lands), or null before init. */
export function osActiveWorkspaceDir(): string | null {
  return wsHost ? wsHost.activePath() : null
}
export function osGetState(): OsState {
  // Thread the active workspace identity + absolute folder PATH into every state read, so the agent always
  // knows which desktop it's on and WHERE to write files to author surfaces (the filesystem is the canvas).
  return { ...cached, workspace: wsHost ? wsHost.active() : cached.workspace, workspace_path: wsHost ? wsHost.activePath() : undefined }
}

/**
 * Act INSIDE a surface. The single dispatch core both transports (control server
 * + agent-socket) call. Keyed on surface.kind: only `web` (a <webview> guest) is
 * CDP-controllable; `app`/`srcdoc` (iframes) and `native` (React) would be driven
 * cooperatively (postMessage / store) and aren't wired yet.
 */
export function osControlSurface(id: string, action: ControlAction): Promise<ControlResult> {
  const surf = cached.surfaces.find((s) => s.id === id)
  if (surf && surf.kind !== 'web') {
    return Promise.resolve({
      ok: false,
      error: `in-window control not supported for kind "${surf.kind}" — only "web" surfaces (app/srcdoc via postMessage planned)`
    })
  }
  // web, or state not yet synced — CDP (controlWindow errors if no guest is registered)
  return controlWindow(id, action)
}

/** Send the active workspace's hydrate to the renderer (index.ts calls this on did-finish-load). */
export function osSendHydrate(): void {
  if (!wsHost) return
  send('hydrate', { surfaces: cached.surfaces || [], camera: cached.camera || { x: 0, y: 0, scale: 1 }, mode: cached.mode || 'desktop', areaCount: cached.areaCount || 1, workspace: wsHost.active() })
}
/** Serve a workspace thumbnail by name (the blitz-thumb:// protocol handler in index.ts calls this). */
export function osReadThumb(name: string): Buffer | null {
  return wsHost ? wsHost.readThumb(name) : null
}
/** Read a real workspace file for an image preview (blitz-file:// → the active workspace, jailed). */
export function osReadWorkspaceFile(rel: string): { buf: Buffer; contentType: string } | null {
  return wsHost ? wsHost.readWorkspaceFile(rel) : null
}
/** Flush a pending workspace write + stop the folder watchers on quit. */
export function osFlushWorkspace(): void {
  wsHost?.flush()
  wsHost?.stopWatch()
}
/** Capture the primary area (1440x900, centered) of the current board → store as `name`'s thumbnail. */
async function osCaptureThumb(name: string): Promise<{ ok: boolean; error?: string }> {
  const win = getWin()
  if (!win || !wsHost) return { ok: false }
  try {
    const [w, h] = win.getContentSize()
    const pw = Math.min(1440, w)
    const ph = Math.min(900, h)
    const rect = { x: Math.round((w - pw) / 2), y: Math.round((h - ph) / 2), width: pw, height: ph }
    const img = await win.webContents.capturePage(rect)
    wsHost.writeThumb(name, img.resize({ width: 480, height: 300, quality: 'good' }).toJPEG(72))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'capture failed' }
  }
}
