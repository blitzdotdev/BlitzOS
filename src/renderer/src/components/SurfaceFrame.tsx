import { useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'
import { NoteWidget } from './NoteWidget'

interface WebviewMethods {
  loadURL(url: string): Promise<void>
  reload(): void
  setZoomFactor(factor: number): void
  getWebContentsId(): number
}

function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return 'about:blank'
  if (/^https?:\/\//i.test(s)) return s
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

const NOTE_COLORS: Record<string, string> = {
  yellow: '#f6d365',
  pink: '#ffadad',
  blue: '#a0c4ff',
  green: '#caffbf'
}

export function SurfaceFrame({ surface }: { surface: Surface }): JSX.Element {
  const moveSurface = useDesktop((s) => s.moveSurface)
  const resizeSurface = useDesktop((s) => s.resizeSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const setZoom = useDesktop((s) => s.setZoom)
  const toggleMaximize = useDesktop((s) => s.toggleMaximize)

  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resize = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const serverMode = !!window.agentOS?.serverMode
  const [draft, setDraft] = useState(surface.url ?? '')
  const zoom = surface.zoom ?? 1

  // web: navigation sync + apply content zoom
  useEffect(() => {
    if (surface.kind !== 'web') return
    const el = webviewRef.current as (HTMLElement & WebviewMethods) | null
    if (!el) return
    const onNav = (e: Event): void => {
      const url = (e as Event & { url?: string }).url
      if (url) setDraft(url)
    }
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
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('dom-ready', onReady)
    onReady()
    return () => {
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
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

  // Server mode: mount the streamed <canvas> for this web surface (draws screencast
  // frames, forwards pointer/wheel/key to the server browser via the stream WS).
  useEffect(() => {
    if (surface.kind !== 'web' || !serverMode) return
    const c = canvasRef.current
    const mount = window.agentOS?.mountServerSurface
    if (!c || !mount) return
    return mount(c, surface.id, { w: surface.w, h: surface.h })
  }, [surface.kind, surface.id, surface.w, surface.h, serverMode])

  function go(e: React.FormEvent): void {
    e.preventDefault()
    const u = normalizeUrl(draft)
    setDraft(u)
    if (serverMode) window.agentOS?.serverNavigate?.(surface.id, u)
    else (webviewRef.current as unknown as WebviewMethods | null)?.loadURL(u)
  }
  function reload(): void {
    if (serverMode) window.agentOS?.serverReload?.(surface.id)
    else (webviewRef.current as unknown as WebviewMethods | null)?.reload()
  }

  function onBarDown(e: React.PointerEvent): void {
    e.stopPropagation()
    focusSurface(surface.id)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startY: e.clientY, origX: surface.x, origY: surface.y }
  }
  function onBarMove(e: React.PointerEvent): void {
    if (!drag.current) return
    const scale = useDesktop.getState().transform.scale
    moveSurface(
      surface.id,
      drag.current.origX + (e.clientX - drag.current.startX) / scale,
      drag.current.origY + (e.clientY - drag.current.startY) / scale
    )
  }
  function onBarUp(e: React.PointerEvent): void {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    drag.current = null
  }

  function onResizeDown(e: React.PointerEvent): void {
    e.stopPropagation()
    focusSurface(surface.id)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    resize.current = { startX: e.clientX, startY: e.clientY, origW: surface.w, origH: surface.h }
  }
  function onResizeMove(e: React.PointerEvent): void {
    if (!resize.current) return
    const scale = useDesktop.getState().transform.scale
    resizeSurface(
      surface.id,
      resize.current.origW + (e.clientX - resize.current.startX) / scale,
      resize.current.origH + (e.clientY - resize.current.startY) / scale
    )
  }
  function onResizeUp(e: React.PointerEvent): void {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    resize.current = null
  }

  const stop = (e: React.PointerEvent): void => e.stopPropagation()
  const isNote = surface.kind === 'native' && surface.component === 'note'
  const noteColor = isNote ? NOTE_COLORS[(surface.props?.color as string) || 'yellow'] : undefined

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
            src={surface.url}
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
        return <iframe title={surface.title} sandbox="allow-scripts" srcDoc={surface.html} style={iframeZoom} />
      case 'native':
        if (surface.component === 'note') return <NoteWidget surface={surface} />
        return <div className="native-fallback">unknown widget: {surface.component}</div>
    }
  }

  return (
    <div
      className={isNote ? 'window note' : 'window'}
      style={{ left: surface.x, top: surface.y, width: surface.w, height: surface.h, zIndex: surface.z }}
      onPointerDown={() => focusSurface(surface.id)}
    >
      <div
        className="window-bar"
        style={isNote ? { background: noteColor, color: '#3a2f00' } : undefined}
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
      >
        <span className="window-grip" />
        {surface.kind === 'web' ? (
          <>
            <button className="window-ico" title="Reload" onPointerDown={stop} onClick={reload}>
              ⟳
            </button>
            <form className="window-url" onSubmit={go} onPointerDown={stop}>
              <input value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
            </form>
          </>
        ) : (
          <span className="window-title">{surface.title}</span>
        )}
        <button className="window-ico" title="Zoom out" onPointerDown={stop} onClick={() => setZoom(surface.id, zoom - 0.15)}>
          −
        </button>
        <button className="window-ico zoom-label" title="Reset zoom" onPointerDown={stop} onClick={() => setZoom(surface.id, 1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="window-ico" title="Zoom in" onPointerDown={stop} onClick={() => setZoom(surface.id, zoom + 0.15)}>
          +
        </button>
        <button className="window-ico" title="Maximize / restore" onPointerDown={stop} onClick={() => toggleMaximize(surface.id)}>
          ⛶
        </button>
        <button className="window-close" onPointerDown={stop} onClick={() => closeSurface(surface.id)}>
          ×
        </button>
      </div>
      <div className="window-body" style={isNote ? { background: noteColor } : undefined}>
        {body()}
      </div>
      <div className="window-resize" onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
    </div>
  )
}
