import { useMemo, useRef } from 'react'
import { useDesktop } from '../store'
import { IconPlus, KindIcon } from './Icons'

interface Props {
  onAddBrowser: () => void
  onRequestRestore: (id: string) => void
  animating?: Record<string, 'minimizing' | 'restoring'>
}

/** Left dock: + to add a browser, then an icon per open surface. Click to bring it forward at real size. */
export function Sidebar({ onAddBrowser, onRequestRestore, animating = {} }: Props): JSX.Element {
  const surfaces = useDesktop((s) => s.surfaces)
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const orderRef = useRef<Map<string, number>>(new Map())
  const nextOrder = useRef(0)
  const orderedSurfaces = useMemo(() => {
    const live = new Set(surfaces.map((s) => s.id))
    for (const id of orderRef.current.keys()) {
      if (!live.has(id)) orderRef.current.delete(id)
    }
    for (const s of surfaces) {
      if (!orderRef.current.has(s.id)) orderRef.current.set(s.id, nextOrder.current++)
    }
    return [...surfaces].sort((a, b) => (orderRef.current.get(a.id) ?? 0) - (orderRef.current.get(b.id) ?? 0))
  }, [surfaces])

  return (
    <div className="sidebar">
      <button className="sidebar-btn" title="New browser window" onClick={onAddBrowser}>
        <IconPlus />
      </button>
      {surfaces.length > 0 && <div className="sidebar-sep" />}
      <div className="sidebar-apps">
        {orderedSurfaces.map((s) => (
          <button
            key={s.id}
            data-sidebar-sid={s.id}
            className={`sidebar-app${s.minimized ? ' minimized' : ''}${animating[s.id] ? ` is-${animating[s.id]}` : ''}`}
            title={`${s.title}${s.minimized ? ' (minimized)' : ''} — click to bring forward`}
            onClick={() => {
              if (animating[s.id]) return
              if (s.minimized) {
                onRequestRestore(s.id)
                return
              }
              focusAndZoom(s.id)
            }}
            onAuxClick={(e) => {
              if (animating[s.id]) return
              if (e.button === 1) closeSurface(s.id) // middle-click closes
            }}
          >
            <span className="sidebar-app-ic">
              <KindIcon kind={s.kind} />
            </span>
            <span className="sidebar-app-label">{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
