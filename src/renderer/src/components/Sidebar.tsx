import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDesktop } from '../store'
import { KindIcon } from './Icons'
import { SurfaceLauncherButton, type SurfaceLauncherKind } from './SurfaceLauncherButton'

interface Props {
  onRequestRestore: (id: string) => void
  onCreateSurface: (kind: SurfaceLauncherKind, source?: AnimationSourceRect | null) => void
  animating?: Record<string, 'minimizing' | 'restoring'>
}

type AnimationSourceRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

type TooltipState = {
  text: string
  left: number
  top: number
  closing?: boolean
}

/** Left dock: an icon per open surface. Click to bring it forward at real size. */
export function Sidebar({ onRequestRestore, onCreateSurface, animating = {} }: Props): JSX.Element {
  const surfaces = useDesktop((s) => s.surfaces)
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const tooltipCloseTimer = useRef<number | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const surfaceIdsKey = useMemo(() => surfaces.map((s) => s.id).join('|'), [surfaces])
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

  useEffect(() => {
    return () => {
      if (tooltipCloseTimer.current != null) window.clearTimeout(tooltipCloseTimer.current)
    }
  }, [])

  useEffect(() => {
    if (tooltipCloseTimer.current != null) {
      window.clearTimeout(tooltipCloseTimer.current)
      tooltipCloseTimer.current = null
    }
    setTooltip(null)
  }, [surfaceIdsKey])

  const showTooltip = (target: HTMLElement, text: string): void => {
    if (tooltipCloseTimer.current != null) {
      window.clearTimeout(tooltipCloseTimer.current)
      tooltipCloseTimer.current = null
    }
    const r = target.getBoundingClientRect()
    setTooltip({ text, left: Math.round(r.right + 10), top: Math.round(r.top + r.height / 2) })
  }

  const hideTooltip = (): void => {
    if (!tooltip || tooltip.closing) return
    if (tooltipCloseTimer.current != null) window.clearTimeout(tooltipCloseTimer.current)
    setTooltip((cur) => (cur ? { ...cur, closing: true } : cur))
    tooltipCloseTimer.current = window.setTimeout(() => {
      setTooltip(null)
      tooltipCloseTimer.current = null
    }, 120)
  }

  const tooltipOverlay =
    tooltip &&
    createPortal(
      <div className={`sidebar-tooltip${tooltip.closing ? ' closing' : ''}`} style={{ left: tooltip.left, top: tooltip.top }}>
        {tooltip.text}
      </div>,
      document.body
    )

  return (
    <div className="sidebar">
      {tooltipOverlay}
      <div className="sidebar-apps">
        {orderedSurfaces.map((s) => (
          <button
            key={s.id}
            data-sidebar-sid={s.id}
            className={`sidebar-app${s.minimized ? ' minimized' : ''}${animating[s.id] ? ` is-${animating[s.id]}` : ''}`}
            aria-label={s.title}
            onPointerEnter={(e) => showTooltip(e.currentTarget, s.title)}
            onPointerLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, s.title)}
            onBlur={hideTooltip}
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
      <div className="sidebar-bottom">
        <span className="sidebar-divider" aria-hidden="true" />
        <SurfaceLauncherButton
          onCreateSurface={onCreateSurface}
          label={null}
          buttonProps={{
            className: 'sidebar-create',
            title: 'Create surface',
            'aria-label': 'Create surface'
          }}
        />
      </div>
    </div>
  )
}
