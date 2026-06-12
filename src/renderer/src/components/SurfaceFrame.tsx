import { memo, useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop, snapTargetFor, primaryRect, nextTerminalName, latticeFor, slotRect, slotOf, nearestFreeSlot, sizeForDims, areaOfX } from '../store'
import { NoteWidget } from './NoteWidget'
import { ActivityPanel } from './ActivityPanel'
import { ChatPanel } from './ChatPanel'
import { SessionTerminal } from './SessionTerminal'
import { SessionsPanel } from './SessionsPanel'
import { InboxPanel } from './InboxPanel'
import { BRIDGE_SHIM } from '../widget-bridge'
import { UI_KIT } from '../widget-ui-kit'
import { IconArrowLeft, IconArrowRight, IconEye, IconRefresh } from './Icons'
import { FolderWidget } from './FolderWidget'
import { FileWidget, DirWidget } from './FileWidget'
import { FileManager } from './FileManager'
import { UnlockWidget } from './UnlockWidget'
import { NOTE_PAPER } from '../paper'

type BridgeReply = { ok: boolean; data?: unknown; error?: string }

interface WebviewMethods {
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  isLoading?(): boolean
  setZoomFactor(factor: number): void
  getWebContentsId(): number
  getURL(): string
}

type BrowserNavState = {
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
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
// so memo lets React skip re-running each (webview-bearing) frame per animation tick. A surface's own
// store subscriptions (z/selection/drag) still re-render it independently — memo only gates the
// parent-driven churn (brandon-ui's dock-animation props ride along; they only change per-gesture).
export const SurfaceFrame = memo(function SurfaceFrame({
  surface,
  onRequestMinimize,
  onRequestToggleMaximize,
  restoring = false
}: {
  surface: Surface
  onRequestMinimize?: (id: string) => void
  onRequestToggleMaximize?: (id: string) => void
  restoring?: boolean
}): JSX.Element {
  const moveSurface = useDesktop((s) => s.moveSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const toggleMaximize = useDesktop((s) => s.toggleMaximize)
  const minimizeSurface = useDesktop((s) => s.minimizeSurface)
  const setActiveTab = useDesktop((s) => s.setActiveTab)
  const closeTab = useDesktop((s) => s.closeTab)
  const isActive = useDesktop((s) => s.activeSurfaceId === surface.id)
  const isSelected = useDesktop((s) => s.selection.includes(surface.id))
  const isDropTarget = useDesktop((s) => s.dragTarget === surface.id)
  const isAbsorbing = useDesktop((s) => s.absorbing.includes(surface.id))
  const grabMode = useDesktop((s) => s.grabMode)
  const isControl = useDesktop((s) => s.mode === 'canvas') // control mode: drag cards, don't interact
  const [isDragging, setIsDragging] = useState(false)

  const drag = useRef<{
    startX: number
    startY: number
    items: Array<{ id: string; ox: number; oy: number; ow: number; oh: number }>
    single: boolean
    grabFracX: number // where along the window the pointer grabbed (0..1) — for pop-out repositioning
    grabFracY: number
    startPreSnap?: { w: number; h: number } // floating size if this window started the drag already tiled
    poppedOut: boolean // a tiled window has been dragged back out to floating this gesture
  } | null>(null)
  const resize = useRef<{ startX: number; startY: number; origX: number; origY: number; origW: number; origH: number; dir: string } | null>(null)
  // Slotted-tile drag: the candidate lattice span under the outline ghost (committed on drop).
  const slotGhost = useRef<{ col: number; row: number } | null>(null)
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // The webview's `src` is set ONCE (uncontrolled): React must never reload a <webview> just because
  // surface.url changed in the store, or it would yank the user off the page they navigated to (the
  // "typing on Google → back to HN" bug). Programmatic navigation goes through loadURL (see below).
  const initialUrl = useRef(surface.url)
  const serverMode = !!window.agentOS?.serverMode
  const [draft, setDraft] = useState(surface.url ?? '') // address-bar draft text (web/app surfaces)
  const [browserNav, setBrowserNav] = useState<BrowserNavState>({ canGoBack: false, canGoForward: false, isLoading: false })
  const zoom = surface.zoom ?? 1

  // If this surface unmounts mid-drag (the agent closes it, a reconcile removes its file, a folder
  // absorbs it), onBarUp never fires — so clear any ghost snap-preview / drop-target it left behind.
  useEffect(() => {
    return () => {
      if (drag.current) {
        const st = useDesktop.getState()
        st.setSnapPreview(null)
        st.setDragTarget(null)
      }
    }
  }, [])

  // web: navigation sync + apply content zoom
  useEffect(() => {
    if (surface.kind !== 'web') return
    const el = webviewRef.current as (HTMLElement & WebviewMethods) | null
    if (!el) return
    const onReady = (): void => {
      try {
        el.setZoomFactor(zoom)
      } catch {
        /* not ready */
      }
      try {
        window.agentOS?.reportWebview(surface.id, el.getWebContentsId())
      } catch {
        /* not ready */
      }
    }
    el.addEventListener('dom-ready', onReady)
    onReady()
    return () => {
      el.removeEventListener('dom-ready', onReady)
    }
  }, [surface.kind, zoom, surface.id])

  // web only: report this guest's webContents id to main so the agent can drive
  // it over CDP (POST /surfaces/:id/control). No-op outside Electron.
  useEffect(() => {
    if (surface.kind !== 'web') return
    const el = webviewRef.current as (HTMLElement & { getWebContentsId(): number }) | null
    if (!el) return
    const onReady = (): void => {
      try {
        window.agentOS?.registerWebview?.(surface.id, el.getWebContentsId())
      } catch {
        // not running under Electron — ignore
      }
    }
    el.addEventListener('dom-ready', onReady)
    return () => {
      el.removeEventListener('dom-ready', onReady)
      window.agentOS?.unregisterWebview?.(surface.id)
    }
  }, [surface.kind, surface.id])

  // web (Electron) only: keep surface.url in sync with the LIVE webview location. Without this, the
  // store keeps the original url forever, it gets persisted, and a reconcile re-applies it — snapping
  // the page back (the "I was typing on Google and it took me back to HN" bug). The live page is the
  // source of truth for where this surface is.
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode) return
    const el = webviewRef.current as (HTMLElement & WebviewMethods) | null
    if (!el) return
    const onNav = (e: Event): void => {
      const url = (e as unknown as { url?: string }).url || (el.getURL ? el.getURL() : '')
      const cur = useDesktop.getState().surfaces.find((s) => s.id === surface.id)?.url
      if (url && url !== cur) useDesktop.getState().updateSurface(surface.id, { url })
    }
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    return () => {
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
    }
  }, [surface.kind, surface.id, serverMode])

  // web (Electron) only: local browser chrome state. This is intentionally NOT persisted in the
  // surface model; it reflects the live guest history/loading state.
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode) {
      setBrowserNav({ canGoBack: false, canGoForward: false, isLoading: false })
      return
    }
    const el = webviewRef.current as (HTMLElement & WebviewMethods) | null
    if (!el) return
    const update = (): void => {
      try {
        setBrowserNav({
          canGoBack: !!el.canGoBack?.(),
          canGoForward: !!el.canGoForward?.(),
          isLoading: !!el.isLoading?.()
        })
      } catch {
        setBrowserNav((cur) => ({ ...cur, canGoBack: false, canGoForward: false }))
      }
    }
    const onStart = (): void => {
      setBrowserNav((cur) => ({ ...cur, isLoading: true }))
      update()
    }
    const onStop = (): void => {
      setBrowserNav((cur) => ({ ...cur, isLoading: false }))
      update()
    }
    const onTitle = (e: Event): void => {
      const title = (e as unknown as { title?: string }).title
      if (title) useDesktop.getState().updateSurface(surface.id, { title })
    }
    el.addEventListener('dom-ready', update)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', update)
    el.addEventListener('did-navigate-in-page', update)
    el.addEventListener('page-title-updated', onTitle)
    update()
    return () => {
      el.removeEventListener('dom-ready', update)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', update)
      el.removeEventListener('did-navigate-in-page', update)
      el.removeEventListener('page-title-updated', onTitle)
    }
  }, [surface.kind, surface.id, serverMode])

  // web (Electron) only: navigate IMPERATIVELY when the store url diverges from the live location —
  // i.e. an agent/programmatic update_surface, not the user's own navigation (which the sync effect
  // above already folded into the store, so getURL() already matches and we skip the reload).
  useEffect(() => {
    if (surface.kind !== 'web' || serverMode || !surface.url) return
    const el = webviewRef.current as (HTMLElement & WebviewMethods) | null
    if (!el || !el.getURL) return
    try {
      if (el.getURL() !== surface.url) void el.loadURL(surface.url)
    } catch {
      /* not ready — dom-ready will reconcile on the next store change */
    }
  }, [surface.kind, surface.id, surface.url, serverMode])

  // Keep the address-bar draft in sync with the live/stored url (user navigation folds into the store
  // via the sync effect above; an agent update_surface{url} also lands here).
  useEffect(() => setDraft(surface.url ?? ''), [surface.url])

  function normalizeUrl(s: string): string {
    const t = s.trim()
    if (!t || /^https?:\/\//i.test(t)) return t
    if (/^[^\s/]+\.[^\s/]+(?::\d+)?(?:\/.*)?$/i.test(t) || /^[^\s/:]+:\d+(?:\/.*)?$/i.test(t) || /^localhost(?::\d+)?(?:\/.*)?$/i.test(t) || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/.*)?$/i.test(t)) {
      return 'https://' + t
    }
    return `https://www.google.com/search?q=${encodeURIComponent(t)}`
  }
  // Address-bar submit: navigate THIS surface. app (iframe) → set src through the store; web → loadURL
  // (Electron) or serverNavigate (server preview), keeping the store url/title in sync either way.
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
    } else (webviewRef.current as unknown as WebviewMethods | null)?.loadURL(u)
  }

  function goBack(): void {
    if (surface.kind !== 'web' || serverMode || !browserNav.canGoBack) return
    try {
      ;(webviewRef.current as unknown as WebviewMethods | null)?.goBack()
    } catch {
      /* guest not ready */
    }
  }

  function goForward(): void {
    if (surface.kind !== 'web' || serverMode || !browserNav.canGoForward) return
    try {
      ;(webviewRef.current as unknown as WebviewMethods | null)?.goForward()
    } catch {
      /* guest not ready */
    }
  }

  function refreshSurface(): void {
    setBrowserNav((cur) => ({ ...cur, isLoading: true }))
    if (surface.kind === 'web') {
      if (serverMode) {
        window.agentOS?.serverReload?.(surface.id)
        window.setTimeout(() => {
          setBrowserNav((cur) => ({ ...cur, isLoading: false }))
        }, 900)
        return
      }
      try {
        ;(webviewRef.current as unknown as WebviewMethods | null)?.reload()
      } catch {
        setBrowserNav((cur) => ({ ...cur, isLoading: false }))
      }
      return
    }
    if (surface.kind === 'app' && surface.url) {
      const el = iframeRef.current
      if (el) el.src = surface.url
      window.setTimeout(() => {
        setBrowserNav((cur) => ({ ...cur, isLoading: false }))
      }, 700)
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

  // srcdoc widget bridge: relay the widget's blitz:req (data from a connected
  // integration) to the OS, gated by a one-time consent prompt; reply over
  // postMessage. The sender is authenticated by object identity (event.source ===
  // our iframe.contentWindow) — origin is the unusable "null" for a sandboxed frame.
  // Deliver a reply ONLY to the generation that asked: an html reload swaps the
  // iframe's contentWindow, so a stale held reply for the old document must never
  // land on the new one (would cross-deliver consented data to different code).
  function postRes(win: Window, reqId: string, r: BridgeReply): void {
    if (iframeRef.current?.contentWindow === win) win.postMessage({ type: 'blitz:res', reqId, ...r }, '*')
  }
  // The widget bridge runs every op IMMEDIATELY — no consent gate, no card, no held queue (removed: the OS
  // draws no distinction here and a connected agent already has full power; widgets are first-class). Each
  // serve* does the work and replies to the SAME generation that asked (postRes is contentWindow-checked, so
  // a reply for the old document can't land on a reloaded iframe).
  function serveData(win: Window, reqId: string, provider: string, resource: string): Promise<void> {
    const api = window.agentOS
    if (!api?.widgetRequest) return Promise.resolve(postRes(win, reqId, { ok: false, error: 'widget data bridge unavailable here' }))
    return api
      .widgetRequest({ surfaceId: surface.id, op: 'data', provider, resource })
      .then(
        (res) => postRes(win, reqId, res?.ok ? { ok: true, data: res.data } : { ok: false, error: res?.error || 'request failed' }),
        (e) => postRes(win, reqId, { ok: false, error: e instanceof Error ? e.message : String(e) })
      )
  }
  // blitz.tool — the widget calls an OS tool (create_surface/open_window/group/provider_call/…). CLOSED
  // allowlist enforced main/server-side (widget-tools.mjs).
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
  // blitz.sendMessage — the widget sends a message to ITS session's agent. The session id rides from the
  // surface (props.sessionId, set by the host per chat session) so each chat widget routes to its own agent.
  function serveMessage(win: Window, reqId: string, text: string, sessionId?: string): Promise<void> {
    // The hub chat widget passes the ACTIVE session id per send; a plain per-session widget omits it and
    // the id rides from the surface (props.sessionId). Either way the message wakes the right session's agent.
    window.agentOS?.sendMessage?.(String(text), String(sessionId ?? surface.props?.sessionId ?? '0'))
    return Promise.resolve(postRes(win, reqId, { ok: true }))
  }
  // blitz.chat — the chat HUB manages its sessions (new / rename). Returns the result (e.g. the new id).
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
      const m = e.data as { type?: string; reqId?: string; op?: string; provider?: string; resource?: string; tool?: string; args?: unknown; text?: string; path?: string; sessionId?: string; chatOp?: string }
      if (!m || typeof m !== 'object') return
      if (m.type === 'blitz:hello') {
        win.postMessage({ type: 'blitz:init', props: surface.props ?? {} }, '*')
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
      } else if (m.type === 'blitz:annotation') {
        // Item 5b: the chat hub's grounded reference was clicked → recall the annotation bubble on its
        // surface (fire-and-forget; the ref carries the full annotation so it works after a reload).
        const ref = (m as { ref?: unknown }).ref as { id?: unknown; surfaceId?: unknown; xPct?: unknown; yPct?: unknown; text?: unknown } | undefined
        if (ref && ref.id && ref.surfaceId) {
          useDesktop.getState().recallAnnotation({ id: String(ref.id), surfaceId: String(ref.surfaceId), xPct: Number(ref.xPct) || 0, yPct: Number(ref.yPct) || 0, text: String(ref.text ?? ''), ts: 0 })
        }
      } else if (m.type === 'blitz:req' && typeof m.reqId === 'string') {
        if (m.op === 'data') void serveData(win, m.reqId, String(m.provider ?? ''), String(m.resource ?? ''))
        else if (m.op === 'tool') void serveTool(win, m.reqId, String(m.tool ?? ''), (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>)
        else if (m.op === 'msg') void serveMessage(win, m.reqId, String(m.text ?? ''), m.sessionId)
        else if (m.op === 'chat') void serveChat(win, m.reqId, String(m.chatOp ?? ''), (m.args && typeof m.args === 'object' ? m.args : {}) as Record<string, unknown>)
        else if (m.op === 'listdir') void serveListDir(win, m.reqId, String(m.path ?? ''))
        else if (m.op === 'setprops') {
          // A widget persists its OWN state (e.g. a note's text) — own-surface only, so no consent gate.
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

  // Live prop changes reach the widget without reloading it (html stays put).
  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    iframeRef.current?.contentWindow?.postMessage({ type: 'blitz:props', props: surface.props ?? {} }, '*')
  }, [surface.kind, surface.props])

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
    // A ⌥/Space "grab" of a single surface also selects it.
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
      st.setSnapPreview(null)
      return
    }
    const dx = (e.clientX - d.startX) / t.scale
    const dy = (e.clientY - d.startY) / t.scale
    for (const it of d.items) moveSurface(it.id, it.ox + dx, it.oy + dy)
    // Slotted tile drag (stage desktop, macOS widget feel): the tile floats under the cursor while an
    // OUTLINE previews the nearest free span of the lattice — other tiles NEVER move; only the file
    // layer parts fluidly around the outline. ⌘-drag skips snapping entirely (Apple's escape hatch:
    // release pops the tile off the lattice, free-form). Edge-tiling is suppressed for tiles.
    if (d.single && isSlotted && !e.metaKey) {
      const me = d.items[0]
      const sl = slotOf(surface)
      const area = surface.slotArea ?? 0
      const lat = latticeFor(st.viewport, area)
      const ghost = nearestFreeSlot(st.surfaces, lat, sl ? sl.size : 's', me.ox + dx + me.ow / 2, me.oy + dy + me.oh / 2, area, surface.id)
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
      st.setSnapPreview(null)
      return
    }
    // highlight a folder under the cursor as an add-to-folder drop target
    const dragged = new Set(d.items.map((it) => it.id))
    const folder = st.surfaces.find(
      (w) => w.component === 'folder' && !dragged.has(w.id) && wx >= w.x && wx <= w.x + w.w && wy >= w.y && wy <= w.y + w.h
    )
    st.setDragTarget(folder ? folder.id : null)
    // Snap preview (BOTH modes, #42): dragging a single window so the cursor reaches a primary-area
    // side/corner shows where it will tile on release (left|right half / quarter — never full-screen).
    // Suppressed over a folder target and for file/dir tiles (they aren't windows).
    st.setSnapPreview(d.single && !folder && !isFolder && !isFileTile ? snapTargetFor(wx, wy, st.viewport, st.currentArea, st.mode) : null)
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
    const st = useDesktop.getState()
    const target = st.dragTarget
    const snap = st.snapPreview
    st.setDragTarget(null)
    st.setSnapPreview(null)
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
    if (d && target) st.dropIntoFolder(target, d.items.map((it) => it.id))
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
    // macOS-faithful resize: a window may extend freely BEYOND the area (off the sides/bottom), just
    // like free dragging — the ONLY constraint in normal mode is that a top-edge (n/nw/ne) resize can't
    // push the title bar above the area's top (so it stays grabbable — the #29 invariant). All areas
    // share the same top, so it's area-independent.
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
  const isFileTile = surface.kind === 'native' && (surface.component === 'file' || surface.component === 'dir') // a real file/dir, not a window
  const isSlotted = !!slotOf(surface) // a stage tile: lattice-snapped, fixed-size, never edge-tiles
  const needsFocusCatcher = !isActive && !isControl && (surface.kind === 'web' || surface.kind === 'app' || surface.kind === 'srcdoc')
  const paper = isNote ? (NOTE_PAPER[(surface.props?.color as string) || 'coral'] ?? NOTE_PAPER.coral) : undefined

  function body(): JSX.Element {
    const fill = { width: '100%', height: '100%', border: 'none', display: 'block' } as const
    // CSS content-zoom for iframes (web uses native setZoomFactor instead)
    const iframeZoom =
      zoom === 1
        ? fill
        : { ...fill, width: `${100 / zoom}%`, height: `${100 / zoom}%`, transform: `scale(${zoom})`, transformOrigin: '0 0' as const }
    switch (surface.kind) {
      case 'web':
        // Server mode: the site lives in a server-side headless browser, streamed
        // here as a <canvas> (mountServerSurface draws frames + forwards input).
        // Electron / plain preview: a real <webview> guest.
        if (serverMode) return <canvas ref={canvasRef} style={fill} />
        return (
          // allowpopups: window.open must RETURN A WINDOW inside guests — when it returns null,
          // sites' fallback is `top.location = url`, which HIJACKS the whole surface (Gmail's
          // contact-hovercard gapi frame wiped the compose page this way). Main decides what each
          // popup actually becomes (hidden utility window / auth window / a new web surface) via
          // setWindowOpenHandler in index.ts — nothing opens unmanaged.
          <webview
            ref={webviewRef}
            src={initialUrl.current}
            partition="persist:agentos"
            allowpopups
            style={{ ...fill, display: 'inline-flex' }}
          />
        )
      case 'app':
        if (!surface.url) return <AppEmptyState />
        return (
          <iframe
            ref={iframeRef}
            title={surface.title}
            src={surface.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            style={iframeZoom}
          />
        )
      case 'srcdoc':
        // Prepend the OS<->widget bridge shim (window.blitz) + the Blitz UI kit (design tokens +
        // <blitz-*> web components) so every widget shares ONE component library; the stored html stays
        // clean (forkable). onLoad seeds props after the document (incl. the shim) has parsed.
        return (
          <iframe
            ref={iframeRef}
            title={surface.title}
            sandbox="allow-scripts"
            srcDoc={BRIDGE_SHIM + UI_KIT + (surface.html ?? '')}
            style={iframeZoom}
            onLoad={() =>
              iframeRef.current?.contentWindow?.postMessage({ type: 'blitz:init', props: surface.props ?? {} }, '*')
            }
          />
        )
      case 'native':
        if (surface.component === 'note') return <NoteWidget surface={surface} />
        if (surface.component === 'chat') return <ChatPanel surface={surface} />
        if (surface.component === 'activity') return <ActivityPanel surface={surface} />
        if (surface.component === 'terminal') {
          const tabs = surface.tabs || []
          const active = tabs[Math.min(Math.max(surface.activeTab || 0, 0), Math.max(0, tabs.length - 1))]
          const sid = active?.sessionId || (surface.props?.sessionId as string) || ''
          // key by session id so switching tabs remounts the terminal onto the new session (scrollback re-fetched)
          return <SessionTerminal key={sid} surface={{ ...surface, props: { sessionId: sid } }} />
        }
        if (surface.component === 'sessions') return <SessionsPanel surface={surface} />
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
        style={{ left: surface.x, top: surface.y, width: surface.w, height: surface.h, zIndex: surface.z }}
        onPointerDown={() => focusSurface(surface.id)}
      >
        <FolderWidget surface={surface} onDragDown={onBarDown} onDragMove={onBarMove} onDragUp={onBarUp} />
      </div>
    )
  }

  return (
    <div
      data-sid={surface.id}
      className={`window${isNote ? ' note' : ''}${isActive ? ' is-active' : ''}${isSelected ? ' is-selected' : ''}${isAbsorbing ? ' absorbing' : ''}`}
      style={{
        left: surface.x,
        top: surface.y,
        width: surface.w,
        height: surface.h,
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
        // The Chat + Agent-activity panels are pinned: a z-band far above any focus-raised
        // window, so the agent (or the user) can never bury the channel/feed they rely on.
        // A focus floater (L3, human pull-in) sits in its own band just under the pinned panels.
        zIndex:
          surface.role === 'chat' || surface.role === 'activity' || (surface.kind === 'native' && (surface.component === 'chat' || surface.component === 'activity'))
            ? 2_000_000 + surface.z
            : surface.focus
              ? 1_500_000 + surface.z
              : surface.z
      }}
      onPointerDown={() => focusSurface(surface.id)}
      onFocus={() => focusSurface(surface.id)} // a click INTO an iframe/webview focuses the guest, not the host — still raise this window front-most so keybinds target it
      onContextMenu={(e) => {
        // Item 5b: right-click a native surface (note/tile/frame chrome) → annotation menu at that point.
        // web is handled in main (the webview swallows this); srcdoc's sandboxed iframe also swallows it.
        if (surface.kind === 'web') return
        const r = e.currentTarget.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return
        e.preventDefault()
        useDesktop.getState().openAnnotationMenu(surface.id, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, e.clientX, e.clientY)
      }}
    >
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
              reconcile (the file still exists), so only offer zoom; delete the file to remove it. */}
          {!isFileTile && <button className="tl tl-close" title="Close" onClick={() => closeSurface(surface.id)} />}
          {!isFileTile && <button className="tl tl-min" title="Minimize" onClick={() => (onRequestMinimize ? onRequestMinimize(surface.id) : minimizeSurface(surface.id))} />}
          <button className="tl tl-max" title="Zoom" onClick={() => (onRequestToggleMaximize ? onRequestToggleMaximize(surface.id) : toggleMaximize(surface.id))} />
        </div>
        {!isFileTile && (
          <button className={`slot-toggle${isSlotted ? ' on' : ''}`} title={isSlotted ? 'Pop out of the grid — free-form, restores its size (⌘T; ⇧⌘T cycles size)' : 'Snap into the widget grid (⌘T)'} onClick={toggleSlot} onPointerDown={stop}>
            {isSlotted ? '⤢' : '⊞'}
          </button>
        )}
        {surface.kind === 'web' || surface.kind === 'app' ? (
          <div className="browser-chrome" onPointerDown={stop}>
            <div className="browser-controls">
              <button className="browser-nav-btn" title="Back" disabled={surface.kind !== 'web' || serverMode || !browserNav.canGoBack} onClick={goBack}>
                <IconArrowLeft size={13} />
              </button>
              <button className="browser-nav-btn" title="Forward" disabled={surface.kind !== 'web' || serverMode || !browserNav.canGoForward} onClick={goForward}>
                <IconArrowRight size={13} />
              </button>
              <button className="browser-nav-btn" title="Refresh" disabled={surface.kind === 'app' && !surface.url} onClick={refreshSurface}>
                <IconRefresh size={13} />
              </button>
            </div>
            <form className="window-url" onSubmit={go}>
              <input
                value={draft}
                spellCheck={false}
                placeholder="Search or enter URL"
                onChange={(e) => setDraft(e.target.value)}
                onPointerDown={stop}
              />
            </form>
          </div>
        ) : (
          <div className="window-bar-fill" />
        )}
      </div>
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
                  if (t.sessionId) (window.agentOS as unknown as { sessionStop?: (id: string) => void })?.sessionStop?.(t.sessionId)
                  closeTab(surface.id, t.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="wtab-add"
            title="New session tab"
            onClick={() => (window.agentOS as unknown as { sessionSpawn?: (o: object) => void })?.sessionSpawn?.({ command: 'bash', title: nextTerminalName() })}
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
        {needsFocusCatcher && <div className="window-focus-catcher" onPointerDown={() => focusSurface(surface.id)} />}
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
      {/* ⌥/Space grab-mode or selected → drag the surface from anywhere on its body. Always
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
