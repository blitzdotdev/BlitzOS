import { useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'
import { NoteWidget } from './NoteWidget'

interface WebviewMethods {
  loadURL(url: string): Promise<void>
  reload(): void
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
  const focusSurface = useDesktop((s) => s.focusSurface)
  const closeSurface = useDesktop((s) => s.closeSurface)

  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const serverMode = !!window.agentOS?.serverMode
  const [draft, setDraft] = useState(surface.url ?? '')

  // web only: keep the URL bar synced with navigation
  useEffect(() => {
    if (surface.kind !== 'web') return
    const el = webviewRef.current as (HTMLElement & WebviewMethods) | null
    if (!el) return
    const onNav = (e: Event): void => {
      const url = (e as Event & { url?: string }).url
      if (url) setDraft(url)
    }
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    return () => {
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
    }
  }, [surface.kind])

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
    ;(webviewRef.current as unknown as WebviewMethods | null)?.loadURL(u)
  }
  function reload(): void {
    ;(webviewRef.current as unknown as WebviewMethods | null)?.reload()
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
  const stop = (e: React.PointerEvent): void => e.stopPropagation()

  const isNote = surface.kind === 'native' && surface.component === 'note'
  const noteColor = isNote ? NOTE_COLORS[(surface.props?.color as string) || 'yellow'] : undefined

  function body(): JSX.Element {
    const fill = { width: '100%', height: '100%', border: 'none', display: 'block' } as const
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
        // first-party blitz.dev app: trusted, allow scripts + same-origin
        return (
          <iframe
            title={surface.title}
            src={surface.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            style={fill}
          />
        )
      case 'srcdoc':
        // agent-authored HTML: sandboxed, no same-origin (can't reach BlitzOS)
        return <iframe title={surface.title} sandbox="allow-scripts" srcDoc={surface.html} style={fill} />
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
        <button className="window-close" onPointerDown={stop} onClick={() => closeSurface(surface.id)}>
          ×
        </button>
      </div>
      <div className="window-body" style={isNote ? { background: noteColor } : undefined}>
        {body()}
      </div>
    </div>
  )
}
