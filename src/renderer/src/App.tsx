import { useEffect, useRef, useState } from 'react'
import { useDesktop, type CreateSurfaceInput } from './store'
import type { Surface } from './types'
import { IntegrationWidget } from './components/IntegrationWidget'
import { ConnectPanel } from './components/ConnectPanel'
import { SurfaceFrame } from './components/SurfaceFrame'
import { PrimarySpace } from './components/PrimarySpace'
import { Sidebar } from './components/Sidebar'

export default function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const transform = useDesktop((s) => s.transform)
  const mode = useDesktop((s) => s.mode)
  const integrations = useDesktop((s) => s.integrations)
  const surfaces = useDesktop((s) => s.surfaces)
  const createSurface = useDesktop((s) => s.createSurface)
  const setIntegrations = useDesktop((s) => s.setIntegrations)

  const [connecting, setConnecting] = useState<string | null>(null)
  const [aiUrl, setAiUrl] = useState<string | null>(null)
  const [showAi, setShowAi] = useState(false)
  const [panMode, setPanMode] = useState(false)
  const pan = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const refresh = (): void => {
      window.agentOS?.integrations.list().then(setIntegrations)
    }
    refresh()
    const off = window.agentOS?.integrations.onUpdated(refresh)
    window.addEventListener('focus', refresh)
    return () => {
      off?.()
      window.removeEventListener('focus', refresh)
    }
  }, [setIntegrations])

  useEffect(() => {
    const onResize = (): void => {
      useDesktop.getState().setViewport(window.innerWidth, window.innerHeight)
      if (useDesktop.getState().mode === 'desktop') useDesktop.getState().goToPrimary()
    }
    onResize()
    useDesktop.getState().goToPrimary()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      // fixed desktop: no canvas pan/zoom (let webviews/iframes scroll normally)
      if (useDesktop.getState().mode !== 'canvas') return
      e.preventDefault()
      const st = useDesktop.getState()
      if (e.ctrlKey) st.zoomAt(e.clientX, e.clientY, e.deltaY)
      else st.panBy(-e.deltaX, -e.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        useDesktop.getState().goToPrimary()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Double-tap ⌘ to toggle pan-mode: a full-canvas overlay steals pointer focus
  // from every webview/iframe so you can pan anywhere. A bare ⌘ tap from a focused
  // webview arrives via onMetaTap (main).
  useEffect(() => {
    let metaDown = false
    let sawOther = false
    let lastTap = 0
    const registerTap = (): void => {
      // ⌘-pan only exists in canvas mode
      if (useDesktop.getState().mode !== 'canvas') return
      const now = performance.now()
      if (now - lastTap < 450) {
        lastTap = 0
        setPanMode((v) => !v)
      } else {
        lastTap = now
      }
    }
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') {
        if (!e.repeat) {
          metaDown = true
          sawOther = false
        }
      } else if (metaDown) {
        sawOther = true
      }
    }
    const up = (e: KeyboardEvent): void => {
      if (e.key === 'Meta') {
        if (metaDown && !sawOther) registerTap()
        metaDown = false
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    const off = window.agentOS?.onMetaTap(registerTap)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      off?.()
    }
  }, [])

  // Control actions from main (local control server or agent-socket).
  useEffect(() => {
    return window.agentOS?.onAction((a) => {
      const st = useDesktop.getState()
      if (a.type === 'create') st.createSurface(a.surface as CreateSurfaceInput)
      else if (a.type === 'move') st.moveSurface(String(a.id), Number(a.x), Number(a.y))
      else if (a.type === 'update') st.updateSurface(String(a.id), (a.patch ?? {}) as Partial<Surface>)
      else if (a.type === 'close') st.closeSurface(String(a.id))
      else if (a.type === 'goToPrimary') st.goToPrimary()
    })
  }, [])

  // Push surface state to main (so list_state works), only when surfaces change.
  useEffect(() => {
    const push = (): void => {
      const surfaces = useDesktop.getState().surfaces.map((s) => ({
        id: s.id,
        kind: s.kind,
        x: s.x,
        y: s.y,
        w: s.w,
        h: s.h,
        title: s.title,
        url: s.url
      }))
      window.agentOS?.sendState({ surfaces })
    }
    push()
    let last = useDesktop.getState().surfaces
    return useDesktop.subscribe((state) => {
      if (state.surfaces !== last) {
        last = state.surfaces
        push()
      }
    })
  }, [])

  useEffect(() => {
    return window.agentOS?.onAgentSocketUrl((url) => setAiUrl(url))
  }, [])

  function onBgDown(e: React.PointerEvent): void {
    if (useDesktop.getState().mode !== 'canvas') return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pan.current = { x: e.clientX, y: e.clientY }
  }
  function onBgMove(e: React.PointerEvent): void {
    if (!pan.current) return
    useDesktop.getState().panBy(e.clientX - pan.current.x, e.clientY - pan.current.y)
    pan.current = { x: e.clientX, y: e.clientY }
  }
  function onBgUp(e: React.PointerEvent): void {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    pan.current = null
  }

  function addBrowser(): void {
    // let the store cascade + clamp onto the desktop
    createSurface({ kind: 'web', url: 'https://news.ycombinator.com', title: 'Hacker News' })
  }

  const active = integrations.find((i) => i.id === connecting) ?? null

  return (
    <div id="root-canvas" ref={rootRef}>
      {/* draggable native-window title bar (macOS move/resize) */}
      <div className="titlebar">
        <span className="titlebar-label">BlitzOS</span>
      </div>

      <div className="bg" onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp} />

      <Sidebar onAddBrowser={addBrowser} />

      <div
        className="world"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        {mode === 'canvas' && <PrimarySpace />}
        {integrations.map((it) => (
          <IntegrationWidget key={it.id} integration={it} onConnect={setConnecting} />
        ))}
        {surfaces.map((s) => (
          <SurfaceFrame key={s.id} surface={s} />
        ))}
      </div>

      {panMode && mode === 'canvas' && (
        <div className="pan-overlay" onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp}>
          <span className="pan-hint">⌘⌘ pan mode · drag anywhere · double-tap ⌘ to exit</span>
        </div>
      )}

      <div className="toolbar">
        <button onClick={() => useDesktop.getState().goToPrimary()}>Center</button>
        <button onClick={() => setShowAi((v) => !v)}>{aiUrl ? '🟢 Connect AI' : '○ Connect AI'}</button>
        <span className="hint">fixed desktop · drag the top bar to move · click the dock to focus</span>
      </div>

      {showAi && (
        <div className="ai-panel">
          <div className="ai-head">Drive BlitzOS from an AI chat</div>
          {aiUrl ? (
            <>
              <p className="ai-sub">Paste this URL into Claude / ChatGPT and ask it to open windows, post-its, etc.</p>
              <input className="ai-url" readOnly value={aiUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="primary" onClick={() => navigator.clipboard?.writeText(aiUrl)}>
                Copy URL
              </button>
            </>
          ) : (
            <p className="ai-sub">Connecting to the agent-socket relay…</p>
          )}
        </div>
      )}

      {active && <ConnectPanel integration={active} onClose={() => setConnecting(null)} />}
    </div>
  )
}
