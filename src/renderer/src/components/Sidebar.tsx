import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDesktop } from '../store'
import { IconBoard, IconCode, IconFolder, IconGlobe, IconGrid, IconNote, IconPlus, IconSparkle, KindIcon } from './Icons'

export type SurfaceLauncherKind = 'browser' | 'note' | 'app' | 'widget' | 'folder' | 'board'

interface Props {
  onCreateSurface: (kind: SurfaceLauncherKind) => void
  onRequestRestore: (id: string) => void
  animating?: Record<string, 'minimizing' | 'restoring'>
}

type LauncherState = {
  left: number
  top: number
  closing?: boolean
}

type TooltipState = {
  text: string
  left: number
  top: number
  closing?: boolean
}

type LauncherItem = {
  kind: SurfaceLauncherKind
  label: string
  icon: ReactNode
}

const LAUNCHER_ITEMS: LauncherItem[] = [
  { kind: 'browser', label: 'Browser', icon: <IconGlobe /> },
  { kind: 'note', label: 'Note', icon: <IconNote /> },
  { kind: 'app', label: 'App', icon: <IconGrid /> },
  { kind: 'widget', label: 'Widget', icon: <IconCode /> },
  { kind: 'folder', label: 'Folder', icon: <IconFolder /> },
  { kind: 'board', label: 'Board', icon: <IconBoard /> }
]

/** Left dock: + to add a browser, then an icon per open surface. Click to bring it forward at real size. */
export function Sidebar({ onCreateSurface, onRequestRestore, animating = {} }: Props): JSX.Element {
  const surfaces = useDesktop((s) => s.surfaces)
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const plusRef = useRef<HTMLButtonElement>(null)
  const launcherCloseTimer = useRef<number | null>(null)
  const tooltipCloseTimer = useRef<number | null>(null)
  const [launcher, setLauncher] = useState<LauncherState | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
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
    if (!launcher) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeLauncher()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [launcher])

  useEffect(() => {
    return () => {
      if (launcherCloseTimer.current != null) window.clearTimeout(launcherCloseTimer.current)
      if (tooltipCloseTimer.current != null) window.clearTimeout(tooltipCloseTimer.current)
    }
  }, [])

  const closeLauncher = (): void => {
    if (!launcher || launcher.closing) return
    if (launcherCloseTimer.current != null) window.clearTimeout(launcherCloseTimer.current)
    setLauncher((cur) => (cur ? { ...cur, closing: true } : cur))
    launcherCloseTimer.current = window.setTimeout(() => {
      setLauncher(null)
      launcherCloseTimer.current = null
    }, 170)
  }

  const toggleLauncher = (): void => {
    if (launcher && !launcher.closing) {
      closeLauncher()
      return
    }
    if (launcherCloseTimer.current != null) {
      window.clearTimeout(launcherCloseTimer.current)
      launcherCloseTimer.current = null
    }
    const r = plusRef.current?.getBoundingClientRect()
    setLauncher({ left: Math.round((r?.right ?? 52) + 10), top: Math.round(r?.top ?? 44) })
  }

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

  const launcherOverlay =
    launcher &&
    createPortal(
      <div className={`surface-launcher-backdrop${launcher.closing ? ' closing' : ''}`} onPointerDown={closeLauncher}>
        <div
          className={`surface-launcher${launcher.closing ? ' closing' : ''}`}
          style={{ left: launcher.left, top: launcher.top }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {LAUNCHER_ITEMS.map((it) => (
            <button
              key={it.kind}
              className="surface-launcher-item"
              onClick={() => {
                onCreateSurface(it.kind)
                closeLauncher()
              }}
            >
              <span className="surface-launcher-icon">{it.icon}</span>
              <span className="surface-launcher-label">{it.label}</span>
            </button>
          ))}
          <div className="surface-launcher-hint">
            <IconSparkle size={13} />
            <span>Agents can fill apps and widgets</span>
          </div>
        </div>
      </div>,
      document.body
    )
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
      <button
        ref={plusRef}
        className={`sidebar-btn${launcher ? ' active' : ''}`}
        aria-label="Create surface"
        onClick={toggleLauncher}
      >
        <IconPlus />
      </button>
      {launcherOverlay}
      {tooltipOverlay}
      {surfaces.length > 0 && <div className="sidebar-sep" />}
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
    </div>
  )
}
