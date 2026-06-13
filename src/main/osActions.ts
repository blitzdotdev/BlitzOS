import { BrowserWindow, ipcMain, webContents, app, screen } from 'electron'
import { randomUUID } from 'crypto'
import { join, dirname, basename, resolve } from 'path'
import { controlWindow, registerCdpSurface, unregisterCdpSurface, type ControlAction, type ControlResult } from './cdp'
import { dropConsent } from './widgets'
import { ingestSignals, ingestCanvasOps, emitSurfaceAction, emitUserMessage, emitAnnotation, setContentShare, dropContentShare, setWorkspaceProvider, INJECT, DRAIN } from './events'
import { createWorkspaceHost } from './workspace-host.mjs'
import { safeName, appendChatMessage, resolveWorkspace, readBookmarks, toggleBookmark } from './workspace.mjs'
import { tel } from './telemetry'
import {
  closeWebContentsView,
  focusWebContentsView,
  initWebContentsViewHost,
  navigateWebContentsView,
  syncWebContentsViewTabs,
  updateWebContentsViewBounds,
  webContentsForSurface,
  webContentsViewNavAction,
  type TabDecl
} from './webcontents-view-host'

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
  /** A tile on the stage slot lattice — geometry derives from the cell (stage-core). */
  slot?: { col: number; row: number; size: string }
  slotStage?: number
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
    slot?: { col: number; row: number; size: string }
    slotStage?: number
    pinned?: boolean
    agentId?: string
    focus?: boolean
  }>
  camera?: { x: number; y: number; scale: number }
  view?: { cx: number; cy: number }
  mode?: string
  // #45 workspace stages: how many tiled desktops + which is active + the current one's world rect (so
  // the agent places surfaces in the stage the human is looking at, not blindly at the origin).
  stageCount?: number
  /** Reading order of stages on the splay lattice (stageOrder[orderIndex] = stage id); persisted. */
  stageOrder?: number[]
  /** Last bulk layout transaction (stage reorder) — perception treats the push as ONE gesture. */
  bulkAt?: number
  currentStage?: number
  currentStageRect?: { x: number; y: number; w: number; h: number }
  workspace?: string
  // The active workspace's absolute folder path (~/Blitz/<name>). The filesystem IS the canvas: a LOCAL
  // agent authors surfaces by writing files INTO this folder (.html=panel, .md=note, .weblink=web) and the
  // host's watcher materializes them in ~250ms. Surfaced so the agent knows WHERE to write.
  workspace_path?: string
}

let getWin: () => BrowserWindow | null = () => null
// The sandwich's L0 (pages) window — where page WebContentsViews live. getWin() stays the UI window
// (the renderer face); these two are different windows by design (plans/blitzos-sandwich-compositor.md).
let getPagesWin: () => BrowserWindow | null = () => null
let sandwichFocus: { focusPages: () => void; focusUi: () => void; dragShell: (op: 'start' | 'move', dx: number, dy: number) => void } = {
  focusPages: () => {},
  focusUi: () => {},
  dragShell: () => {}
}
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
// os:action IPC; web surfaces are main-owned WebContentsViews (onSurfaces no-op); mode 'desktop'.
let wsHost: ReturnType<typeof createWorkspaceHost> | null = null
// surfaceId -> the browser guest's WebContents id (so we can read/control its DOM)
const browserContentIds = new Map<string, number>()

function registerLiveWebContent(surfaceId: string, wcid: number): void {
  browserContentIds.set(surfaceId, wcid)
  registerCdpSurface(surfaceId, wcid)
  ensureCapture(surfaceId)
  ensureNavEmitter(surfaceId, wcid)
}

function unregisterLiveWebContent(surfaceId: string, wcid?: number): void {
  const existing = browserContentIds.get(surfaceId)
  if (wcid == null || existing === wcid) browserContentIds.delete(surfaceId)
  unregisterCdpSurface(surfaceId)
  const iv = captureIntervals.get(surfaceId)
  if (iv) clearInterval(iv)
  captureIntervals.delete(surfaceId)
}

function osWebContentNavigated(id: string, url: string, title?: string): void {
  if (!surfaceExists(id)) return
  const patch = { url, ...(title ? { title } : {}) }
  cached = { ...cached, surfaces: (cached.surfaces || []).map((s) => (s.id === id ? { ...s, ...patch } : s)) }
  send('update', { id, patch })
}

