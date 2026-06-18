import { memo, useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop, snapTargetFor, primaryRect, nextTerminalName, latticeFor, slotRect, slotOf, nearestFreeSlot, sizeForDims, webTabsOf, effectiveZ } from '../store'
import { BrowserNav } from './BrowserNav'
import { WebTabView } from './WebTabView'
import { NoteWidget } from './NoteWidget'
import { ActivityPanel } from './ActivityPanel'
import { ChatPanel } from './ChatPanel'
import { TerminalView } from './TerminalView'
import { RuntimePanel } from './RuntimePanel'
import { InboxPanel } from './InboxPanel'
import { BRIDGE_SHIM } from '../widget-bridge'
import { UI_KIT } from '../widget-ui-kit'
import { useJsxWidget } from '../widget-jsx'
import { IconEye } from './Icons'
import { FolderWidget } from './FolderWidget'
import { FileWidget, DirWidget } from './FileWidget'
import { FileManager } from './FileManager'
import { UnlockWidget } from './UnlockWidget'
import { NOTE_PAPER } from '../paper'

type BridgeReply = { ok: boolean; data?: unknown; error?: string }

function isRealFolderSurface(s: Surface): boolean {
  return s.kind === 'native' && s.component === 'dir'
}

function isFileBackedFolderMoveCandidate(s: Surface, targetPath: string): boolean {
  if (s.minimized || s.groupId || s.role) return false
  if (s.kind === 'app' || s.kind === 'srcdoc') return true
  if (s.kind !== 'native') return false
  if (s.component === 'note') return true
  if (s.component === 'file') return true
  if (s.component === 'dir') {
    const p = typeof s.props?.path === 'string' ? s.props.path : ''
    return !!p && p !== targetPath && !targetPath.startsWith(`${p}/`)
  }
  return false
}


function AppEmptyState(): JSX.Element {
  return (
    <div className="surface-empty">
      <div className="surface-empty-icon">▦</div>
      <h3>App</h3>
      <p>A Blitz app can appear here. Add a deployed app URL, or ask an agent to create one for this workspace.</p>
    </div>
  )
}

