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

  // The browser/server preview is an infinite canvas (pan/zoom), not the fixed
  // desktop the Electron app defaults to.
  useEffect(() => {
    if (window.agentOS?.serverMode) useDesktop.getState().setMode('canvas')
  }, [])

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
      else if (a.type === 'chat') {
        // Agent reply -> append to the Chat panel (create one if none is open).
        const text = String(a.text ?? '')
        if (!text) return
        const chat = st.surfaces.find((s) => s.kind === 'native' && s.component === 'chat')
        if (chat) {
          const msgs = (chat.props?.messages as Array<{ role: string; text: string }>) ?? []
          st.updateSurfaceProps(chat.id, { messages: [...msgs, { role: 'agent', text }] })
        } else {
          st.createSurface({ kind: 'native', component: 'chat', title: 'Chat', w: 360, h: 460, props: { messages: [{ role: 'agent', text }] } })
        }
      }
    })
  }, [])

  // srcdoc surfaces (agent-authored UI) can fire actions back to the agent: a
  // sandboxed iframe postMessages {__blitz:'action', surfaceId, ...} to us and we
  // forward it to main, which emits it into the agent's event stream (the callback
  // half of interactive surfaces, e.g. an "approve" button in a triage panel).
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as Record<string, unknown> | null
      if (!d || typeof d !== 'object') return
      // Local UI action: navigate the shared "Sources" tab instantly, no agent round-trip.
      // Only http(s) — a sandboxed widget must not push javascript:/data:/file: URLs into a web surface.
      if (d.__blitz === 'navigate' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) {
        const st = useDesktop.getState()
        const tab = st.surfaces.find((s) => s.kind === 'web' && s.title === 'Sources')
        if (tab) st.updateSurface(tab.id, { url: d.url as string })
        else st.createSurface({ kind: 'web', url: d.url as string, title: 'Sources' })
        return
      }
      // Agent action: forward to the agent's event stream (approve, etc.). Cap the
      // payload so a hostile widget can't pump large/looping content through it.
      if (d.__blitz === 'action') {
        try {
          if (JSON.stringify(d).length <= 4000) window.agentOS?.surfaceAction(d)
        } catch {
          /* non-serializable payload — drop */
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Push desktop state to main (so list_state works). Includes the layout the agent
  // needs to arrange windows well: the viewport (screen size), the world-space rect the
  // user can actually SEE right now (so it never drops surfaces off-screen), per-surface
  // z (stacking), and the mode. Surface changes push immediately; camera/pan churn is
  // throttled so panning doesn't flood the channel.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = (): void => {
      const st = useDesktop.getState()
      const { scale, x: tx, y: ty } = st.transform
      const vw = st.viewport.w
      const vh = st.viewport.h
      const surfaces = st.surfaces.map((s) => ({
        id: s.id,
        kind: s.kind,
        x: Math.round(s.x),
        y: Math.round(s.y),
        w: s.w,
        h: s.h,
        z: s.z,
        title: s.title,
        url: s.url
      }))
      // The world-space rectangle currently visible on screen (screen = world*scale + t).
      const view = {
        x: Math.round(-tx / scale),
        y: Math.round(-ty / scale),
        w: Math.round(vw / scale),
        h: Math.round(vh / scale),
        cx: Math.round((vw / 2 - tx) / scale),
        cy: Math.round((vh / 2 - ty) / scale),
        scale: Math.round(scale * 100) / 100
      }
      window.agentOS?.sendState({ surfaces, viewport: { w: vw, h: vh }, view, mode: st.mode })
    }
    push()
    let lastS = useDesktop.getState().surfaces
    let lastT = useDesktop.getState().transform
    let lastVp = useDesktop.getState().viewport
    let lastMode = useDesktop.getState().mode
    const scheduleCamera = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        push()
      }, 250)
    }
    const unsub = useDesktop.subscribe((state) => {
      if (state.surfaces !== lastS) {
        lastS = state.surfaces
        push() // surface set changed — reflect it at once
      } else if (state.transform !== lastT || state.viewport !== lastVp || state.mode !== lastMode) {
        lastT = state.transform
        lastVp = state.viewport
        lastMode = state.mode
        scheduleCamera() // pan/zoom — coalesce bursts
      }
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
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

  function openChat(): void {
    const st = useDesktop.getState()
    const existing = st.surfaces.find((s) => s.kind === 'native' && s.component === 'chat')
    if (existing) st.focusSurface(existing.id)
    else createSurface({ kind: 'native', component: 'chat', title: 'Chat', w: 360, h: 460, props: { messages: [] } })
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
        <button onClick={openChat}>💬 Chat</button>
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