/** Wire the renderer<->main control channel. Renderer pushes state on change. */
export function initOsActions(opts: {
  /** L1 — the transparent UI window (the renderer; every os:action/IPC send targets it). */
  getWindow: () => BrowserWindow | null
  /** L0 — the pages window (where the browser WebContentsViews live). */
  getPagesWindow: () => BrowserWindow | null
  /** Keyboard handoff: typing into a page vs back to the UI (the attached child stays on top). */
  focusPages: () => void
  focusUi: () => void
  /** Titlebar drag protocol → moves the PARENT window (sandwich.ts). */
  dragShell: (op: 'start' | 'move', dx: number, dy: number) => void
}): void {
  getWin = opts.getWindow
  getPagesWin = opts.getPagesWindow
  sandwichFocus = { focusPages: opts.focusPages, focusUi: opts.focusUi, dragShell: opts.dragShell }

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
    broadcast: (obj) => {
      tel('act', obj) // telemetry: the renderer's entire feed = the replayable content stream
      // bulk transitions flow over THIS seam (workspace-host reconcile/switch) — suppress the
      // canvas-gesture differ for a beat so a folder-wide change never reads as human gestures
      const bt = (obj as { type?: unknown })?.type
      if (bt === 'reconcile' || bt === 'hydrate' || bt === 'switch') canvasBulkAt = Date.now()
      sendToRenderer('os:action', obj)
    },
    onSurfaces: () => {}, // Electron browser guests are hosted by webcontents-view-host.ts
    getActionItems: () => (actionItemsProvider ? actionItemsProvider() : []), // authoritative inbox items (index.ts wires it)
    defaultMode: 'canvas', // BlitzOS is canvas-first: new Electron boards open on the infinite canvas
    // An agent backend runs in a VISIBLE terminal in its stage; index.ts wires this from the shared
    // agent-runtime core + the terminal-ops (it owns the relay url). Absent ⇒ no agent auto-launch.
    launchAgent: (id, stage, title) => launchAgentHook?.(id, stage, title),
    // Stop an agent (when closing it) — index.ts wires this to terminal-ops.stopTerminal.
    stopAgent: (id) => stopAgentHook?.(id)
  })
  wsHost.hydrateOnBoot()
  wsHost.startWatch()

  initWebContentsViewHost({
    getWindow: getPagesWin, // views live in the sandwich's L0 (pages) window, under the UI layer
    // Per-tab page state → the renderer chrome (tab strip / navbar). The ACTIVE tab's url/title also
    // fold into the surface itself (the agent + .weblink persistence contract is unchanged by tabs).
    onTabState: (surfaceId, tabId, patch, isActive) => {
      sendToRenderer('os:web-tab', { surfaceId, tabId, patch })
      if (isActive && patch.url) osWebContentNavigated(surfaceId, patch.url, patch.title)
    },
    onTabGone: (surfaceId, tabId) => sendToRenderer('os:web-tab', { surfaceId, tabId, removed: true }),
    // CDP + perception always follow the surface's ACTIVE tab — one live target per surface. Fired
    // on tab switch AND on the active tab's every dom-ready (same wcId): the re-register re-injects
    // the perception sensors a navigation destroyed, so don't dedupe on wcId.
    onActiveContent: (surfaceId, wcId) => {
      unregisterLiveWebContent(surfaceId)
      if (wcId != null) registerLiveWebContent(surfaceId, wcId)
    },
    // A link-disposition popup opens as a NEW TAB of its surface (browser semantics). The renderer
    // owns the tab list, so it materializes the tab and syncs back.
    onOpenTab: (surfaceId, url) => sendToRenderer('os:web-tab', { surfaceId, openTab: { url } }),
    // Page cursor feedback: the UI window owns the OS cursor (it is the window under the mouse), so
    // the page's cursor changes (text beam, link hand) mirror onto the hole div's CSS cursor.
    onCursor: (surfaceId, cursor) => sendToRenderer('os:page-cursor', { surfaceId, cursor }),
    onFocus: (id) => send('focus', { id }),
    onContextMenu: (surfaceId, x, y) => sendToRenderer('os:action', { type: 'surface-contextmenu', surfaceId, x, y }),
    onShiftTap: () => sendToRenderer('os:shifttap', undefined),
    onAltHold: (phase) => osRadialPhase(phase)
  })

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
  ipcMain.handle('os:restore-chat-hub', () => osRestoreChatHub())

  ipcMain.on('os:state', (_e, state: OsState) => {
    if (state && Array.isArray(state.surfaces)) {
      const prev = cached // BEFORE the host replaces it — the diff baseline for human canvas ops
      // A stage reorder translates MANY windows in one transaction; the renderer stamps the push
      // with bulkAt so the differ reports nothing (else: a storm of phantom "human moved" ops).
      if (typeof state.bulkAt === 'number' && state.bulkAt !== lastRendererBulkAt) {
        lastRendererBulkAt = state.bulkAt
        canvasBulkAt = Date.now()
      }
      wsHost?.onStatePush(state)
      diffCanvasOps(prev, state)
      // telemetry: a compact layout keyframe (~every 20s, not every push) — replay resyncs from these;
      // content fidelity comes from the 'act' stream, so heavy props are deliberately dropped here.
      if (Date.now() - lastStateKeyframe > 20_000) {
        lastStateKeyframe = Date.now()
        const s = state as unknown as { mode?: unknown; surfaces: Array<Record<string, unknown>> }
        tel('state', {
          mode: s.mode,
          n: s.surfaces.length,
          surfaces: s.surfaces.map((x) => ({ id: x.id, kind: x.kind, x: x.x, y: x.y, w: x.w, h: x.h, title: x.title, url: x.url, slot: x.slot }))
        })
      }
    }
  })
  ipcMain.on('os:webview', (_e, m: { surfaceId: string; wcid: number }) => {
    if (m && m.surfaceId) registerLiveWebContent(m.surfaceId, m.wcid)
  })
  // The renderer declares each web surface's tab list; the host reconciles live views to it.
  ipcMain.on('os:webcontents-view:sync', (_e, m: { id?: string; tabs?: TabDecl[]; active?: string | null; zoom?: number }) => {
    if (!m?.id || !Array.isArray(m.tabs)) return
    syncWebContentsViewTabs(String(m.id), m.tabs, typeof m.active === 'string' ? m.active : null, Number(m.zoom) || 1)
  })
  ipcMain.on('os:webcontents-view:bounds', (_e, m: { id?: string; rect?: { x: number; y: number; width: number; height: number }; visible?: boolean; z?: number; zoom?: number }) => {
    if (!m?.id || !m.rect) return
    updateWebContentsViewBounds(String(m.id), m.rect, !!m.visible, Number(m.z) || 0, Number(m.zoom) || 1)
  })
  ipcMain.on('os:webcontents-view:navigate', (_e, m: { id?: string; tabId?: string; url?: string }) => {
    if (m?.id && typeof m.url === 'string') navigateWebContentsView(String(m.id), typeof m.tabId === 'string' ? m.tabId : null, m.url)
  })
  // Browser chrome buttons (back/forward/reload/stop) → the surface's active tab.
  ipcMain.on('os:webcontents-view:nav-action', (_e, m: { id?: string; action?: string }) => {
    const a = String(m?.action || '')
    if (m?.id && (a === 'back' || a === 'forward' || a === 'reload' || a === 'stop')) webContentsViewNavAction(String(m.id), a)
  })
  // The sandwich input router: the UI window owns ALL mouse; events landing on a browser HOLE
  // forward to that surface's active tab. Wheel deltas are NEGATED (Electron's mouseWheel scrolls
  // down on negative deltaY — spike-verified, inverse of the DOM's convention). Keyboard is NATIVE
  // via the focus handoff below, so typing and IME never ride synthetic events.
  ipcMain.on('os:page-input', (_e, m: { id?: string; ev?: Record<string, unknown> }) => {
    const wc = m?.id ? webContentsForSurface(String(m.id)) : null
    const ev = m?.ev
    if (!wc || !ev) return
    const x = Math.round(Number(ev.x) || 0)
    const y = Math.round(Number(ev.y) || 0)
    const mods = (Array.isArray(ev.modifiers) ? ev.modifiers : []) as Array<'shift' | 'control' | 'alt' | 'meta'>
    try {
      if (ev.type === 'wheel') {
        wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -Math.round(Number(ev.dx) || 0), deltaY: -Math.round(Number(ev.dy) || 0), modifiers: mods })
      } else if (ev.type === 'move') {
        wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers: mods })
      } else if (ev.type === 'down' || ev.type === 'up') {
        const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left'
        wc.sendInputEvent({ type: ev.type === 'down' ? 'mouseDown' : 'mouseUp', x, y, button, clickCount: Math.max(1, Number(ev.clicks) || 1), modifiers: mods })
      }
    } catch {
      /* view torn down mid-event */
    }
  })
  // Keyboard handoff, CONDITIONAL: fired after a click lands in a page; probe what it focused.
  // Only an EDITABLE target (typing/IME) needs the pages window to become key — flipping the key
  // window on every click grays the UI window's chrome and reads as the app losing focus. A
  // non-editable click returns the keyboard to the UI so app keybinds keep working.
  ipcMain.on('os:page-focus', (_e, id: string) => {
    const wc = webContentsForSurface(String(id || ''))
    if (!wc) return
    wc.executeJavaScript(
      '(()=>{const e=document.activeElement;if(!e)return false;if(e.isContentEditable)return true;const t=e.tagName;return t==="INPUT"||t==="TEXTAREA"||t==="SELECT"})()',
      true
    )
      .then((editable) => {
        if (editable) {
          sandwichFocus.focusPages()
          try {
            wc.focus()
          } catch {
            /* gone */
          }
        } else {
          sandwichFocus.focusUi()
        }
      })
      .catch(() => {})
  })
  ipcMain.on('os:ui-focus', () => sandwichFocus.focusUi())
  // Titlebar drag (sandwich): the renderer streams screen deltas; main moves the PARENT window and
  // the attached UI child follows natively (CSS app-region would drag the child alone, detaching it).
  ipcMain.on('os:shell-drag', (_e, m: { op?: string; dx?: number; dy?: number }) => {
    const op = m?.op === 'start' ? 'start' : 'move'
    sandwichFocus.dragShell(op, Number(m?.dx) || 0, Number(m?.dy) || 0)
  })
  ipcMain.on('os:webcontents-view:focus', (_e, id: string) => focusWebContentsView(String(id || '')))
  ipcMain.on('os:webcontents-view:close', (_e, id: string) => closeWebContentsView(String(id || '')))
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
    osUserMessage(text, aid)
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

