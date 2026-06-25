import { BrowserWindow, ipcMain, webContents, app, screen } from 'electron'
import { randomUUID } from 'crypto'
import { join, dirname, basename, resolve } from 'path'
import { controlWindow, pinchSurface, registerCdpSurface, unregisterCdpSurface, type ControlAction, type ControlResult } from './cdp'
import { emitSurfaceAction, emitUserMessage, setContentShare, dropContentShare, setWorkspaceProvider, setTickSource, resetTickBaseline, absorbTickEcho } from './events'
import { createWorkspaceHost } from './workspace-host.mjs'
import { generateAgentTitle } from './chat-titleer.mjs'
import { safeName, appendChatMessage, resolveWorkspace, readBookmarks, toggleBookmark } from './workspace.mjs'
import { readFileSync } from 'node:fs'
import { sessionJsonlPath, readSessionEvents, toolLabel } from './agent-transcript.mjs'
import { applyWfRun, type WfRunRecord } from './wf-run-state.mjs'
import * as wfStore from './wf-store.mjs'
import { snapshot as busSnapshot, hydrate as busHydrate, subCount as busSubCount, clearRun as busClearRun } from './workflow-bus.mjs'
import { tel } from './telemetry'
import { trackActivity } from './activity-logging.mjs'
import type { WebContents } from 'electron'

// A web surface is now an in-DOM <webview> guest. The renderer reports its guest WebContents id via
// os:register-webview (→ registerLiveWebContent → browserContentIds), so the agent's read/control/
// perception path can reach the live page. This resolves a surface id to that guest's WebContents.
function webContentsForSurface(surfaceId: string): WebContents | null {
  const wcid = browserContentIds.get(surfaceId)
  if (wcid == null) return null
  const wc = webContents.fromId(wcid)
  return wc && !wc.isDestroyed() ? wc : null
}

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
  /** Browser (web) tabs declared up front — opens a multi-tab browser with its strip pre-filled
   *  (the host lazy-restores: only activeTab loads, the rest load on click). */
  tabs?: Array<{ id: string; title?: string; url?: string }>
  activeTab?: number
  /** Born frontmost (effectiveZ's top focus band) — a surface the user just summoned. */
  focus?: boolean
}