// memo: the camera tween (⌘⌘ zoom-out, pan/zoom) re-renders App ~60×/sec, which re-creates every
// SurfaceFrame element. Their `surface` prop keeps a stable reference when only the transform changes,
// so memo lets React skip re-running each browser-bearing frame per animation tick. A surface's own
// store subscriptions (z/selection/drag) still re-render it independently — memo only gates the
// parent-driven churn (brandon-ui's dock-animation props ride along; they only change per-gesture).
export const SurfaceFrame = memo(function SurfaceFrame({
  surface,
  onRequestMinimize,
  onRequestToggleMaximize,
  restoring = false,
  renamingDirPath = null,
  onDirRenameDone,
  onDirContextMenu
}: {
  surface: Surface
  onRequestMinimize?: (id: string) => void
  onRequestToggleMaximize?: (id: string) => void
  restoring?: boolean
  renamingDirPath?: string | null
  onDirRenameDone?: () => void
  onDirContextMenu?: (id: string, x: number, y: number) => void
}): JSX.Element {
  const moveSurface = useDesktop((s) => s.moveSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const closeAgent = useDesktop((s) => s.closeAgent)
  const toggleMaximize = useDesktop((s) => s.toggleMaximize)
  const minimizeSurface = useDesktop((s) => s.minimizeSurface)
  const setActiveTab = useDesktop((s) => s.setActiveTab)
  const closeTab = useDesktop((s) => s.closeTab)
  const addWebTab = useDesktop((s) => s.addWebTab)
  // Prefer explicit active-surface tracking; fall back to highest-z for initial hydrate before focus.
  const activeSurfaceId = useDesktop((s) => s.activeSurfaceId)
  const maxZ = useDesktop((s) => s.surfaces.reduce((m, w) => Math.max(m, w.z), -Infinity))
  const isActive = activeSurfaceId ? activeSurfaceId === surface.id : surface.z === maxZ
  const isSelected = useDesktop((s) => s.selection.includes(surface.id))
  const isDropTarget = useDesktop((s) => s.dragTarget === surface.id)
  const isAbsorbing = useDesktop((s) => s.absorbing.includes(surface.id))
  const grabMode = useDesktop((s) => s.grabMode)
  // Control view = the UNLOCKED canvas (pan/zoom/arrange: drag cards from anywhere, don't interact).
  // The view lock (single-tap ⇧ / toolbar) flips to work mode: the overlay drops and clicks reach the
  // surface content. `mode === 'canvas'` alone broke when canvas became the DEFAULT mode — it covered
  // every widget with the drag overlay permanently ("can't even click the theme picker").
  const isControl = useDesktop((s) => s.mode === 'canvas' && !s.locked)
  const osAccent = useDesktop((s) => s.osAccent)
  const [isDragging, setIsDragging] = useState(false)
  // The props a srcdoc widget receives: its OWN props, but the GLOBAL OS accent folded in when the
  // widget declares none (board cards carry their own palette accent and keep it). So plain + future
  // widgets follow the OS theme automatically.
  const widgetProps = (): Record<string, unknown> => {
    const p = (surface.props ?? {}) as Record<string, unknown>
    if (!osAccent || p.accent) return p
    const n = parseInt(osAccent.slice(1), 16)
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
    return { accent: osAccent, accentInk: lum > 150 ? '#1a1b1d' : '#ffffff', ...p }
  }

  const drag = useRef<{
    startX: number
    startY: number
    items: Array<{ id: string; ox: number; oy: number; ow: number; oh: number }>
    single: boolean
    grabFracX: number // where along the window the pointer grabbed (0..1) — for pop-out repositioning
    grabFracY: number
    startPreSnap?: { w: number; h: number } // floating size if this window started the drag already tiled
    poppedOut: boolean // a tiled window has been dragged back out to floating this gesture
    dx?: number // last applied drag delta (world units), folded into the store on drop
    dy?: number
    imperative?: boolean // moving the frame via a composited transform, committed to the store on drop
  } | null>(null)
  const resize = useRef<{ startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; dir: string } | null>(null)
  // Slotted-tile drag: the candidate lattice span under the outline ghost (committed on drop).
  const slotGhost = useRef<{ col: number; row: number } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  // Where a focused widget's pinch last centered (its cursor point, in content px) — the transformOrigin
  // for iframeZoom, so the zoom magnifies toward the cursor instead of the top-left corner.
  const zoomOriginRef = useRef<{ x: number; y: number } | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const serverMode = !!window.agentOS?.serverMode
  const [draft, setDraft] = useState(surface.url ?? '') // address-bar draft text (app / server-web)
  const zoom = surface.zoom ?? 1
  // jsx/tsx widgets compile at mount (inert {active:false} for everything else). The composed
  // srcdoc (or error card) arrives async; the iframe mounts only once it's ready.
  const jsxWidget = useJsxWidget(surface)
  // Bookmarks dropdown — plain DOM. The sandwich compositor (plans/blitzos-sandwich-compositor.md)
  // puts ALL UI in the transparent top window, physically above the live pages below, so a dropdown
  // simply paints over the page. No capture, no freeze, no placeholder.
  const [bmOpen, setBmOpen] = useState(false)

  // If this surface unmounts mid-drag (the agent closes it, a reconcile removes its file, a folder
  // absorbs it), onBarUp never fires — so clear any ghost snap-preview / drop-target it left behind.
  useEffect(() => {
    return () => {
      const d = drag.current
      if (d) {
        const st = useDesktop.getState()
        st.setSnapPreview(null)
        st.setDragTarget(null)
        // An imperative drag never reached onBarUp — drop the transform + commit so the window stays put.
        if (d.imperative) {
          if (frameRef.current) frameRef.current.style.transform = ''
          for (const it of d.items) st.moveSurface(it.id, it.ox + (d.dx ?? 0), it.oy + (d.dy ?? 0))
        }
      }
    }
  }, [])

  const webTabs = surface.kind === 'web' && !serverMode ? webTabsOf(surface) : null
  const activeWebTabIdx = webTabs ? Math.min(Math.max(surface.activeTab || 0, 0), webTabs.length - 1) : 0
  const activeWebTab = webTabs ? webTabs[activeWebTabIdx] : null

  // Per-tab <webview> liveness: a tab is MATERIALIZED (gets a live <webview>) once it has been active, and
  // stays mounted after, so background tabs keep their page alive. Mark the active tab materialized during
  // render (idempotent Set add); render only materialized tabs (WebTabView below). This is the lazy-then-
  // live restore the old per-tab WebContentsView host did. Wiring (register-with-main, nav-state, fullscreen)
  // lives in WebTabView per tab.
  const materializedTabs = useRef<Set<string>>(new Set())
  if (activeWebTab) materializedTabs.current.add(activeWebTab.id)

  // Keep the app/server address-bar draft in sync with the stored url (Electron web surfaces moved to
  // BrowserNav, which holds per-tab drafts with a focus clobber-guard).
  useEffect(() => setDraft(surface.url ?? ''), [surface.url])

  function normalizeUrl(s: string): string {
    const t = s.trim()
    if (!t || /^https?:\/\//i.test(t)) return t
    return 'https://' + t
  }
  // Address-bar submit for app (iframe src via the store) and server-mode web (headless browser).
  function go(e: React.FormEvent): void {
    e.preventDefault()
    const u = normalizeUrl(draft)
    if (!u) return
    setDraft(u)
    if (surface.kind === 'app') {
      useDesktop.getState().updateSurface(surface.id, { url: u })
      return
    }
    if (serverMode) {
      window.agentOS?.serverNavigate?.(surface.id, u)
      let title = u
      try {
        title = new URL(u).hostname || u
      } catch {
        /* keep u */
      }
      useDesktop.getState().updateSurface(surface.id, { url: u, title })
    }
  }

  // Server mode: mount the streamed <canvas> for this web surface (draws screencast
  // frames, forwards pointer/wheel/key to the server browser via the stream WS).
  useEffect(() => {
    if (surface.kind !== 'web' || !serverMode) return
    const c = canvasRef.current
    const mount = window.agentOS?.mountServerSurface
    if (!c || !mount) return
    return mount(c, surface.id, { w: surface.w, h: surface.h })
  }, [surface.kind, surface.id, surface.w, surface.h, serverMode])

  // srcdoc widget bridge: relay the widget's blitz:req to the OS and reply over postMessage. The sender
  // is authenticated by object identity (event.source === our iframe.contentWindow) — origin is the
  // unusable "null" for a sandboxed frame. Deliver a reply ONLY to the generation that asked: an html
  // reload swaps the iframe's contentWindow, so a stale held reply for the old document must never land on
  // the new one. Each serve* does the work and replies to the SAME generation that asked (postRes is
  // contentWindow-checked, so a reply for the old document can't land on a reloaded iframe).
  function postRes(win: Window, reqId: string, r: BridgeReply): void {
    if (iframeRef.current?.contentWindow === win) win.postMessage({ type: 'blitz:res', reqId, ...r }, '*')
  }
  // blitz.tool — the widget calls an OS tool (create_surface/open_window/group/…). CLOSED allowlist
  // enforced main/server-side (widget-tools.mjs).
  function serveTool(win: Window, reqId: string, name: string, args: Record<string, unknown>): Promise<void> {
    const api = window.agentOS
    if (!api?.widgetTool) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'widget tool bridge unavailable here' }))
    return api
      .widgetTool(surface.id, name, args)
      .then(
        (res) => postRes(win, reqId, res?.ok ? { ok: true, data: res.result } : { ok: false, error: res?.error || 'tool failed' }),
        (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
      )
  }
  // blitz.sendMessage — the widget sends a message to an agent thread. The chat hub passes a sessionId;
  // older single-agent widgets fall back to props.agentId.
  function serveMessage(win: Window, reqId: string, text: string, sessionId?: string): Promise<void> {
    window.agentOS?.sendMessage?.(String(text), String(sessionId || surface.props?.agentId || '0'))
    return Promise.resolve(postRes(win, reqId, { ok: true }))
  }
  // blitz.chat — the shared chat hub manages threads (op 'new' -> a fresh agent id; 'rename' -> its title).
  // Returns the result (e.g. the new agent id).
  function serveChat(win: Window, reqId: string, op: string, args: Record<string, unknown>): Promise<void> {
    const api = window.agentOS as { chatControl?: (op: string, args: Record<string, unknown>) => Promise<unknown> } | undefined
    if (!api?.chatControl) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'chat control unavailable here' }))
    return api.chatControl(String(op), args).then(
      (r) => postRes(win, reqId, { ok: true, data: r }),
      (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
    )
  }
  // blitz.listDir — the widget lists a workspace folder (the file-manager widget).
  function serveListDir(win: Window, reqId: string, path: string): Promise<void> {
    const api = window.agentOS
    if (!api?.listDir) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'widget files bridge unavailable here' }))
    return api
      .listDir(String(path))
      .then(
        (r) => postRes(win, reqId, { ok: true, data: r }),
        (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
      )
  }

  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    const onMessage = (e: MessageEvent): void => {
      const win = iframeRef.current?.contentWindow
      if (!win || e.source !== win) return // only OUR widget (origin is unusable "null")
      const m = e.data as { type?: string; reqId?: string; op?: string; tool?: string; args?: unknown; text?: string; sessionId?: string; path?: string; chatOp?: string }
      if (!m || typeof m !== 'object') return
      if (m.type === 'blitz:hello') {
        win.postMessage({ type: 'blitz:init', props: widgetProps() }, '*')
      } else if (m.type === 'blitz:contextmenu') {
        // Item 5b: a srcdoc widget forwarded a right-click (its iframe swallowed it). Open the annotation
        // menu at that point — EXCEPT on runtime panels (chat/activity), where annotating makes no sense.
        const isPanel = surface.role === 'chat' || surface.role === 'activity'
        const el = iframeRef.current
        if (!isPanel && el) {
          const r = el.getBoundingClientRect()
          const z = surface.zoom ?? 1
          const cw = r.width / z
          const ch = r.height / z // content px (the iframe is CSS-scaled by zoom)
          const cx = Number((m as { x?: number }).x) || 0
          const cy = Number((m as { y?: number }).y) || 0
          if (cw > 0 && ch > 0) {
            useDesktop.getState().openAnnotationMenu(surface.id, cx / cw, cy / ch, r.left + cx * z, r.top + cy * z)
          }
        }
      } else if (m.type === 'blitz:wheel') {
        // A FOCUSED widget's iframe got a pinch (ctrl+wheel). Unfocused widgets never send this — the focus
        // catcher intercepts their pinch and it drives the CANVAS zoom. So this means "zoom THIS widget
        // only": apply its own content zoom (iframeZoom via surface.zoom), nothing else on the stage moves.
        const dy = Number((m as { dy?: number }).dy) || 0
        // Scale toward the CURSOR (its content-px point), and never below 100% (min 1 — no zoom-out).
        zoomOriginRef.current = { x: Number((m as { x?: number }).x) || 0, y: Number((m as { y?: number }).y) || 0 }
        const cur = useDesktop.getState().surfaces.find((s) => s.id === surface.id)?.zoom ?? 1
        useDesktop.getState().setZoom(surface.id, Math.min(4, Math.max(1, cur * Math.exp(-dy * 0.006))))
      } else if (m.type === 'blitz:annotation') {
        // Item 5b: a chat widget's grounded reference was clicked → recall the annotation bubble on its
        // surface (fire-and-forget; the ref carries the full annotation so it works after a reload).
        const ref = (m as { ref?: unknown }).ref as { id?: unknown; surfaceId?: unknown; xPct?: unknown; yPct?: unknown; text?: unknown } | undefined
        if (ref && ref.id && ref.surfaceId) {
          useDesktop.getState().recallAnnotation({ id: String(ref.id), surfaceId: String(ref.surfaceId), xPct: Number(ref.xPct) || 0, yPct: Number(ref.yPct) || 0, text: String(ref.text ?? ''), ts: 0 })
        }
      } else if (m.type === 'blitz:jsxerr') {
        // A jsx widget's bootstrap caught a runtime failure (bad import, mount throw, unhandled
        // rejection). Fold it into props.lastError so the agent reads it from list_state; the
        // bootstrap already painted the in-widget overlay for the human.
        const msg = String((m as { error?: unknown }).error ?? 'widget runtime error').slice(0, 500)
        if (surface.props?.lastError !== msg) useDesktop.getState().updateSurfaceProps(surface.id, { lastError: msg })
      } else if (m.type === 'blitz:jsxok') {
        // The widget mounted clean — clear a stale lastError from a previous broken generation.
        if (surface.props?.lastError) useDesktop.getState().updateSurfaceProps(surface.id, { lastError: undefined })
      } else if (m.type === 'blitz:req' && typeof m.reqId === 'string') {
        if (m.op === 'tool') void serveTool(win, m.reqId, String(m.tool ?? ''), (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>)
        else if (m.op === 'msg') void serveMessage(win, m.reqId, String(m.text ?? ''), m.sessionId != null ? String(m.sessionId) : undefined)
        else if (m.op === 'chat') void serveChat(win, m.reqId, String(m.chatOp ?? ''), (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>)
        else if (m.op === 'listdir') void serveListDir(win, m.reqId, String(m.path ?? ''))
        else if (m.op === 'setprops') {
          // A widget persists its OWN state (e.g. a note's text) — own-surface only.
          const patch = (m as { patch?: unknown }).patch
          useDesktop.getState().updateSurfaceProps(surface.id, (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>)
          postRes(win, m.reqId, { ok: true })
        } else postRes(win, m.reqId, { ok: false, error: `unsupported op: ${String(m.op)}` })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // surface.props intentionally in deps: a hello after a prop change re-seeds fresh props
  }, [surface.kind, surface.id, surface.props])

  // Live prop changes reach the widget without reloading it (html stays put). Also re-posts when
  // the global OS accent changes so plain widgets (no own props.accent) recolor immediately.
  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    iframeRef.current?.contentWindow?.postMessage({ type: 'blitz:props', props: widgetProps() }, '*')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surface.kind, surface.props, osAccent])

  function onBarDown(e: React.PointerEvent): void {
    e.stopPropagation()
    focusSurface(surface.id)
    // Capture on currentTarget (the bar / drag-overlay) so move+up always land here even if the
    // pointer leaves the window — the clean-capture fix for "stuck mouse events / can't unsnap".
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* ignore (synthetic events) */
    }
    setIsDragging(true)
    const st = useDesktop.getState()
    // drag the whole selection if this surface is part of a multi-selection; else just this one.
    // A Space "grab" of a single surface also selects it.
    let ids: string[]
    if (st.selection.includes(surface.id) && st.selection.length > 1) {
      ids = st.selection
    } else {
      ids = [surface.id]
      if (st.grabMode) st.setSelection([surface.id])
    }
    const items = ids
      .map((id) => st.surfaces.find((w) => w.id === id))
      .filter((w): w is Surface => !!w)
      .map((w) => ({ id: w.id, ox: w.x, oy: w.y, ow: w.w, oh: w.h }))
    const single = items.length === 1
    // Grab fraction along THIS window (so a tiled window pops out under the cursor at the same spot).
    const t = st.transform
    const wx = (e.clientX - t.x) / t.scale
    const wy = (e.clientY - t.y) / t.scale
    const grabFracX = surface.w ? Math.min(1, Math.max(0, (wx - surface.x) / surface.w)) : 0.5
    const grabFracY = surface.h ? Math.min(1, Math.max(0, (wy - surface.y) / surface.h)) : 0
    drag.current = { startX: e.clientX, startY: e.clientY, items, single, grabFracX, grabFracY, startPreSnap: surface.preSnap, poppedOut: false }
  }
  function onBarMove(e: React.PointerEvent): void {
    const d = drag.current
    if (!d) return
    const st = useDesktop.getState()
    const t = st.transform
    const wx = (e.clientX - t.x) / t.scale
    const wy = (e.clientY - t.y) / t.scale
    // macOS "pop-out": dragging a tiled window past a small threshold un-tiles it back to its floating
    // size, re-centered under the cursor at the same grab spot, then it follows the pointer normally.
    if (d.single && !d.poppedOut && d.startPreSnap && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) {
      const fw = d.startPreSnap.w
      const fh = d.startPreSnap.h
      const nx = Math.round(wx - d.grabFracX * fw)
      const ny = Math.round(wy - d.grabFracY * fh)
      st.updateSurface(d.items[0].id, { x: nx, y: ny, w: fw, h: fh, preSnap: undefined, restore: undefined })
      // rebase the drag so subsequent deltas apply from the floating rect
      d.startX = e.clientX
      d.startY = e.clientY
      d.items = [{ id: d.items[0].id, ox: nx, oy: ny, ow: fw, oh: fh }]
      d.poppedOut = true
      // Drop any snap preview captured BEFORE the pop-out (the cursor may still sit in the edge zone) so
      // releasing right after popping out doesn't instantly re-tile the window. A later move re-evaluates.
      st.setDragTarget(null)
      st.setSnapPreview(null)
      return
    }
    const dx = (e.clientX - d.startX) / t.scale
    const dy = (e.clientY - d.startY) / t.scale
    d.dx = dx
    d.dy = dy
    // A single free window moves IMPERATIVELY — a composited transform offset on the frame, NO store
    // write per move (that React round-trip is the lag). React still owns left/top (= the un-updated
    // store position) and never touches transform, so this persists across renders. The L0 page view
    // AND every occlusion clip (.bg, scenery, per-frame page-holes) track this move in the geometry RAF,
    // which reads each frame's LIVE rect (it reflects the transform) — not the store. Committed on drop.
    if (d.items.length === 1 && !isSlotted && !isFileTile && frameRef.current) {
      d.imperative = true
      frameRef.current.style.transform = `translate(${dx}px, ${dy}px)`
    } else {
      for (const it of d.items) moveSurface(it.id, it.ox + dx, it.oy + dy)
    }
    // Highlight a visual Group folder OR a real filesystem folder under the cursor.
    // Real folders accept only file-backed items; visual Groups keep their old "any live surface" behavior.
    const dragged = new Set(d.items.map((it) => it.id))
    const folder = st.surfaces.find(
      (w) => {
        if (dragged.has(w.id) || wx < w.x || wx > w.x + w.w || wy < w.y || wy > w.y + w.h) return false
        if (w.component === 'folder') return true
        if (!isRealFolderSurface(w)) return false
        const targetPath = typeof w.props?.path === 'string' ? w.props.path : ''
        return !!targetPath && d.items.every((it) => {
          const draggedSurface = st.surfaces.find((s) => s.id === it.id)
          return !!draggedSurface && isFileBackedFolderMoveCandidate(draggedSurface, targetPath)
        })
      }
    )
    if (folder) {
      slotGhost.current = null
      st.setDragTarget(folder.id)
      st.setSnapPreview(null)
      return
    }
    // Slotted tile drag (stage desktop, macOS widget feel): the tile floats under the cursor while an
    // OUTLINE previews the nearest free span of the lattice — other tiles NEVER move; only the file
    // layer parts fluidly around the outline. ⌘-drag skips snapping entirely (Apple's escape hatch:
    // release pops the tile off the lattice, free-form). Edge-tiling is suppressed for tiles.
    if (d.single && isSlotted && !e.metaKey) {
      const me = d.items[0]
      const sl = slotOf(surface)
      const stage = surface.slotStage ?? 0
      const lat = latticeFor(st.viewport, stage, st.stageOrder, st.stageCount)
      const ghost = nearestFreeSlot(st.surfaces, lat, sl ? sl.size : 's', me.ox + dx + me.ow / 2, me.oy + dy + me.oh / 2, stage, surface.id)
      slotGhost.current = ghost
      const gr = ghost && sl ? slotRect(lat, ghost.col, ghost.row, sl.size) : null
      st.setSnapPreview(gr)
      st.reflowFiles(gr) // fluid: files flow out of the outline's way live
      st.setDragTarget(null)
      return
    }
    if (d.single && isSlotted) {
      // ⌘ held: free drag, no ghost — the escape hatch out of the lattice.
      slotGhost.current = null
      st.setDragTarget(null)
      st.setSnapPreview(null)
      return
    }
    st.setDragTarget(null)
    // Snap preview (BOTH modes, #42): dragging a single window so the cursor reaches a primary-stage
    // side/corner shows where it will tile on release (left|right half / quarter — never full-screen).
    // Suppressed over a folder target and for file/dir tiles (they aren't windows).
    st.setSnapPreview(d.single && !folder && !isFolder && !isFileTile ? snapTargetFor(wx, wy, st.viewport, st.currentStage, st.mode, st.stageOrder, st.stageCount) : null)
  }
  function onBarUp(e: React.PointerEvent): void {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setIsDragging(false)
    const d = drag.current
    drag.current = null
    // Fold an imperative drag's final position into the store ONCE, dropping the transform so React's
    // left/top takes over at the same value (one synchronous pointerup render → no flash). Folder/snap
    // branches below may override the position.
    if (d?.imperative) {
      if (frameRef.current) frameRef.current.style.transform = ''
      for (const it of d.items) moveSurface(it.id, it.ox + (d.dx ?? 0), it.oy + (d.dy ?? 0))
    }
    const st = useDesktop.getState()
    const target = st.dragTarget
    const snap = st.snapPreview
    st.setDragTarget(null)
    st.setSnapPreview(null)
    if (d && target) {
      const targetSurface = st.surfaces.find((s) => s.id === target)
      if (targetSurface && isRealFolderSurface(targetSurface)) {
        const folderPath = typeof targetSurface.props?.path === 'string' ? targetSurface.props.path : ''
        if (folderPath) {
          const move = window.agentOS?.moveIntoFolder?.(folderPath, d.items.map((it) => it.id))
          void move?.then((r) => {
            if (!r?.ok) return
            const stNow = useDesktop.getState()
            const movedIds = Array.isArray(r.movedIds) ? r.movedIds : []
            if (movedIds.length) stNow.removeSurfacesFromCanvas(movedIds)
            stNow.clearSelection()
          }).catch(() => {})
        }
      } else {
        st.dropIntoFolder(target, d.items.map((it) => it.id))
      }
      slotGhost.current = null
      return
    }
    // Slotted tile drop: ⌘-release pops it OFF the lattice (free-form, Apple's escape hatch); a normal
    // release spring-snaps into the outlined span (or back to its own cells — self is excluded from
    // occupancy, so "didn't really move" is always a valid drop). Files reflow to the settled layout.
    if (d && d.single && isSlotted) {
      const sl = slotOf(surface)
      if (e.metaKey) {
        st.clearSurfaceSlot(surface.id)
      } else {
        const g = slotGhost.current
        if (g && sl) st.placeSurfaceSlot(surface.id, g.col, g.row, sl.size)
        else if (sl) st.placeSurfaceSlot(surface.id, sl.col, sl.row, sl.size) // nothing free under the drag — settle home
      }
      slotGhost.current = null
      st.reflowFiles()
      return
    }
    // Apply the tile; remember the floating size in `preSnap` so a later drag pops it back out
    // (macOS). `restore` is cleared so a previously-maximized window's green-zoom isn't stale.
    else if (d && snap && d.single && !isFileTile) {
      const floating = d.startPreSnap ?? { w: d.items[0].ow, h: d.items[0].oh }
      st.updateSurface(d.items[0].id, { ...snap, preSnap: floating, restore: undefined })
    }
  }

  // macOS-style resize from any side/corner. `dir` is a combination of n/s/e/w; a side handle
  // resizes that edge and moves the opposite edge's position. Works in control mode too (the
  // handles sit above the drag-overlay).
  // Grid toggle (stage desktop): pop a slotted tile OUT to free-form (pre-slot size restored), or
  // snap a free window INTO the nearest free span sized to fit it. The discoverable counterpart of
  // ⌘-drag — this is how a note (or the chat) enters and leaves the lattice.
  function toggleSlot(): void {
    useDesktop.getState().toggleSurfaceSlot(surface.id)
  }

  function onResizeDown(e: React.PointerEvent, dir: string): void {
    e.stopPropagation()
    focusSurface(surface.id)
    try {
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* synthetic event */
    }
    resize.current = { startX: e.clientX, startY: e.clientY, origX: surface.x, origY: surface.y, origW: surface.w, origH: surface.h, dir }
  }
  function onResizeMove(e: React.PointerEvent): void {
    const r = resize.current
    if (!r) return
    const scale = useDesktop.getState().transform.scale
    const dxw = (e.clientX - r.startX) / scale
    const dyw = (e.clientY - r.startY) / scale
    const MINW = 160
    const MINH = 120
    let nx = r.origX
    let ny = r.origY
    let nw = r.origW
    let nh = r.origH
    if (r.dir.includes('e')) nw = r.origW + dxw
    if (r.dir.includes('s')) nh = r.origH + dyw
    if (r.dir.includes('w')) {
      nw = r.origW - dxw
      nx = r.origX + dxw
    }
    if (r.dir.includes('n')) {
      nh = r.origH - dyw
      ny = r.origY + dyw
    }
    if (nw < MINW) {
      if (r.dir.includes('w')) nx = r.origX + r.origW - MINW // keep the right edge anchored
      nw = MINW
    }
    if (nh < MINH) {
      if (r.dir.includes('n')) ny = r.origY + r.origH - MINH // keep the bottom edge anchored
      nh = MINH
    }
    // macOS-faithful resize: a window may extend freely BEYOND the stage (off the sides/bottom), just
    // like free dragging — the ONLY constraint in normal mode is that a top-edge (n/nw/ne) resize can't
    // push the title bar above the stage's top (so it stays grabbable — the #29 invariant). All stages
    // share the same top, so it's stage-independent.
    const st0 = useDesktop.getState()
    if (st0.mode === 'desktop') {
      const topY = primaryRect(st0.viewport).y
      if (ny < topY) {
        nh -= topY - ny
        ny = topY
      }
      nh = Math.max(MINH, nh)
    }
    // A manual resize takes the window out of any tiled state (so it won't pop to a stale floating size).
    useDesktop.getState().updateSurface(surface.id, { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh), preSnap: undefined })
  }
  function onResizeUp(e: React.PointerEvent): void {
    try {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    resize.current = null
  }

  const stop = (e: React.PointerEvent): void => e.stopPropagation()
  const isNote = surface.kind === 'native' && surface.component === 'note'
  const isFolder = surface.kind === 'native' && surface.component === 'folder'
  const isDirTile = isRealFolderSurface(surface)
  const isFileTile = surface.kind === 'native' && (surface.component === 'file' || surface.component === 'dir') // a real file/dir, not a window
  const isSlotted = !!slotOf(surface) // a stage tile: lattice-snapped, fixed-size, never edge-tiles
  // System panels (the pinned chat/activity hubs) keep the full window bar even when slotted —
  // hiding it would cost their close/minimize controls. Everything else slotted gets WIDGET chrome:
  // no bar at all, just an invisible top drag-grip + the pop-out toggle in the far right corner.
  const isSystemPanel = surface.role === 'chat' || surface.role === 'activity' || (surface.kind === 'native' && (surface.component === 'chat' || surface.component === 'activity'))
  const widgetChrome = isSlotted && !isSystemPanel
  const needsFocusCatcher = !isActive && !isControl && (surface.kind === 'app' || surface.kind === 'srcdoc')
  // A direct click/focus means THIS is the window the user is acting on: raise it AND drop any stale
  // marquee selection that doesn't include it — ⌘T/⇧⌘T target "the single selection else the
  // front-most", so a forgotten selection would silently hijack the keybind to an old window.
  // Clicking a selected member keeps the multi-selection (mac behavior).
  const focusHere = (): void => {
    focusSurface(surface.id)
    const st = useDesktop.getState()
    if (st.selection.length && !st.selection.includes(surface.id)) st.clearSelection()
  }
  const paper = isNote ? (NOTE_PAPER[(surface.props?.color as string) || 'coral'] ?? NOTE_PAPER.coral) : undefined

  function body(): JSX.Element {
    const fill = { width: '100%', height: '100%', border: 'none', display: 'block' } as const
    // Per-widget pinch zoom: a pure VISUAL scale — NO width/height change, so the iframe's layout viewport
    // is unchanged and the content does NOT reflow; it just magnifies and the window clips it. (The old
    // width-trick re-laid-out the content at 1/zoom width = a reflow, which isn't what "zoom" means.)
    // transformOrigin 0 0 anchors the top of the content. Web surfaces use native page-scale instead (a
    // WebContentsView can't be CSS-transformed). NOTE: a transform-scale is a bitmap magnify, so a heavily
    // zoomed widget can look soft until it re-rasters — sharp+no-reflow for an arbitrary iframe wants its
    // own page-scale (todo).
    const zo = zoomOriginRef.current
    const iframeZoom =
      zoom === 1 ? fill : { ...fill, transform: `scale(${zoom})`, transformOrigin: zo ? `${zo.x}px ${zo.y}px` : ('0 0' as const) }
    switch (surface.kind) {
      case 'web':
        // Server mode: the site lives in a server-side headless browser, streamed as a <canvas>.
        if (serverMode) return <canvas ref={canvasRef} style={fill} />
        // Electron: a real in-DOM <webview> guest PER TAB (separate processes, no iframe framing limits).
        // Ordinary DOM children of the frame, so they move/stack/clip with the window — no compositor.
        // Only materialized tabs (active + previously-active) get a live webview; inactive ones stay
        // mounted-but-hidden so their page stays alive. WebTabView owns each guest's wiring.
        return (
          <>
            {(webTabs ?? []).filter((t) => materializedTabs.current.has(t.id)).map((t) => (
              <WebTabView key={t.id} surfaceId={surface.id} tab={t} active={t.id === activeWebTab?.id} zoom={zoom} />
            ))}
          </>
        )
      case 'app':
        if (!surface.url) return <AppEmptyState />
        return (
          <iframe
            title={surface.title}
            src={surface.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            style={iframeZoom}
          />
        )
      case 'srcdoc': {
        // Prepend the OS<->widget bridge shim (window.blitz) + the Blitz UI kit (design tokens +
        // <blitz-*> web components) so every widget shares ONE component library; the stored html stays
        // clean (forkable). onLoad seeds props after the document (incl. the shim) has parsed.
        // jsx/tsx widgets: the body is the compiled composition (import map + bootstrap) — same
        // shim/kit prepend, same iframe, same bridge. Until the compile resolves, render a shell
        // (NOT an iframe) so the widget document loads exactly once.
        if (jsxWidget.active && jsxWidget.srcdoc === null) return <div className="jsx-compiling" style={fill} />
        const srcdocBody = jsxWidget.active ? jsxWidget.srcdoc! : surface.html ?? ''
        return (
          <iframe
            ref={iframeRef}
            title={surface.title}
            sandbox="allow-scripts"
            srcDoc={BRIDGE_SHIM + UI_KIT + srcdocBody}
            style={iframeZoom}
            onLoad={() =>
              iframeRef.current?.contentWindow?.postMessage({ type: 'blitz:init', props: widgetProps() }, '*')
            }
          />
        )
      }
      case 'native':
        if (surface.component === 'note') return <NoteWidget surface={surface} />
        if (surface.component === 'chat') return <ChatPanel surface={surface} />
        if (surface.component === 'activity') return <ActivityPanel surface={surface} />
        if (surface.component === 'terminal') {
          const tabs = surface.tabs || []
          const active = tabs[Math.min(Math.max(surface.activeTab || 0, 0), Math.max(0, tabs.length - 1))]
          const tid = active?.terminalId || (surface.props?.terminalId as string) || ''
          // key by terminal id so switching tabs remounts the view onto the new terminal (scrollback re-fetched)
          return <TerminalView key={tid} surface={{ ...surface, props: { terminalId: tid } }} />
        }
        if (surface.component === 'runtime') return <RuntimePanel surface={surface} />
        if (surface.component === 'inbox') return <InboxPanel surface={surface} />
        if (surface.component === 'file') return <FileWidget surface={surface} />
        if (surface.component === 'dir') return <DirWidget surface={surface} />
        if (surface.component === 'files') return <FileManager surface={surface} />
        if (surface.component === 'unlock') return <UnlockWidget surface={surface} />
        return <div className="native-fallback">unknown widget: {surface.component}</div>
    }
  }

  if (isFolder) {
    return (
      <div
        className={`window folder${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isDropTarget ? ' drop-target' : ''}`}
        style={{
          left: surface.x,
          top: surface.y,
          width: surface.w,
          height: surface.h,
          zIndex: surface.z,
        }}
        onPointerDown={focusHere}
      >
        <FolderWidget surface={surface} onDragDown={onBarDown} onDragMove={onBarMove} onDragUp={onBarUp} />
      </div>
    )
  }

  if (isDirTile) {
    const path = typeof surface.props?.path === 'string' ? surface.props.path : ''
    return (
      <div
        ref={frameRef}
        data-sid={surface.id}
        className={`desktop-folder${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isDropTarget ? ' drop-target' : ''}${isAbsorbing ? ' absorbing' : ''}`}
        style={{
          left: surface.x,
          top: surface.y,
          width: surface.w,
          height: surface.h,
          zIndex: effectiveZ(surface),
          ...(surface.minimized ? { display: 'none' } : {}),
        }}
        onPointerDown={focusHere}
      >
        <DirWidget
          surface={surface}
          renaming={!!path && renamingDirPath === path}
          onRenameDone={onDirRenameDone}
          onDragDown={onBarDown}
          onDragMove={onBarMove}
          onDragUp={onBarUp}
          onOpenMenu={(x, y) => onDirContextMenu?.(surface.id, x, y)}
        />
      </div>
    )
  }

  return (
    <div
      ref={frameRef}
      data-sid={surface.id}
      className={`window${isNote ? ' note' : ''}${surface.kind === 'web' && !serverMode ? ' browser' : ''}${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isAbsorbing ? ' absorbing' : ''}`}
      style={{
        left: surface.x,
        top: surface.y,
        width: surface.w,
        height: surface.h,
        // The sandwich's page-over-DOM direction: a higher browser's page hole is CUT out of this
        // frame so the live page (below all DOM) shows through where it should cover us. 'HIDE' =
        // fully covered: hide outright (a degenerate clip ghosts the element's outline).
        // Overlapping a browser: drop the box-shadow so it can't fringe against the page hole.
        ...(surface.minimized ? { display: 'none' } : {}),
        // Slotted tiles spring-snap into their span (the macOS settle); suspended while dragging so
        // the tile tracks the cursor 1:1, and resumed on drop for the snap animation. File tiles get
        // the smooth glide of the fluid layer (they part around tiles like displaced liquid).
        ...(isSlotted && !isDragging ? { transition: 'left 0.32s cubic-bezier(0.32, 1.23, 0.42, 1), top 0.32s cubic-bezier(0.32, 1.23, 0.42, 1), width 0.32s ease, height 0.32s ease' } : {}),
        ...(isFileTile && !isDragging ? { transition: 'left 0.4s cubic-bezier(0.22, 1, 0.36, 1), top 0.4s cubic-bezier(0.22, 1, 0.36, 1)' } : {}),
        // brandon-ui dock restore: the surface is mounted (for measurement) but hidden while the
        // genie animation plays a clone from the dock; unhidden when the phase ends.
        ...(restoring ? { visibility: 'hidden' as const, pointerEvents: 'none' as const } : {}),
        ...(paper ? { background: paper.bg, color: paper.ink } : {}),
        // Layered desktop (macOS model) — bands live in store.effectiveZ (one source, shared with
        // the browser occlusion test): tiles/icons raw z → free windows +500k → focus +1.5M →
        // pinned chat/activity +2M. A slotted tile being DRAGGED lifts above the window band so it
        // never disappears under one mid-gesture (transient, component-local).
        zIndex: effectiveZ(surface) + (isSlotted && isDragging ? 1_200_000 : 0)
      }}
      onPointerDown={focusHere}
      onFocus={focusHere} // a click INTO an iframe focuses the guest, not the host — still raise this window front-most so keybinds target it
      onContextMenu={(e) => {
        // Item 5b: right-click a native surface (note/tile/frame chrome) → annotation menu at that point.
        // web is handled in main (the WebContentsView owns the browser); srcdoc's sandboxed iframe also swallows it.
        if (surface.kind === 'web') return
        const r = e.currentTarget.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return
        e.preventDefault()
        useDesktop.getState().openAnnotationMenu(surface.id, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.clientX, e.clientY)
      }}
    >
      {widgetChrome ? (
        <>
          {/* macOS-widget chrome: the tile IS the widget — no window bar. An invisible grip strip
              along the top keeps the full drag gesture set (move, ⌘-drag, drag-to-pop-out all ride
              the same bar handlers), and the pop-in/out toggle floats in the far right corner. */}
          <div className="tile-grip" onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp} />
          <button className="tile-toggle" aria-label="Pop out of the grid" title="Pop out of the grid — free-form, restores its size (⌘T; ⇧⌘T cycles size)" onClick={toggleSlot} onPointerDown={stop}>
            ⤢
          </button>
        </>
      ) : (
        <div
          className="window-bar"
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          onPointerCancel={onBarUp}
        >
          {/* macOS traffic lights: red=close, yellow=minimize, green=zoom. Colored only when active. */}
          <div className="traffic" onPointerDown={stop}>
            {/* file/dir tiles are real files — "close"/"minimize" would just re-surface on the next
                reconcile (the file still exists), so only offer zoom; delete the file to remove it.
                A NON-primary chat widget's red light DELETES its agent (stop it + delete its chat +
                files/stage); the PRIMARY chat ('0') is pinned + never deletable → no close button. */}
            {surface.role === 'chat'
              ? surface.agentId && String(surface.agentId) !== '0'
                ? <button className="tl tl-close" title="Delete agent" onClick={() => closeAgent(String(surface.agentId))} />
                : null
              : !isFileTile && <button className="tl tl-close" title="Close" onClick={() => closeSurface(surface.id)} />}
            {!isFileTile && <button className="tl tl-min" title="Minimize" onClick={() => (onRequestMinimize ? onRequestMinimize(surface.id) : minimizeSurface(surface.id))} />}
            <button className="tl tl-max" title="Zoom" onClick={() => (onRequestToggleMaximize ? onRequestToggleMaximize(surface.id) : toggleMaximize(surface.id))} />
          </div>
          {surface.kind === 'app' || (surface.kind === 'web' && serverMode) ? (
            <form className="window-url" onSubmit={go} onPointerDown={stop}>
              <input
                value={draft}
                spellCheck={false}
                placeholder="url…"
                onChange={(e) => setDraft(e.target.value)}
                onPointerDown={stop}
              />
            </form>
          ) : surface.kind === 'web' ? (
            // Electron browser window: the address lives in the BrowserNav below; the bar shows the
            // page title like every other window (and stays the drag handle).
            <div className="window-title">{activeWebTab?.title || surface.title}</div>
          ) : (
            <div className="window-bar-fill" />
          )}
          {/* the snap/pop toggle lives at the RIGHT END of the bar (it mirrors the widget-chrome
              corner toggle, so the control is always in the same place). */}
          {!isFileTile && (
            <button className={`slot-toggle${isSlotted ? ' on' : ''}`} title={isSlotted ? 'Pop out of the grid — free-form, restores its size (⌘T; ⇧⌘T cycles size)' : 'Snap into the widget grid (⌘T)'} onClick={toggleSlot} onPointerDown={stop}>
              {isSlotted ? '⤢' : '⊞'}
            </button>
          )}
        </div>
      )}
      {webTabs && (
        <>
          {/* Browser tab strip — one page per tab (a main-owned WebContentsView each). Always shown
              (the + is how a second tab is born); closing the last tab closes the window. */}
          <div className="window-tabs" onPointerDown={stop}>
            {webTabs.map((t, i) => (
              <div
                key={t.id}
                className={`wtab${i === activeWebTabIdx ? ' active' : ''}`}
                title={t.url || t.title}
                onClick={() => setActiveTab(surface.id, i)}
              >
                {t.favicon ? (
                  <img className={`wtab-fav${t.loading ? ' loading' : ''}`} src={t.favicon} alt="" draggable={false} />
                ) : (
                  <span className={`wtab-dot${t.loading ? ' loading' : ''}`} />
                )}
                <span className="wtab-title">{t.title || 'New Tab'}</span>
                <button
                  className="wtab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    // the implicit single tab isn't materialized in the store — closing it closes the window
                    if (surface.tabs?.length) closeTab(surface.id, t.id)
                    else closeSurface(surface.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="wtab-add" title="New tab" onClick={() => addWebTab(surface.id)}>
              +
            </button>
          </div>
          {bmOpen && (
            <div
              className="bm-backdrop"
              onPointerDown={(e) => {
                e.stopPropagation()
                setBmOpen(false)
              }}
            />
          )}
          <BrowserNav surface={surface} bmOpen={bmOpen} setBmOpen={setBmOpen} />
        </>
      )}
      {surface.component === 'terminal' && surface.tabs && (
        <div className="window-tabs" onPointerDown={stop}>
          {surface.tabs.map((t, i) => (
            <div
              key={t.id}
              className={`wtab${i === (surface.activeTab || 0) ? ' active' : ''}`}
              title={t.title}
              onClick={() => setActiveTab(surface.id, i)}
            >
              <span className="wtab-title">{t.title}</span>
              <button
                className="wtab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  if (t.terminalId) (window.agentOS as unknown as { terminalStop?: (id: string) => void })?.terminalStop?.(t.terminalId)
                  closeTab(surface.id, t.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="wtab-add"
            title="New terminal tab"
            onClick={() => (window.agentOS as unknown as { terminalSpawn?: (o: object) => void })?.terminalSpawn?.({ command: 'bash', title: nextTerminalName() })}
          >
            +
          </button>
        </div>
      )}
      <div
        className="window-body"
        style={{ position: 'relative', ...(isNote ? { background: 'transparent' } : {}) }}
      >
        {body()}
        {needsFocusCatcher && <div className="window-focus-catcher" onPointerDown={focusHere} />}
      </div>
      {/* macOS-style resize from all sides + corners; above the drag-overlay so it works in control
          mode too (#41). The handles avoid the title-bar controls (traffic lights / eye).
          Slotted tiles have FIXED slot sizes (s/m/l/xl/tall) — no free resize; re-place to change. */}
      {!isSlotted &&
        (['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const).map((dir) => (
        <div
          key={dir}
          className={`rsz rsz-${dir}`}
          onPointerDown={(e) => onResizeDown(e, dir)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      ))}
      {/* Space grab-mode or selected → drag the surface from anywhere on its body. Always
          mounted (so an in-flight drag survives releasing the key); inert otherwise. */}
      <div
        className={`drag-overlay${isSelected || grabMode || isDragging || isControl ? ' active' : ''}${isControl ? ' control' : ''}`}
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
        onPointerCancel={onBarUp}
      />
    </div>
  )
})