// ---- perception (Electron): inject the shared in-page SENSORS (INJECT, from
// perception-core via events.ts) into each WebContentsView guest and drain them on a loop
// into the shared moment coalescer (ingestSignals). The sensor scripts + coalescer are
// the SAME ones server mode uses (preview/backend.mjs), so there is no drift.
// Re-injects on each guest dom-ready; self-cleans when the guest is gone.

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
      // Skip the tick while the main frame is mid-load: executeJavaScript on a loading document just
      // QUEUES on an internal did-stop-loading once-listener, and a 350ms poll against a slow page
      // piles those up (the MaxListenersExceeded warning). The document is being replaced anyway;
      // dom-ready re-injects and the next tick reads the new page.
      const wcid = browserContentIds.get(surfaceId)
      const wc = wcid == null ? null : webContents.fromId(wcid)
      if (wc && !wc.isDestroyed() && wc.isLoadingMainFrame()) return
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
  noteCanvasOpFromMain(type, payload) // perception: tool-driven desktop changes become 'canvas' moments
  sendToRenderer('os:action', { type, ...payload })
}

/** Send an arbitrary os:action to the renderer — the Electron emit seam for shared cores (e.g. terminal events). */
export function osBroadcast(action: Record<string, unknown>): void {
  tel('act', action) // telemetry: session/action-item events emit here (the shared-core seam)
  sendToRenderer('os:action', action)
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

// ---- canvas perception (the brain sees window movement — issues/open/perception-blind-spot…):
// TOOL-driven ops ingest at the send() seam with origin 'tool'; HUMAN gestures are derived by
// diffing successive renderer os:state pushes. The renderer ECHOES applied tool ops back in its
// next state push, so each tool op arms a short-lived echo key the differ consumes instead of
// double-reporting it as human. Bulk transitions (hydrate/switch/reconcile) change everything at
// once and are perception-noise — they suppress the differ for a beat instead of spamming ops.
const canvasEcho = new Map<string, number>() // `${op}:${id}` -> armed-at
const CANVAS_ECHO_TTL = 5000
let canvasBulkAt = 0
let lastRendererBulkAt = 0 // last bulk stamp seen on an os:state push (stage reorders)
const CANVAS_BULK_WINDOW = 3000
const CANVAS_MOVE_MIN = 8 // px; below this a "move" is layout jitter, not a gesture

function armEcho(op: string, id: unknown): void {
  if (typeof id === 'string' && id) canvasEcho.set(`${op}:${id}`, Date.now())
}
function consumeEcho(op: string, id: string): boolean {
  const k = `${op}:${id}`
  const t = canvasEcho.get(k)
  if (t == null) return false
  canvasEcho.delete(k)
  return Date.now() - t <= CANVAS_ECHO_TTL
}

function noteCanvasOpFromMain(type: string, payload: Record<string, unknown>): void {
  try {
    if (type === 'hydrate' || type === 'switch' || type === 'reconcile') {
      canvasBulkAt = Date.now()
      return
    }
    if (type === 'create') {
      const s = payload.surface as { id?: string; title?: string; kind?: string } | undefined
      if (!s?.id) return
      armEcho('open', s.id)
      ingestCanvasOps([{ op: 'open', id: s.id, title: s.title, kind: s.kind, origin: 'tool' }])
    } else if (type === 'close') {
      const id = payload.id
      if (typeof id !== 'string') return
      armEcho('close', id)
      const t = (cached.surfaces || []).find((x) => x.id === id)
      ingestCanvasOps([{ op: 'close', id, title: t?.title, origin: 'tool' }])
    } else if (type === 'move') {
      const { id, x, y } = payload as { id?: string; x?: number; y?: number }
      if (typeof id !== 'string') return
      armEcho('move', id)
      const t = (cached.surfaces || []).find((s) => s.id === id)
      ingestCanvasOps([{ op: 'move', id, title: t?.title, x: Number(x) || 0, y: Number(y) || 0, origin: 'tool' }])
    } else if (type === 'update') {
      const { id, patch } = payload as { id?: string; patch?: Record<string, unknown> }
      if (typeof id !== 'string' || !patch) return
      const t = (cached.surfaces || []).find((s) => s.id === id)
      if (patch.x != null || patch.y != null) {
        armEcho('move', id)
        ingestCanvasOps([{ op: 'move', id, title: t?.title, x: Number(patch.x ?? t?.x) || 0, y: Number(patch.y ?? t?.y) || 0, origin: 'tool' }])
      }
      if (patch.w != null || patch.h != null) {
        armEcho('resize', id)
        ingestCanvasOps([{ op: 'resize', id, title: t?.title, w: Number(patch.w ?? t?.w) || 0, h: Number(patch.h ?? t?.h) || 0, origin: 'tool' }])
      }
    }
  } catch {
    /* perception must never break the control plane */
  }
}

/** Human gestures: diff the renderer's authoritative state pushes. Runs on every os:state. */
function diffCanvasOps(prev: OsState, next: OsState): void {
  try {
    if (Date.now() - canvasBulkAt < CANVAS_BULK_WINDOW) return
    const a = new Map((prev.surfaces || []).map((s) => [s.id, s]))
    const b = new Map((next.surfaces || []).map((s) => [s.id, s]))
    if (!a.size && b.size > 1) return // first real push after boot — hydration, not gestures
    const ops: Array<{ op: 'open' | 'close' | 'move' | 'resize'; id: string; title?: string; kind?: string; x?: number; y?: number; w?: number; h?: number; origin: 'human' }> = []
    for (const [id, s] of b) {
      const p = a.get(id)
      if (!p) {
        if (!consumeEcho('open', id)) ops.push({ op: 'open', id, title: s.title, kind: s.kind, origin: 'human' })
        continue
      }
      if (Math.abs(s.x - p.x) >= CANVAS_MOVE_MIN || Math.abs(s.y - p.y) >= CANVAS_MOVE_MIN) {
        if (!consumeEcho('move', id)) ops.push({ op: 'move', id, title: s.title, x: s.x, y: s.y, origin: 'human' })
      }
      if (Math.abs(s.w - p.w) >= CANVAS_MOVE_MIN || Math.abs(s.h - p.h) >= CANVAS_MOVE_MIN) {
        if (!consumeEcho('resize', id)) ops.push({ op: 'resize', id, title: s.title, w: s.w, h: s.h, origin: 'human' })
      }
    }
    for (const [id, p] of a) {
      if (!b.has(id) && !consumeEcho('close', id)) ops.push({ op: 'close', id, title: p.title, origin: 'human' })
    }
    if (ops.length) ingestCanvasOps(ops)
  } catch {
    /* perception must never break the state pipeline */
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
  closeWebContentsView(id)
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
/** The agent customizes an agent's widget UI (blitz-[<id>-]<name>.html) — currently 'chat'. Live-reloads. */
export function osCustomizeWidget(name: string, html: string, agentId = '0'): { ok: boolean; rel?: string; error?: string } {
  return wsHost ? wsHost.customizeWidget(String(name), String(html), agentId) : { ok: false, error: 'no workspace host' }
}
/** Read a built-in widget's current UI source (workspace file or shipped default) — read-before-edit. */
export function osSystemUi(name: string): string | null {
  return wsHost ? wsHost.systemUi(String(name)) : null
}
let lastStateKeyframe = 0
// index.ts owns the relay url + terminal-ops, so it registers HOW to launch an agent backend in a
// tmux terminal. osActions handles the workspace-side (mint id + surface the widget); addAgent then
// calls launchAgent via the host adapter.
let launchAgentHook: ((agentId: string, stage: number, title?: string) => void) | null = null
export function setLaunchAgent(fn: (agentId: string, stage: number, title?: string) => void): void {
  launchAgentHook = fn
}
let stopAgentHook: ((agentId: string) => void) | null = null
export function setStopAgent(fn: (agentId: string) => void): void {
  stopAgentHook = fn
}
// Re-exec a running agent with a FRESH context. The onboarding director calls this at the
// interview→resident HANDOFF; the transport wires it to a session-id rotation + restart, so the resident
// boots a clean conversation and rebuilds state from profile.md + board.json + initiative.md + chat.md
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
export function osClearBrainContext(agentId = '0'): void {
  clearBrainContextHook?.(String(agentId))
}
/** Ensure an agent is up WITHOUT a chat message — the onboarding director uses this to start the
 *  resident interviewer at board-ready (its standing duty rides the bootstrap). Re-execs via the tmux
 *  launcher (replaces any stale terminal); no-op when no launcher is wired. */
export function osKickBrain(agentId = '0'): void {
  const id = String(agentId)
  launchAgentHook?.(id, id === '0' ? 0 : 0)
}
/** Open a new agent: mint its id, register + live-surface its chat widget; addAgent launches
 *  its managed terminal (via the launchAgent seam). focus:true (a USER '+ Agent') follows the camera to it. */
export function osSpawnAgent(title?: string, focus = false): { id: string; title: string } {
  if (!wsHost) throw new Error('no workspace host')
  const id = wsHost.newAgentId()
  wsHost.addAgent(id, title, { focus })
  return { id, title: title || `Chat ${id}` }
}
/** Close a non-primary agent (stop its backend + remove its widget/files/stage). */
export function osCloseAgent(agentId: string): { ok: boolean; error?: string } {
  return wsHost ? wsHost.closeAgent(agentId) : { ok: false, error: 'no workspace host' }
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
  for (const [sid, wcid] of browserContentIds) if (wcid === wc.id) return sid
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

/** Send the active workspace's hydrate to the renderer (index.ts calls this on did-finish-load). */
export function osSendHydrate(): void {
  if (!wsHost) return
  send('hydrate', { surfaces: wsHost.hydrateSurfaces(), camera: cached.camera || { x: 0, y: 0, scale: 1 }, mode: cached.mode || 'canvas', stageCount: cached.stageCount || 1, stageOrder: cached.stageOrder, workspace: wsHost.active() })
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
/** Capture the primary stage (1440x900, centered) of the current board → store as `name`'s thumbnail. */
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