export interface OsState {
  surfaces: Array<{
    id: string
    kind: string
    x: number
    y: number
    w: number
    h: number
    title: string
    url?: string
    component?: string
    z?: number
    props?: Record<string, unknown>
    pinned?: boolean
    agentId?: string
    focus?: boolean
  }>
  workspace?: string
  // The active workspace's absolute folder path (~/Blitz/<name>) — the agent's persistence root (chat.md,
  // sessions, onboarding artifacts). Surfaced so the agent knows WHERE to read/write.
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
// os:action IPC; web surfaces are main-owned WebContentsViews (onSurfaces no-op).
let wsHost: ReturnType<typeof createWorkspaceHost> | null = null
const newWorkspaceAgentStarts = new Set<string>()
// surfaceId -> the browser guest's WebContents id (so we can read/control its DOM)
const browserContentIds = new Map<string, number>()

const lifecycleWired = new Set<number>()
function registerLiveWebContent(surfaceId: string, wcid: number): void {
  browserContentIds.set(surfaceId, wcid)
  registerCdpSurface(surfaceId, wcid)
  // The <webview> guest's lifecycle: drop the registration when the guest dies. Wired once per guest.
  if (lifecycleWired.has(wcid)) return
  const wc = webContents.fromId(wcid)
  if (!wc || wc.isDestroyed()) return
  lifecycleWired.add(wcid)
  wc.once('destroyed', () => { lifecycleWired.delete(wcid); unregisterLiveWebContent(surfaceId, wcid) })
}

function unregisterLiveWebContent(surfaceId: string, wcid?: number): void {
  const existing = browserContentIds.get(surfaceId)
  if (wcid == null || existing === wcid) browserContentIds.delete(surfaceId)
  unregisterCdpSurface(surfaceId)
}

function osWebContentNavigated(id: string, url: string, title?: string): void {
  if (!surfaceExists(id)) return
  const patch = { url, ...(title ? { title } : {}) }
  cached = { ...cached, surfaces: (cached.surfaces || []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }
  send('update', { id, patch })
}

/** Wire the renderer<->main control channel. Renderer pushes state on change. */
export function initOsActions(opts: {
  /** The single app window (the renderer; every os:action/IPC send targets it). */
  getWindow: () => BrowserWindow | null
}): void {
  getWin = opts.getWindow

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
  // Supervisor tick (plans/blitzos-tick-diff-steer.md, status-only in V1): feed the perception kernel the
  // agent snapshot it diffs each tick — per-agent status + terminals (no surface geometry/props; island V1
  // has no canvas). wsHost is a module-level let; this closure reads it lazily (it's set just below), parity
  // with the setWorkspaceProvider closure above. Content-AGNOSTIC; the agent owns judgment.
  setTickSource(() => ({
    agentStatus: wsHost ? wsHost.chatStatusSnapshot() : {},
    terminals: terminalStatusProvider ? terminalStatusProvider() : [],
    workspace: wsHost ? wsHost.active() : undefined
  }))
  // Self-reaction guard (TIMING-ROBUST — replaces the old setTickSuppressed Date.now() window): the status-
  // only tick must not read a tool-origin agent-set change (a just-applied syscall) or a workspace switch as
  // a spurious agent change.
  //  - A LONE tool op (spawn_agent/close_agent changes the agent set) calls absorbTickEcho({agents}) at the
  //    op site, so the NEXT tick SKIPS exactly that delta (per-delta, no whole-tick veto → a concurrent
  //    genuine agent-status edge in the same tick still wakes), one-shot. No dependency on WHEN the tick fires.
  //  - A BULK transition (hydrate/switch/reconcile) calls resetTickBaseline() so the next tick RE-SEEDS
  //    instead of diffing a world that changed wholesale.
  // A crash (terminal exit) is never absorbed → it STILL wakes '0'.
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
    broadcast: (obj) => {
      tel('act', obj) // telemetry: the renderer's entire feed = the replayable content stream
      // A bulk transition (workspace-host reconcile/switch/hydrate) changes the world wholesale —
      // re-seed the status-only tick baseline so it never diffs it as a storm of phantom agent edges.
      const bt = (obj as { type?: unknown })?.type
      if (bt === 'reconcile' || bt === 'hydrate' || bt === 'switch') resetTickBaseline()
      sendToRenderer('os:action', obj)
    },
    onSurfaces: () => {}, // Electron web surfaces are in-DOM <webview> guests (renderer-owned)
    getActionItems: () => (actionItemsProvider ? actionItemsProvider() : []), // authoritative inbox items (index.ts wires it)
    generateAgentTitle: ({ agentId, text, workspacePath }) => generateAgentTitle({ agentId, text, workspacePath }),
    onChatStatusTransition: ({ agentId, previousStatus, status, source }) =>
      trackActivity('agent.status_changed', { agentId, previousStatus, status, source }),
    // An agent backend runs in a VISIBLE terminal; index.ts wires this from the shared agent-runtime
    // core + the terminal-ops (it owns the relay url). Absent ⇒ no agent auto-launch.
    launchAgent: (id, home, title) => launchAgentHook?.(id, home, title),
    // Archive parks an agent without deleting its terminal record; restore restarts that preserved record.
    pauseAgent: (id) => pauseAgentHook?.(id),
    restartAgent: (id) => restartAgentHook?.(id),
    // Stop an agent (when closing it) — index.ts wires this to terminal-ops.stopTerminal.
    stopAgent: (id) => stopAgentHook?.(id)
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
      const created = wsHost!.create(name)
      newWorkspaceAgentStarts.add(created.name)
      return { ok: true, name: created.name }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'create failed' }
    }
  })
  ipcMain.handle('workspace:switch', async (_e, name: string) => {
    const r = await wsHost!.performSwitch(name)
    if (r.status !== 200) return { ok: false, error: r.body.error }
    const active = String(r.body.active || '')
    if (newWorkspaceAgentStarts.delete(active)) osKickBrain('0')
    return { ok: true, active }
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
  ipcMain.handle('os:restore-chat-hub', () => osRestoreChatHub())

  ipcMain.on('os:state', (_e, state: OsState) => {
    if (state && Array.isArray(state.surfaces)) {
      wsHost?.onStatePush(state)
      // telemetry: a compact layout keyframe (~every 20s, not every push) — replay resyncs from these;
      // content fidelity comes from the 'act' stream, so heavy props are deliberately dropped here.
      if (Date.now() - lastStateKeyframe > 20_000) {
        lastStateKeyframe = Date.now()
        const s = state as unknown as { surfaces: Array<Record<string, unknown>> }
        tel('state', {
          n: s.surfaces.length,
          surfaces: s.surfaces.map((x) => ({ id: x.id, kind: x.kind, x: x.x, y: x.y, w: x.w, h: x.h, title: x.title, url: x.url }))
        })
      }
    }
  })
  // A web surface's in-DOM <webview> reports its guest WebContents id (on dom-ready) so the agent's
  // read/control/perception path can reach the live page.
  ipcMain.on('os:webview', (_e, m: { surfaceId: string; wcid: number }) => {
    if (m && m.surfaceId) registerLiveWebContent(m.surfaceId, m.wcid)
  })
  // Machine-global browser bookmarks (root journal — a bookmark isn't workspace-specific).
  ipcMain.handle('os:bookmarks', () => readBookmarks(root))
  ipcMain.handle('os:bookmarks-toggle', (_e, m: { url?: unknown; title?: unknown }) => {
    return toggleBookmark(root, { url: String(m?.url || ''), title: String(m?.title || '') })
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
    // payload is { text, agentId } (object) — tolerate a bare string (older renderer) → agent '0'.
    const text = typeof payload === 'string' ? payload : String((payload as { text?: unknown })?.text ?? '')
    const aid = payload && typeof payload === 'object' && (payload as { agentId?: unknown }).agentId != null ? String((payload as { agentId?: unknown }).agentId) : '0'
    trackActivity('chat.message_sent', { agentId: aid, messageLength: text.length, source: 'chat' })
    osUserMessage(text, aid)
  })
  // Capture a web surface's current frame (capturePage — no debugger) for folder previews.
  ipcMain.handle('surface:capture', async (_e, surfaceId: string) => {
    const wcid = browserContentIds.get(surfaceId)
    const wc = wcid == null ? webContentsForSurface(surfaceId) : webContents.fromId(wcid)
    if (!wc || wc.isDestroyed()) return null
    try {
      const img = await wc.capturePage()
      return img.toDataURL()
    } catch {
      return null
    }
  })
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
  const wcid = browserContentIds.get(id)
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

/** The ONE guarded renderer sender. During window teardown a guest's 'destroyed' event can fire
 *  while the BrowserWindow object survives in a destroyed state — `getWin()?.webContents.send`
 *  then THROWS ("Object has been destroyed", an uncaught main-process crash), because the optional
 *  chain only guards null, not destruction. Every event-driven send must come through here. */
function sendToRenderer(channel: string, payload: unknown): void {
  try {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  } catch {
    /* window mid-teardown between the checks and the send */
  }
}

function send(type: string, payload: Record<string, unknown> = {}): void {
  tel('act', { type, ...payload }) // telemetry: surface ops (create/update/move/close…) emit HERE, not via the adapter broadcast
  sendToRenderer('os:action', { type, ...payload })
}

/** Send an arbitrary os:action to the renderer — the Electron emit seam for shared cores (e.g. terminal events). */
export function osBroadcast(action: Record<string, unknown>): void {
  try {
    if (action?.type === 'terminal-spawn') {
      const terminal = action.terminal as { kind?: unknown } | undefined
      if (terminal?.kind === 'agent' && action.id != null && wsHost?.chatStatusSnapshot?.()?.[String(action.id)] === 'starting') {
        wsHost.setChatStatus(String(action.id), 'starting')
      }
    } else if (action?.type === 'terminal-data') {
      if (action.id != null) wsHost?.noteAgentActivity(String(action.id), 'terminal')
    } else if (action?.type === 'terminal-stop') {
      if (action.id != null) wsHost?.setChatStatus(String(action.id), 'stopped')
    } else if (action?.type === 'terminal-exit') {
      if (action.id != null) {
        if (Number(action.exitCode)) wsHost?.setChatStatus(String(action.id), 'error', 'crash')
        else wsHost?.setChatStatus(String(action.id), 'stopped')
      }
    } else if (action?.type === 'workflow-run') {
      // record + re-broadcast to the island (started/done) for the in-chat kanban
      osNoteWfRun(action)
      if (action.runId != null && action.agentId != null) {
        if (action.started) wsHost?.noteWorkflowRun(String(action.agentId), String(action.runId), true)
        if (action.done) wsHost?.noteWorkflowRun(String(action.agentId), String(action.runId), false)
      }
    }
  } catch {
    /* status sync is best-effort; the terminal event itself must still publish */
  }
  tel('act', action) // telemetry: session/action-item events emit here (the shared-core seam)
  sendToRenderer('os:action', action)
}

export function osNoteAgentActivity(agentId = '0', source = 'activity'): void {
  try { wsHost?.noteAgentActivity(String(agentId ?? '0'), source) } catch { /* best-effort */ }
}

/** Bare-Option (Alt) hold → the renderer's radial create menu. Fed from main's before-input-event
 *  trackers (host webContents in index.ts covers the renderer DOM + all its iframes; browser guests
 *  via webcontents-view-host onAltHold), so the gesture works no matter what holds keyboard focus.
 *  'down' carries the TRUE cursor position (screen point → UI-window content coords): the renderer's
 *  own pointermove never fires while the cursor sits over an iframe, so its cache can be stale. */
export function osRadialPhase(phase: 'down' | 'up' | 'cancel'): void {
  if (phase === 'down') {
    const win = getWin()
    if (!win || win.isDestroyed()) return
    const pt = screen.getCursorScreenPoint()
    const b = win.getContentBounds()
    sendToRenderer('os:radial', { phase, x: pt.x - b.x, y: pt.y - b.y })
  } else {
    sendToRenderer('os:radial', { phase })
  }
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
  absorbTickEcho({ surfaces: [id] }) // W2: a tool-origin props edit must not self-wake the supervisor tick — the next tick skips this surface's delta (one-shot, per-delta)
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
/** Set the OS accent theme live: the renderer applies it to chrome + plain widgets and persists it
 *  (so it survives restart). `theme` is a partial map of role → #rrggbb hex (accent, accentDeep,
 *  marker, positive, danger, info — see theme.ts THEME_ROLES). At least one valid hex required.
 *  The renderer is the source of truth for CSS vars; main only relays + lets it persist. */
export function osSetTheme(theme: Record<string, unknown>): { ok: boolean; error?: string } {
  const hex = (v: unknown): string | null => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : null)
  const out: Record<string, string> = {}
  for (const k of ['accent', 'accentDeep', 'marker', 'positive', 'danger', 'info']) {
    const h = hex((theme || {})[k])
    if (h) out[k] = h
  }
  if (!Object.keys(out).length) return { ok: false, error: 'pass at least one role as a #rrggbb hex (accent, marker, …)' }
  send('set-theme', { theme: out })
  return { ok: true }
}
/** Agent → user: append a chat message to an agent's chat.md and broadcast it to that agent's widget.
 *  `workspace` (v2 bleed fix) routes a PINNED agent's say to ITS OWN workspace's transcript: when it
 *  names a workspace that is not the active one, the message is appended to that folder's chat file
 *  directly (no broadcast — its widgets aren't live; they hydrate the transcript on switch-in). */
export function osSay(text: string, agentId = '0', workspace?: string): void {
  if (workspace && wsHost && workspace !== wsHost.active()) {
    const dir = wsRoot ? resolveWorkspace(wsRoot, workspace, { mustExist: true }) : null
    if (dir) {
      appendChatMessage(dir, 'agent', text, String(agentId))
      return
    }
    // unknown workspace name → fall through to the active chat rather than silently dropping the message
  }
  wsHost?.appendChat('agent', text, agentId)
}
export function osShareApp(app: Record<string, unknown>, agentId = '0', workspace?: string): void {
  const title = String(app?.title || '').replace(/\s+/g, ' ').trim() || 'Generated app'
  const text = `Generated app: ${title}`
  const part: Record<string, unknown> = {
    type: 'app',
    title,
    url: String(app?.url || '')
  }
  for (const key of ['subtitle', 'icon', 'tone', 'preview', 'claimUrl', 'expiresAt']) {
    const value = app?.[key]
    if (typeof value === 'string' && value.trim()) part[key] = value.trim()
  }
  const meta = { parts: [part] }
  if (workspace && wsHost && workspace !== wsHost.active()) {
    const dir = wsRoot ? resolveWorkspace(wsRoot, workspace, { mustExist: true }) : null
    if (dir) {
      appendChatMessage(dir, 'agent', text, String(agentId), meta)
      return
    }
  }
  wsHost?.appendChat('agent', text, agentId, meta)
}
/** USER → agent: enter a chat message exactly as the human composer does (append '### user' to that
 *  agent's chat.md + echo to its widget, and wake that agent with a 'message' moment). The renderer
 *  IPC and the localhost-only `user_say` test syscall both land here, so programmatic user input is
 *  indistinguishable from typed input — the test rig's input path. (No spawn hook: agents are
 *  boot-resident / spawned via spawn_agent in the Terminal/Agent model.) */
export function osUserMessage(text: string, agentId = '0'): void {
  if (!text.trim()) return
  const aid = String(agentId)
  wsHost?.appendChat('user', text, aid) // write to that agent's chat.md + echo to its widget
  emitUserMessage(text, aid) // wake ONLY that agent (trigger:'message')
  onUserMessage?.(aid)
}

// Missing-runtime notice seam (index.ts): observe user messages so a brainless install can still
// ANSWER (silence is never an acceptable reply). Deliberately NOT a spawn hook — agents launch via
// terminal-manager only; this only lets index.ts say "install claude" when nothing will reply.
let onUserMessage: ((agentId: string) => void) | null = null
export function setOnUserMessage(fn: ((agentId: string) => void) | null): void {
  onUserMessage = fn
}
/** The agent customizes a system widget UI (chat can now be html/jsx/tsx). Live-reloads. */
export function osCustomizeWidget(name: string, html: string, agentId = '0', lang: 'html' | 'jsx' | 'tsx' = 'html'): { ok: boolean; rel?: string; lang?: string; error?: string } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.customizeWidget(String(name), String(html), agentId, lang) as { ok: boolean; rel?: string; lang?: string; surfaceId?: string; error?: string }
  // W2: a tool-origin widget edit must not self-wake the supervisor tick. customizeWidget reports the
  // affected surface id (the chat widget's surface for a chat edit); absorb it so the next tick skips its
  // delta (one-shot, per-delta). The 'note' path is a doReconcile (a BULK transition the host's broadcast
  // adapter already covers via resetTickBaseline), so it has no per-surface id to absorb here.
  if (r.ok && r.surfaceId) absorbTickEcho({ surfaces: [r.surfaceId] })
  return r
}
/** Read a built-in widget's current UI source (workspace file or shipped default) — read-before-edit. */
export function osSystemUi(name: string): string | null {
  return wsHost ? wsHost.systemUi(String(name)) : null
}
export function osSystemUiInfo(name: string): { rel: string; source: string; lang: 'html' | 'jsx' | 'tsx' } | null {
  return wsHost ? (wsHost.systemUiInfo(String(name)) as { rel: string; source: string; lang: 'html' | 'jsx' | 'tsx' } | null) : null
}
let lastStateKeyframe = 0
// index.ts owns the relay url + terminal-ops, so it registers HOW to launch an agent backend in a
// tmux terminal. osActions handles the workspace-side (mint id + surface the widget); addAgent then
// calls launchAgent via the host adapter.
// home-only: every agent launches at home (0). The second arg is kept as a positional slot for the
// transport's launch backend (index.ts), but it is always 0 now (single-canvas navigation).
let launchAgentHook: ((agentId: string, home: number, title?: string) => void) | null = null
export function setLaunchAgent(fn: (agentId: string, home: number, title?: string) => void): void {
  launchAgentHook = fn
}
let stopAgentHook: ((agentId: string) => void) | null = null
export function setStopAgent(fn: (agentId: string) => void): void {
  stopAgentHook = fn
}
let pauseAgentHook: ((agentId: string) => void) | null = null
export function setPauseAgent(fn: (agentId: string) => void): void {
  pauseAgentHook = fn
}
let restartAgentHook: ((agentId: string) => void) | null = null
export function setRestartAgent(fn: (agentId: string) => void): void {
  restartAgentHook = fn
}
// Re-exec a running agent with a FRESH context. The onboarding director calls this at the
// interview→resident HANDOFF; the transport wires it to a session-id rotation + restart, so the resident
// boots a clean conversation and rebuilds state from profile.md + board.json + chat.md
// (its bootstrap reads them), at the resident effort (xhigh). The full interview transcript stays in
// chat.md, so nothing is lost.
let clearBrainContextHook: ((agentId: string) => void) | null = null
export function setClearBrainContext(fn: (agentId: string) => void): void {
  clearBrainContextHook = fn
}
// The authoritative action-items list, wired by index.ts (osActions can't import electronActionItems — that
// lives in electron-os-tools, which imports osActions). The host reconciles the inbox surface against it.
let actionItemsProvider: (() => unknown[]) | null = null
export function setActionItemsProvider(fn: () => unknown[]): void {
  actionItemsProvider = fn
}
// The live terminal list (id/status/exitCode), wired by index.ts (osActions can't import electronTerminalOps —
// terminal-ops lives in electron-os-tools, which imports osActions). Feeds the W2 supervisor tick's
// terminal-exit + agent-added/closed diff. Absent ⇒ the tick sees no terminals (degrades to surface/status only).
let terminalStatusProvider: (() => Array<{ id: string; status?: string; exitCode?: number | null }>) | null = null
export function setTerminalStatusProvider(fn: () => Array<{ id: string; status?: string; exitCode?: number | null }>): void {
  terminalStatusProvider = fn
}
/** The current per-agent chat status map ({ id -> status }) — the agent-state half of the W2 tick snapshot,
 *  also handy as a standalone accessor. Empty until the workspace host exists. */
export function osAgentStatus(): Record<string, string> {
  return wsHost ? wsHost.chatStatusSnapshot() : {}
}
/** DEBUG ONLY (Settings → Simulate agent status): set a real chat status on an agent through the SAME path a
 *  terminal-exit/api-error uses (setChatStatus → updateChatHubState broadcasts the full status map), so the
 *  injected status flows to every surface. 'reconnecting' is NOT a chat status — index.ts routes that to the
 *  wake-watchdog override instead. */
export function osDebugSetChatStatus(agentId: string, status: 'error' | 'waiting' | 'watching' | 'idle', cause?: string): { ok: boolean } {
  return wsHost?.setChatStatus(String(agentId), status, cause) || { ok: false }
}
/** Surface a REAL, sticky chat error (red dot + the cause's "title + hint" detail card) for an agent, through the
 *  same setChatStatus path applyClaudeTurnError uses. For errors detected OUTSIDE the session JSONL — e.g. a Claude
 *  Code auth 401 that only ever appears in the agent's terminal (the wake-watchdog's onAuthError calls this). The
 *  status clears on the next real user message, exactly like a JSONL-detected api-error. */
export function osSurfaceChatError(agentId: string, cause: string): { ok: boolean } {
  return wsHost?.setChatStatus(String(agentId), 'error', cause) || { ok: false }
}
export function osClearBrainContext(agentId = '0'): void {
  clearBrainContextHook?.(String(agentId))
}
/** The dynamic island's milestone provider (set by the narrator at boot). id -> [{id,ts,kind,text}]. */
type IslandMilestone = { id: string; ts: number; kind: string; text: string }
let milestonesProvider: ((id: string) => IslandMilestone[]) | null = null
export function setMilestonesProvider(fn: ((id: string) => IslandMilestone[]) | null): void {
  milestonesProvider = fn
}

// The island's workflow-run registry. workflow-host broadcasts {type:'workflow-run',...} → osBroadcast → here:
// we fold started/done + skeleton per (agentId, runId) through the shared applyWfRun rule. The registry is a
// CACHE over the durable on-disk store (wf-store: index.json + events.jsonl + skeleton.json) — disk is the source
// of truth. On each broadcast we also write the run's index entry; a memory-eviction sweep (osSweepWfMemory)
// drops done runs whose tab has been unviewed for WF_MEM_TTL_MS, and osLoadAgentRuns / osWfHydrateIfCold rebuild
// boards from disk on demand. So a finished or long-past board never vanishes (the old 30s-after-done drop did
// exactly that). Running runs + actively-watched runs are never evicted.
export type IslandWfRun = { runId: string; agentId: string; file: string; startedAt: number; done: boolean; ok: boolean; skeleton: unknown[]; memDir: string | null; stats?: { ms: number; calls: number; tokens: number } | null }
const _wfRuns = new Map<string, IslandWfRun>() // runId -> run (cache; rebuilt from disk after eviction/relaunch)
const _wfRunsByAgent = new Map<string, string[]>() // agentId -> runIds (most-recent-last)
// runId -> memDir cache (the run's absolute, main-minted memory dir): closes the path-traversal boundary
// (os:wf-leaf resolves memDir HERE by runId, never from the renderer) AND lets a relaunch hydrate from disk.
// On a cold start this is empty and memDir is recovered from index.json (osWfMemDirFor). Capped.
const _wfMemDirs = new Map<string, string>()
const WF_MEMDIR_CAP = 1000
const WF_MEM_TTL_MS = 15 * 60_000 // drop a done run's in-memory state this long after its tab was last viewed
const _tabLastViewed = new Map<string, number>() // agentId -> last time the user viewed that tab (renderer ping)
const _wfReconciledDirs = new Set<string>() // workflows dirs whose orphaned (done:false) runs were healed this session
/** Cache a run's memDir under the cap (the ONE place the WF_MEMDIR_CAP eviction lives, shared by every writer). */
function cacheWfMemDir(runId: string, memDir: string | null): void {
  if (!memDir) return
  _wfMemDirs.set(runId, memDir)
  if (_wfMemDirs.size > WF_MEMDIR_CAP) { const oldest = _wfMemDirs.keys().next().value; if (oldest != null) _wfMemDirs.delete(oldest) }
}
/** Register a run into the in-memory registry (idempotent; never clobbers a live entry) so the eviction sweep —
 *  which only iterates _wfRunsByAgent — also covers runs rebuilt from disk on tab-open. Without this, a cold
 *  (post-relaunch / evicted) run that gets hydrated into the bus would never be swept and would leak until quit. */
function registerWfRun(run: IslandWfRun): void {
  if (!_wfRuns.has(run.runId)) _wfRuns.set(run.runId, run)
  const list = _wfRunsByAgent.get(run.agentId) || []
  if (!list.includes(run.runId)) { list.push(run.runId); _wfRunsByAgent.set(run.agentId, list) }
}

/** Record a workflow-run broadcast (started or done). Called from osBroadcast. Folds through the shared
 *  applyWfRun rule (so main + the renderer agree), caches the memDir, and persists the durable index entry. */
export function osNoteWfRun(action: Record<string, unknown>): void {
  const runId = String(action.runId || '')
  if (!runId) return
  const agentId = String(action.agentId ?? '0')
  const prev = _wfRuns.get(runId)
  const next = applyWfRun(prev as WfRunRecord | undefined, action) as IslandWfRun | null
  if (!next) return
  _wfRuns.set(runId, next)
  cacheWfMemDir(runId, next.memDir)
  const list = _wfRunsByAgent.get(agentId) || []
  if (!list.includes(runId)) { list.push(runId); _wfRunsByAgent.set(agentId, list) }
  // DURABLE INDEX (disk = source of truth): write/merge the run's entry on every started/done transition. The
  // workflows dir is the memDir's parent, so the index lives in the run's OWN workspace (robust across switches).
  if (next.memDir) {
    try {
      wfStore.writeIndexEntry(wfStore.workflowsDirOf(next.memDir), runId, {
        agentId, file: next.file, startedAt: next.startedAt, done: next.done, ok: next.ok, memDir: next.memDir, stats: next.stats ?? null
      })
    } catch {
      /* best-effort — a board failing to persist must never break the run */
    }
  }
}
/** The trusted absolute memDir for a run (main-minted), or null. The drawer's leaf read resolves the path HERE
 *  by runId — the renderer never supplies a filesystem path, so there is no path-traversal surface. */
export function osWfRunMemDir(runId: string): string | null {
  return _wfMemDirs.get(String(runId || '')) || null
}
function wfRunsForAgent(id: string): IslandWfRun[] {
  const list = _wfRunsByAgent.get(String(id || '0')) || []
  return list.map((rid) => _wfRuns.get(rid)).filter((r): r is IslandWfRun => !!r)
}

// ── Workflow-board memory lifecycle (disk = source of truth, memory = cache) ───────────────────────────────
/** The workflows dir for the ACTIVE workspace (the reload path when no in-session memDir is cached, e.g. relaunch). */
function osWorkflowsDir(): string | null {
  const ws = osActiveWorkspaceDir()
  return ws ? join(ws, '.blitzos', 'workflows') : null
}
/** The run's absolute memDir: the in-session cache first, else the durable index (so it resolves after relaunch). */
function osWfMemDirFor(runId: string): string | null {
  const id = String(runId || '')
  const live = _wfMemDirs.get(id)
  if (live) return live
  const dir = osWorkflowsDir()
  if (!dir) return null
  const e = wfStore.readIndex(dir)[id]
  return e && e.memDir ? String(e.memDir) : null
}
/** The renderer pings the active agent id whenever its tab is viewed; the sweep keeps that tab's runs cached. */
export function osNoteTabViewed(agentId: string): void {
  _tabLastViewed.set(String(agentId ?? '0'), Date.now())
}
/** Drop DONE runs' in-memory state (registry + bus buffer) for tabs unviewed past WF_MEM_TTL_MS. Disk is never
 *  touched (index.json + events.jsonl stay), so re-viewing the tab reloads the boards identically. Running runs
 *  and actively-watched (mounted board) runs are NEVER evicted. Returns the count dropped (for the test). */
export function osSweepWfMemory(now = Date.now()): number {
  let dropped = 0
  for (const [agentId, runIds] of [..._wfRunsByAgent]) {
    if (now - (_tabLastViewed.get(agentId) || 0) <= WF_MEM_TTL_MS) continue // tab seen recently — keep the cache warm
    for (const rid of runIds.slice()) {
      const r = _wfRuns.get(rid)
      if (!r || !r.done) continue // never evict a running run
      if (busSubCount(rid) > 0) continue // a mounted board is watching this run — don't yank it
      _wfRuns.delete(rid)
      const i = runIds.indexOf(rid); if (i >= 0) runIds.splice(i, 1)
      try { busClearRun(rid) } catch { /* best-effort */ }
      dropped++
    }
    if (!runIds.length) _wfRunsByAgent.delete(agentId)
  }
  return dropped
}
/** Seed the bus from disk if a run is cold (not live/hydrated), so os:wf-snapshot / os:wf-subscribe transparently
 *  serve a frozen board with NO board-side changes. Called by the IPC handlers before they read/stream a run. */
export function osWfHydrateIfCold(runId: string): void {
  const id = String(runId || '')
  if (!id) return
  try {
    if (busSnapshot(id).length) return // already live or hydrated
    const memDir = osWfMemDirFor(id)
    if (!memDir) return
    cacheWfMemDir(id, memDir) // cache it so the drawer resolves leaves too
    const events = wfStore.readEventsLog(memDir)
    if (events.length) busHydrate(id, events)
  } catch {
    /* best-effort */
  }
}
/** Load an agent's runs for the island on tab-open: the durable disk index MERGED with the live registry (live
 *  wins — a running/fresh run is most current). Stamps the tab viewed. Returns chronological (transcript order). */
export function osLoadAgentRuns(agentId: string): IslandWfRun[] {
  const aid = String(agentId ?? '0')
  osNoteTabViewed(aid)
  const byId = new Map<string, IslandWfRun>()
  try {
    const dir = osWorkflowsDir()
    if (dir) {
      // Heal orphaned (done:false) runs ONCE per workflows dir per session before reading: a hosted run is
      // in-process, so any done:false entry on disk is from a prior session that died before writing `done` (the
      // app, clean-quit OR crash, takes the run with it). Without this they'd render a phantom 'workflow running'
      // board forever. Shield this session's genuinely-live runs (_wfRuns) so a running run is never force-failed.
      if (!_wfReconciledDirs.has(dir)) {
        _wfReconciledDirs.add(dir)
        try { wfStore.reconcileOrphanRuns(dir, (rid: string) => _wfRuns.has(rid)) } catch { /* best-effort */ }
      }
      for (const r of wfStore.listAgentRuns(dir, aid)) byId.set(r.runId, r as IslandWfRun)
    }
  } catch {
    /* disk best-effort */
  }
  for (const r of wfRunsForAgent(aid)) byId.set(r.runId, r) // live overrides disk
  for (const r of byId.values()) {
    cacheWfMemDir(r.runId, r.memDir) // cache memDirs for the drawer + hydration (under the cap)
    registerWfRun(r) // put disk-rebuilt runs in the registry so the 15-min sweep can later evict them (no leak)
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt)
}

/** Resolve an agent's canonical Claude session id (for locating its transcript jsonl). It lives in the
 *  terminal-manager's per-agent meta (`<ws>/.blitzos/terminals/<id>/meta.json`), the SAME file it owns. */
export function osAgentClaudeSid(id: string): string | null {
  try {
    const root = osActiveWorkspaceDir()
    if (!root) return null
    const meta = JSON.parse(readFileSync(join(root, '.blitzos', 'terminals', String(id), 'meta.json'), 'utf8'))
    return (meta && typeof meta.claudeSessionId === 'string' && meta.claudeSessionId) || null
  } catch {
    return null
  }
}

/** One-shot snapshot for the dynamic island on open: the full session roster + per-session transcripts +
 *  status + the narrator's milestone timelines, mirroring the live `{type:'chat'}`/`{type:'milestone'}`
 *  broadcasts. The island calls this once, then rides the broadcasts for live updates. */
export function osAgentsSnapshot(): {
  sessions: Array<Record<string, unknown>>
  archivedSessions: Array<Record<string, unknown>>
  threads: Record<string, Array<Record<string, unknown>>>
  status: Record<string, string>
  errors: Record<string, { cause: string; title: string; hint: string; retryable: boolean }>
  milestones: Record<string, IslandMilestone[]>
  runs: Record<string, IslandWfRun[]>
} {
  const empty = { sessions: [], archivedSessions: [], threads: {}, status: {}, errors: {}, milestones: {}, runs: {} }
  if (!wsHost) return empty
  try {
    const p = wsHost.chatHubProps() as {
      sessions?: Array<Record<string, unknown>>
      archivedSessions?: Array<Record<string, unknown>>
      threads?: Record<string, Array<Record<string, unknown>>>
      status?: Record<string, string>
      errors?: Record<string, { cause: string; title: string; hint: string; retryable: boolean }>
    }
    const sessions = p.sessions || []
    const milestones: Record<string, IslandMilestone[]> = {}
    if (milestonesProvider) {
      for (const s of sessions) {
        try {
          milestones[String(s.id)] = milestonesProvider(String(s.id)) || []
        } catch {
          /* per-agent best-effort */
        }
      }
    }
    const runs: Record<string, IslandWfRun[]> = {}
    for (const s of sessions) {
      try {
        const r = wfRunsForAgent(String(s.id))
        if (r.length) runs[String(s.id)] = r
      } catch {
        /* per-agent best-effort */
      }
    }
    return { sessions, archivedSessions: p.archivedSessions || [], threads: p.threads || {}, status: p.status || {}, errors: p.errors || {}, milestones, runs }
  } catch {
    return empty
  }
}

/** The raw "what it did" rows for the island's per-session Details expand: the agent's recent tool calls
 *  (Grep/Edit/Run …), read deterministically from its canonical transcript. No LLM. */
export function osAgentDetails(id: string): { rows: Array<{ label: string }> } {
  try {
    const root = osActiveWorkspaceDir()
    const jsonl = sessionJsonlPath(root, osAgentClaudeSid(id))
    const { events } = readSessionEvents(jsonl, 0)
    const rows = events
      .filter((e) => e.kind === 'tool')
      .slice(-40)
      .map((e) => ({ label: toolLabel((e as { row: Parameters<typeof toolLabel>[0] }).row) }))
    return { rows }
  } catch {
    return { rows: [] }
  }
}
/** Ensure an agent is up WITHOUT a chat message — the onboarding director uses this to start the
 *  resident interviewer at board-ready (its standing duty rides the bootstrap). Re-execs via the tmux
 *  launcher (replaces any stale terminal); no-op when no launcher is wired. */
export function osKickBrain(agentId = '0'): void {
  launchAgentHook?.(String(agentId), 0) // home-only: every agent launches at home (0)
}
/** Open a new agent: mint its id, register + live-surface its chat widget; addAgent launches
 *  its managed terminal (via the launchAgent seam). focus:true (a USER '+ Agent') follows the camera to it. */
export function osSpawnAgent(title?: string, focus = false, orchestrators = false): { id: string; title: string } {
  if (!wsHost) throw new Error('no workspace host')
  const id = wsHost.newAgentId()
  absorbTickEcho({ agents: [id] }) // W2: a tool-origin spawn changes the agent SET — the next tick skips this add (one-shot); a real status edge still wakes
  // The ORCHESTRATORS toggle is stamped onto the agent's meta by addAgent BEFORE its terminal launches, so the
  // first bootstrap already carries the orchestrator duty (bootTaskProvider reads it) — no post-spawn re-exec.
  const opts: { focus: boolean; orchestrators?: boolean } = { focus }
  if (orchestrators) opts.orchestrators = true
  wsHost.addAgent(id, title, opts)
  return { id, title: title || 'New Agent' }
}
/** Toggle the ORCHESTRATORS (dynamic-workflows) capability on an agent — delivery B (the plan): set the DURABLE
 *  meta flag (so every future launch bootstraps the orchestrator duty + spawnTerminal carries it across re-exec),
 *  then WAKE the live agent now with a short pointer to .blitzos/orchestrator.md so it gains the capability THIS
 *  session without a disruptive re-exec. The on=false path clears the flag + tells the agent to stop. */
export function osSetOrchestrators(agentId: string, on = true): { ok: boolean; error?: string; orchestrators?: boolean } {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = wsHost.setAgentOrchestrators(String(agentId), !!on)
  if (!r.ok) return r
  // Delivery B live-wake: the durable flag is already persisted; this message lands in the agent's chat and wakes
  // ONLY it (osUserMessage = the steer path). Keep it short — the full how-to is the on-disk .blitzos/orchestrator.md.
  const msg = on
    ? 'Orchestrators ENABLED: you can now AUTHOR and RUN workflows (Claude Code workflow style) for genuinely hard, large, massively parallel, or adversarial tasks. Write a `workflow.js` that starts with `export const meta = {…}`, uses the injected globals `agent()`/`parallel`/`pipeline`/`phase`/`log` (NO imports), and ends with `return`; `agent({schema})` returns a validated object. The runner is `.blitzos/blitz` — run `bash .blitzos/blitz capabilities` FIRST, then `bash .blitzos/blitz check <wf.js>`; then RUN it with the `run_workflow` syscall (`run_workflow { file }`), NOT `bash .blitzos/blitz run` and NOT your built-in Workflow tool — only `run_workflow` is visible to BlitzOS (it tracks the run); the other two run invisibly. Narrate progress with `say`; an in-chat kanban board appears automatically while the run executes (you do not control it; it is durable and survives reopen/relaunch). The full how-to is in `.blitzos/orchestrator.md`. For trivial/one-shot requests, just answer directly.'
    : 'Orchestrators DISABLED: stop authoring/running workflows; handle requests directly in chat.'
  try { osUserMessage(msg, String(agentId)) } catch { /* the flag still persisted; the duty lands on the next launch */ }
  return r
}
/** Close a non-primary agent (stop its backend + remove its widget and files). */
export function osCloseAgent(agentId: string): { ok: boolean; error?: string } {
  absorbTickEcho({ agents: [String(agentId)] }) // W2: a tool-origin close changes the agent SET — the next tick skips this close (one-shot, per-delta)
  return wsHost ? wsHost.closeAgent(agentId) : { ok: false, error: 'no workspace host' }
}
/** Archive a non-primary agent: hide it from active tabs but keep files and terminal metadata. */
export function osArchiveAgent(agentId: string): { ok: boolean; error?: string; archived?: boolean } {
  absorbTickEcho({ agents: [String(agentId)] })
  return wsHost ? wsHost.archiveAgent(agentId) : { ok: false, error: 'no workspace host' }
}
/** Restore a non-primary archived agent to the active tab list. */
export function osUnarchiveAgent(agentId: string): { ok: boolean; error?: string; archived?: boolean } {
  absorbTickEcho({ agents: [String(agentId)] })
  return wsHost ? wsHost.unarchiveAgent(agentId) : { ok: false, error: 'no workspace host' }
}
/** Rename an agent (cosmetic title). */
export function osRenameAgent(agentId: string, newTitle: string): { ok: boolean; error?: string; title?: string } {
  return wsHost ? wsHost.renameAgent(agentId, newTitle) : { ok: false, error: 'no workspace host' }
}
/** Boot: re-exec every agent terminal on the current relay url. */
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
export function osRenameFolder(path: string, name: string): { ok: boolean; path?: string; error?: string } {
  return wsHost ? wsHost.renameFolder(String(path || ''), String(name || '')) : { ok: false, error: 'no workspace host' }
}
export function osMoveIntoFolder(folderPath: string, ids: string[]): { ok: boolean; moved?: number; skipped?: number; movedIds?: string[]; skippedIds?: string[]; error?: string } {
  return wsHost ? wsHost.moveIntoFolder(String(folderPath || ''), Array.isArray(ids) ? ids.map(String) : []) : { ok: false, error: 'no workspace host' }
}
export function osMoveOutOfFolder(paths: string[], x?: number, y?: number): { ok: boolean; moved?: number; skipped?: number; movedPaths?: string[]; skippedPaths?: string[]; pathMoves?: Array<{ from: string; to: string }>; surfaceIds?: string[]; surfaces?: Record<string, unknown>[]; updatedIds?: string[]; updatedSurfaces?: Record<string, unknown>[]; error?: string } {
  return wsHost ? wsHost.moveOutOfFolder(Array.isArray(paths) ? paths.map(String) : [], Number(x) || 0, Number(y) || 0) : { ok: false, error: 'no workspace host' }
}
export function osOpenFolderEntry(path: string, x?: number, y?: number): { ok: boolean; id?: string; surface?: Record<string, unknown>; error?: string } {
  return wsHost ? wsHost.openFolderEntry(String(path || ''), Number(x) || 0, Number(y) || 0) : { ok: false, error: 'no workspace host' }
}
/** List a normal folder's contents for the file-manager overlay (the Electron counterpart of the server
 *  /api/os/dir route — same shared host.listDir, jailed to the active workspace). */
export function osListDir(rel: string): { path: string; entries: unknown[]; total: number; truncated: boolean } | null {
  return wsHost ? wsHost.listDir(String(rel || '')) : null
}
/** Listeners notified when ANY surface closes — the single chokepoint (user X, agent, Delete key all call
 *  osCloseSurfaceFile). The connection layer subscribes so closing a connection's representation widget
 *  drops the connection (instead of leaking the live adapter). */
const surfaceClosedListeners: Array<(id: string) => void> = []
export function onSurfaceClosed(fn: (id: string) => void): void {
  if (typeof fn === 'function') surfaceClosedListeners.push(fn)
}
/** CLOSE a surface = delete its backing content file (explicit by id) so it doesn't resurrect on the next
 *  reconcile. The renderer calls this from store.closeSurface for every close (user, agent, Delete key). */
export function osCloseSurfaceFile(id: string): { ok: boolean; removed?: string } {
  for (const fn of surfaceClosedListeners) {
    try {
      fn(String(id))
    } catch {
      /* a listener must never break a close */
    }
  }
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
    const created = wsHost.create(String(name || ''))
    newWorkspaceAgentStarts.add(created.name)
    return { ok: true, name: created.name }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'create failed' }
  }
}
export async function osSwitchWorkspace(name: string): Promise<{ ok: boolean; active?: string; error?: string }> {
  if (!wsHost) return { ok: false, error: 'no workspace host' }
  const r = await wsHost.performSwitch(String(name || ''))
  if (r.status !== 200) return { ok: false, error: r.body.error as string | undefined }
  const active = String(r.body.active || '')
  if (newWorkspaceAgentStarts.delete(active)) osKickBrain('0')
  return { ok: true, active }
}
/** The workspaces root this process runs on (set by initOsActions; '' before init). */
export function osWorkspacesRoot(): string {
  return wsRoot
}
/** Reverse-map a guest's WebContents to its surface id (anchors a permission prompt to the requesting
 *  surface). Null for the desktop renderer or an unregistered guest. */
