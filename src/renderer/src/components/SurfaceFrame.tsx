import { useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop, snapTargetFor, primaryRect, areaRect } from '../store'
import { NoteWidget } from './NoteWidget'
import { ActivityPanel } from './ActivityPanel'
import { ChatPanel } from './ChatPanel'
import { BRIDGE_SHIM } from '../widget-bridge'
import { IconEye } from './Icons'
import { FolderWidget } from './FolderWidget'
import { FileWidget, DirWidget } from './FileWidget'
import { NOTE_PAPER } from '../paper'

type BridgeReply = { ok: boolean; data?: unknown; error?: string }
type HeldReply = { provider: string; resource: string; win: Window; reply: (r: BridgeReply) => void }

interface WebviewMethods {
  loadURL(url: string): Promise<void>
  reload(): void
  setZoomFactor(factor: number): void
  getWebContentsId(): number
  getURL(): string
}

export function SurfaceFrame({ surface }: { surface: Surface }): JSX.Element {
  const moveSurface = useDesktop((s) => s.moveSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const toggleMaximize = useDesktop((s) => s.toggleMaximize)
  const minimizeSurface = useDesktop((s) => s.minimizeSurface)
  // macOS-style: the front-most (highest-z) surface is "active"; only its lights colorize.
  const maxZ = useDesktop((s) => s.surfaces.reduce((m, w) => Math.max(m, w.z), -Infinity))
  const isActive = surface.z === maxZ
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
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const heldReplies = useRef<Map<string, HeldReply>>(new Map())
  const consented = useRef<Set<string>>(new Set()) // providers the human OK'd for THIS widget generation
  const prevHtml = useRef(surface.html)
  // The webview's `src` is set ONCE (uncontrolled): React must never reload a <webview> just because
  // surface.url changed in the store, or it would yank the user off the page they navigated to (the
  // "typing on Google → back to HN" bug). Programmatic navigation goes through loadURL (see below).
  const initialUrl = useRef(surface.url)
  const serverMode = !!window.agentOS?.serverMode
  const [consentProvider, setConsentProvider] = useState<string | null>(null)
  const [shared, setShared] = useState(surface.shared ?? false) // P0: agent may read this surface over the relay (agent-opened web/app start shared)
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
  async function serveData(win: Window, reqId: string, provider: string, resource: string): Promise<void> {
    const api = window.agentOS
    if (!api?.widgetRequest) return postRes(win, reqId, { ok: false, error: 'widget data bridge unavailable here' })
    // The renderer is the consent authority: a provider must be approved for THIS
    // generation before any backend call. This is deterministic (no dependence on a
    // revoke round-trip): a reloaded widget starts with an empty `consented` set, so
    // new code always re-prompts even if the backend grant hasn't been dropped yet.
    if (!consented.current.has(provider)) {
      heldReplies.current.set(reqId, { provider, resource, win, reply: (r) => postRes(win, reqId, r) })
      setConsentProvider((cur) => cur ?? provider)
      return
    }
    const res = await api.widgetRequest({ surfaceId: surface.id, op: 'data', provider, resource })
    if (res?.ok) return postRes(win, reqId, { ok: true, data: res.data })
    if (res?.code === 'consent_required') {
      // backend dropped the grant (e.g. revoked) — fall back to re-prompting
      consented.current.delete(provider)
      heldReplies.current.set(reqId, { provider, resource, win, reply: (r) => postRes(win, reqId, r) })
      setConsentProvider((cur) => cur ?? provider)
      return
    }
    postRes(win, reqId, { ok: false, error: res?.error || 'request failed' })
  }
  async function resolveConsent(provider: string, allow: boolean): Promise<void> {
    setConsentProvider(null)
    const held = [...heldReplies.current.entries()].filter(([, v]) => v.provider === provider)
    held.forEach(([k]) => heldReplies.current.delete(k))
    if (!allow) {
      held.forEach(([, v]) => v.reply({ ok: false, error: 'access denied by the user' }))
    } else {
      consented.current.add(provider)
      await window.agentOS?.grantConsent?.(surface.id, provider)
      for (const [, v] of held) {
        const res = await window.agentOS?.widgetRequest?.({ surfaceId: surface.id, op: 'data', provider, resource: v.resource })
        v.reply(res?.ok ? { ok: true, data: res.data } : { ok: false, error: res?.error || 'request failed' })
      }
    }
    const next = [...heldReplies.current.values()][0]?.provider ?? null
    if (next) setConsentProvider(next)
  }

  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    const onMessage = (e: MessageEvent): void => {
      const win = iframeRef.current?.contentWindow
      if (!win || e.source !== win) return // only OUR widget (origin is unusable "null")
      const m = e.data as { type?: string; reqId?: string; op?: string; provider?: string; resource?: string }
      if (!m || typeof m !== 'object') return
      if (m.type === 'blitz:hello') {
        win.postMessage({ type: 'blitz:init', props: surface.props ?? {} }, '*')
      } else if (m.type === 'blitz:req' && typeof m.reqId === 'string') {
        if (m.op === 'data') void serveData(win, m.reqId, String(m.provider ?? ''), String(m.resource ?? ''))
        else postRes(win, m.reqId, { ok: false, error: `unsupported op: ${String(m.op)}` })
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

  // An html change is a NEW code generation: the human approved the OLD code, not
  // this one. Revoke any prior consent (so the reloaded widget must re-ask) and
  // deny in-flight held replies so they can't cross into the new document.
  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    if (prevHtml.current === surface.html) return // initial mount, or no change
    prevHtml.current = surface.html
    consented.current.clear() // new generation must re-earn consent (deterministic gate)
    window.agentOS?.revokeConsent?.(surface.id)
    heldReplies.current.forEach((v) => v.reply({ ok: false, error: 'widget reloaded' }))
    heldReplies.current.clear()
    setConsentProvider(null)
  }, [surface.kind, surface.id, surface.html])

  // On close/unmount, deny any pending consent requests (no dangling held replies).
  useEffect(() => {
    if (surface.kind !== 'srcdoc') return
    return () => {
      heldReplies.current.forEach((v) => v.reply({ ok: false, error: 'closed' }))
      heldReplies.current.clear()
    }
  }, [surface.kind, surface.id])

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
    // highlight a folder under the cursor as an add-to-folder drop target
    const dragged = new Set(d.items.map((it) => it.id))
    const folder = st.surfaces.find(
      (w) => w.component === 'folder' && !dragged.has(w.id) && wx >= w.x && wx <= w.x + w.w && wy >= w.y && wy <= w.y + w.h
    )
    st.setDragTarget(folder ? folder.id : null)
    // Snap preview (BOTH modes, #42): dragging a single window so the cursor reaches a primary-area
    // side/corner shows where it will tile on release (left|right half / quarter — never full-screen).
    // Suppressed over a folder target and for file/dir tiles (they aren't windows).
    st.setSnapPreview(d.single && !folder && !isFolder && !isFileTile ? snapTargetFor(wx, wy, st.viewport, st.currentArea) : null)
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
    // Keep the resized window inside the primary area in normal mode (mirrors the move clamp; a
    // title bar must not slide under the top titlebar — the #29 invariant, for resize too).
    const st0 = useDesktop.getState()
    if (st0.mode === 'desktop') {
      const pr = st0.currentArea === 0 ? primaryRect(st0.viewport) : areaRect(st0.currentArea, st0.viewport)
      if (nx < pr.x) {
        nw -= pr.x - nx
        nx = pr.x
      }
      if (ny < pr.y) {
        nh -= pr.y - ny
        ny = pr.y
      }
      if (nx + nw > pr.x + pr.w) nw = pr.x + pr.w - nx
      if (ny + nh > pr.y + pr.h) nh = pr.y + pr.h - ny
      nw = Math.max(MINW, nw)
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
          <webview
            ref={webviewRef}
            src={initialUrl.current}
            partition="persist:agentos"
            style={{ ...fill, display: 'inline-flex' }}
          />
        )
      case 'app':
        return (
          <iframe
            title={surface.title}
            src={surface.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            style={iframeZoom}
          />
        )
      case 'srcdoc':
        // Prepend the OS<->widget bridge shim so window.blitz exists in every
        // widget; the stored html stays clean (forkable). onLoad seeds props after
        // the document (incl. the shim) has parsed — closes the listener race.
        return (
          <iframe
            ref={iframeRef}
            title={surface.title}
            sandbox="allow-scripts"
            srcDoc={BRIDGE_SHIM + (surface.html ?? '')}
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
        if (surface.component === 'file') return <FileWidget surface={surface} />
        if (surface.component === 'dir') return <DirWidget surface={surface} />
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
        ...(paper ? { background: paper.bg, color: paper.ink } : {}),
        // The Chat + Agent-activity panels are pinned: a z-band far above any focus-raised
        // window, so the agent (or the user) can never bury the channel/feed they rely on.
        zIndex:
          surface.kind === 'native' && (surface.component === 'chat' || surface.component === 'activity')
            ? 2_000_000 + surface.z
            : surface.z
      }}
      onPointerDown={() => focusSurface(surface.id)}
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
          {!isFileTile && <button className="tl tl-min" title="Minimize" onClick={() => minimizeSurface(surface.id)} />}
          <button className="tl tl-max" title="Zoom" onClick={() => toggleMaximize(surface.id)} />
        </div>
        <div className="window-bar-fill" />
        {surface.kind === 'web' && (
          <button
            className="window-ico"
            title={shared ? 'Agent can read this page — click to stop sharing' : 'Let the agent read this page (off by default)'}
            onPointerDown={stop}
            onClick={() => {
              const next = !shared
              setShared(next)
              window.agentOS?.setContentShare?.(surface.id, next)
            }}
            style={shared ? { color: 'var(--positive)' } : { color: 'var(--text-secondary)', opacity: 0.85 }}
          >
            <IconEye />
          </button>
        )}
      </div>
      <div
        className="window-body"
        style={{ position: 'relative', ...(isNote ? { background: 'transparent' } : {}) }}
      >
        {body()}
        {consentProvider && (
          <div className="consent" onPointerDown={stop}>
            <div className="consent-card">
              <h4>
                Allow this widget to read your{' '}
                <span style={{ textTransform: 'capitalize' }}>{consentProvider}</span>?
              </h4>
              <p>It receives only the data — never your account tokens.</p>
              <div className="consent-actions">
                <button className="btn ghost" onClick={() => resolveConsent(consentProvider, false)}>
                  Deny
                </button>
                <button className="btn primary" onClick={() => resolveConsent(consentProvider, true)}>
                  Allow
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* macOS-style resize from all sides + corners; above the drag-overlay so it works in control
          mode too (#41). The handles avoid the title-bar controls (traffic lights / eye). */}
      {(['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'] as const).map((dir) => (
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
}
