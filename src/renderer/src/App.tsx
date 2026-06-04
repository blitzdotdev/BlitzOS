import { useEffect, useRef, useState } from 'react'
import { useDesktop } from './store'
import { IntegrationWidget } from './components/IntegrationWidget'
import { ConnectPanel } from './components/ConnectPanel'
import { WindowFrame } from './components/WindowFrame'
import { PrimarySpace } from './components/PrimarySpace'

export default function App(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const transform = useDesktop((s) => s.transform)
  const integrations = useDesktop((s) => s.integrations)
  const windows = useDesktop((s) => s.windows)
  const addWindow = useDesktop((s) => s.addWindow)
  const setIntegrations = useDesktop((s) => s.setIntegrations)

  const [connecting, setConnecting] = useState<string | null>(null)
  const pan = useRef<{ x: number; y: number } | null>(null)

  // Load integration statuses; refresh whenever the main process signals a change.
  useEffect(() => {
    const refresh = (): void => {
      window.agentOS?.integrations.list().then(setIntegrations)
    }
    refresh()
    const off = window.agentOS?.integrations.onUpdated(refresh)
    // re-list on focus so edits to integrations.config.json show up without a restart
    window.addEventListener('focus', refresh)
    return () => {
      off?.()
      window.removeEventListener('focus', refresh)
    }
  }, [setIntegrations])

  useEffect(() => {
    const onResize = (): void => useDesktop.getState().setViewport(window.innerWidth, window.innerHeight)
    onResize()
    useDesktop.getState().goToPrimary()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
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

  useEffect(() => {
    return window.agentOS?.onOpenWindow((p) =>
      addWindow({ id: p.id, url: p.url, x: p.x, y: p.y, w: p.w, h: p.h, title: p.title })
    )
  }, [addWindow])

  function onBgDown(e: React.PointerEvent): void {
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

  const active = integrations.find((i) => i.id === connecting) ?? null

  return (
    <div id="root-canvas" ref={rootRef}>
      <div className="bg" onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp} />

      <div
        className="world"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        <PrimarySpace />
        {integrations.map((it) => (
          <IntegrationWidget key={it.id} integration={it} onConnect={setConnecting} />
        ))}
        {windows.map((w) => (
          <WindowFrame key={w.id} win={w} />
        ))}
      </div>

      <div className="toolbar">
        <button onClick={() => addWindow({ url: 'https://example.com', title: 'example.com' })}>+ Window</button>
        <button onClick={() => useDesktop.getState().goToPrimary()}>Primary (⌘0)</button>
        <span className="hint">drag empty space to pan · pinch / ctrl-scroll to zoom</span>
      </div>

      {active && <ConnectPanel integration={active} onClose={() => setConnecting(null)} />}
    </div>
  )
}