export function osSurfaceIdForWebContents(wc: { id: number } | null | undefined): string | null {
  if (!wc || wc.id == null) return null
  for (const [sid, wcid] of browserContentIds) if (wcid === wc.id) return sid
  return null
}
/** Absolute path of the active workspace folder (where a guest download lands), or null before init. */
export function osActiveWorkspaceDir(): string | null {
  return wsHost ? wsHost.activePath() : null
}
/** Read one terminal leaf's captured record (Asked/Did/Returned) for the island kanban drill-in drawer.
 *  `memDir` is the run's absolute memory dir (from the run record, trusted — main minted it via workflowMemDir);
 *  resolving from it (NOT the active workspace) keeps the drawer correct across workspace switches. `runId`/
 *  `nodeId` are validated against a safe charset to block path traversal (they originate from a renderer click,
 *  a privilege boundary). Returns { leaf } or null when capture is off / the leaf hasn't finished / missing. */
const _LEAF_ID_RE = /^[\w.-]+$/
export function osReadLeaf(memDir: string | null, runId: string, nodeId: string): { leaf: Record<string, unknown> } | null {
  if (!memDir || !runId || nodeId == null) return null
  const rid = String(runId)
  const nid = String(nodeId)
  if (!_LEAF_ID_RE.test(rid) || !_LEAF_ID_RE.test(nid)) return null // block ../ traversal
  const f = join(memDir, 'leaves', nid + '.json')
  try {
    const leaf = JSON.parse(readFileSync(f, 'utf8'))
    if (leaf && typeof leaf === 'object') return { leaf: leaf as Record<string, unknown> }
    return null
  } catch {
    return null
  }
}
export function osGetState(): OsState {
  // Thread the active workspace identity + absolute folder PATH into every state read, so the agent always
  // knows which desktop it's on and WHERE to write files to author surfaces (the filesystem is the canvas).
  return { ...cached, workspace: wsHost ? wsHost.active() : cached.workspace, workspace_path: wsHost ? wsHost.activePath() : undefined }
}

