import { useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'
import { NoteWidget } from './NoteWidget'
import { ChatPanel } from './ChatPanel'
import { BRIDGE_SHIM } from '../widget-bridge'

type BridgeReply = { ok: boolean; data?: unknown; error?: string }
type HeldReply = { provider: string; resource: string; win: Window; reply: (r: BridgeReply) => void }

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
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const heldReplies = useRef<Map<string, HeldReply>>(new Map())
  const consented = useRef<Set<string>>(new Set()) // providers the human OK'd for THIS widget generation
  const prevHtml = useRef(surface.html)
  const serverMode = !!window.agentOS?.serverMode
  const [draft, setDraft] = useState(surface.url ?? '')
  const [consentProvider, setConsentProvider] = useState<string | null>(null)
  const [shared, setShared] = useState(false) // P0: agent may read this surface over the relay
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

  function go(e: React.FormEvent): void {
    e.preventDefault()
    const u = normalizeUrl(draft)
    setDraft(u)
    if (serverMode) {
      window.agentOS?.serverNavigate?.(surface.id, u)
      // Keep the OS's stored url/title in sync with the actual navigation. Otherwise
      // list_state stays stale and surface reconciliation can snap the page back to
      // the remembered (old) url. (Server-mode address-bar nav bypasses the store.)
      let title = u
      try {
        title = new URL(u).hostname || u
      } catch {
        /* keep u */
      }
      useDesktop.getState().updateSurface(surface.id, { url: u, title })
    } else (webviewRef.current as unknown as WebviewMethods | null)?.loadURL(u)
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
            <button
              className="window-ico"
              title={shared ? 'Agent can read this page — click to stop sharing' : 'Let the agent read this page (off by default)'}
              onPointerDown={stop}
              onClick={() => {
                const next = !shared
                setShared(next)
                window.agentOS?.setContentShare?.(surface.id, next)
              }}
              style={shared ? { color: '#4ade80' } : { opacity: 0.45 }}
            >
              👁
            </button>
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
      <div
        className="window-body"
        style={{ position: 'relative', ...(isNote ? { background: noteColor } : {}) }}
      >
        {body()}
        {consentProvider && (
          <div
            onPointerDown={stop}
            style={{
              position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
              background: 'rgba(8,10,14,.72)', backdropFilter: 'blur(2px)', zIndex: 5, padding: 16
            }}
          >
            <div style={{ maxWidth: 280, textAlign: 'center', color: '#e6edf3', font: '13px/1.5 -apple-system,system-ui' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                Allow this widget to read your <span style={{ textTransform: 'capitalize' }}>{consentProvider}</span>?
              </div>
              <div style={{ color: '#8b949e', marginBottom: 12 }}>
                It receives only the data — never your account tokens.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button onClick={() => resolveConsent(consentProvider, false)} style={{ padding: '5px 12px' }}>
                  Deny
                </button>
                <button
                  onClick={() => resolveConsent(consentProvider, true)}
                  style={{ padding: '5px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6 }}
                >
                  Allow
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="window-resize" onPointerDown={onResizeDown} onPointerMove={onResizeMove} onPointerUp={onResizeUp} />
    </div>
  )
}
