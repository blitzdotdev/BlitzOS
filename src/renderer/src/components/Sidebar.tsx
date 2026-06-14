import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDesktop, surfaceStage } from '../store'
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

/** Left dock: an icon per surface ATTACHED TO THE CURRENT STAGE (the per-stage dock,
 *  plans/blitzos-stage-splay-lattice.md) — switching stages refreshes it to that stage's set.
 *  Membership is the SAME shared rule the splay drag moves by: slotStage, else the owning agent's
 *  stage (chat), else the lattice cell holding the surface's center (free/minimized/parked alike). */
export function Sidebar({ onRequestRestore, onCreateSurface, animating = {} }: Props): JSX.Element {
  const allSurfaces = useDesktop((s) => s.surfaces)
  const currentStage = useDesktop((s) => s.currentStage)
  const stageOrder = useDesktop((s) => s.stageOrder)
  const stageCount = useDesktop((s) => s.stageCount)
  const viewport = useDesktop((s) => s.viewport)
  const surfaces = useMemo(
    () => allSurfaces.filter((s) => surfaceStage(s, viewport, stageOrder, stageCount) === currentStage),
    [allSurfaces, viewport, stageOrder, stageCount, currentStage]
  )
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const tooltipCloseTimer = useRef<number | null>(null)
  const appearTimers = useRef<Map<string, number>>(new Map())
  const seenSurfaceIds = useRef<Set<string> | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [appearing, setAppearing] = useState<Record<string, true>>({})
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
      for (const timer of appearTimers.current.values()) window.clearTimeout(timer)
      appearTimers.current.clear()
    }
  }, [])

  useEffect(() => {
    const ids = new Set(surfaces.map((s) => s.id))
    if (seenSurfaceIds.current == null) {
      seenSurfaceIds.current = ids
      return
    }

    const entered = [...ids].filter((id) => !seenSurfaceIds.current?.has(id))
    seenSurfaceIds.current = ids
    if (!entered.length) return

    setAppearing((cur) => {
      const next = { ...cur }
      for (const id of entered) next[id] = true
      return next
    })

    for (const id of entered) {
      const old = appearTimers.current.get(id)
      if (old != null) window.clearTimeout(old)
      const timer = window.setTimeout(() => {
        appearTimers.current.delete(id)
        setAppearing((cur) => {
          if (!cur[id]) return cur
          const next = { ...cur }
          delete next[id]
          return next
        })
      }, 820)
      appearTimers.current.set(id, timer)
    }
  }, [surfaces])

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
            className={`sidebar-app${s.minimized ? ' minimized' : ''}${animating[s.id] ? ` is-${animating[s.id]}` : ''}${appearing[s.id] && !animating[s.id] ? ' is-appearing' : ''}`}
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