/**
 * Act INSIDE a surface. The single dispatch core both transports (control server
 * + agent-socket) call. Keyed on surface.kind: only `web` (a WebContentsView guest) is
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

/** Optional rewriter applied to each surface in a hydrate payload — the connection layer uses it to repaint
 *  a persisted connection widget to a "disconnected" state when its connection isn't live (boot / switch). */
let hydrateSurfaceRewriter: ((s: Record<string, unknown>) => Record<string, unknown> | null) | null = null
export function setHydrateSurfaceRewriter(fn: (s: Record<string, unknown>) => Record<string, unknown> | null): void {
  hydrateSurfaceRewriter = typeof fn === 'function' ? fn : null
}
/** Send the active workspace's hydrate to the renderer (index.ts calls this on did-finish-load). */
export function osSendHydrate(): void {
  if (!wsHost) return
  let surfaces = wsHost.hydrateSurfaces() as Array<Record<string, unknown>>
  if (hydrateSurfaceRewriter) {
    surfaces = surfaces.map((s) => {
      try {
        return hydrateSurfaceRewriter!(s) || s
      } catch {
        return s
      }
    })
  }
  send('hydrate', { surfaces, workspace: wsHost.active() })
}
export function osRestoreChatHub(): { ok: boolean; id?: string; error?: string } {
  try {
    return wsHost ? wsHost.restoreChatHub() : { ok: false, error: 'workspace host not ready' }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'restore chat failed' }
  }
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
/** Capture the home frame (1440x900, centered) of the current board → store as `name`'s thumbnail. */
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
