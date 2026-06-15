import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconChat, IconCode, IconFolder, IconGlobe, IconNote, IconPlus, IconSparkle } from './Icons'

export type SurfaceLauncherKind = 'browser' | 'note' | 'chat' | 'widget' | 'folder' | 'board'
type AnimationSourceRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>
type LauncherPlacement = 'toolbar' | 'sidebar'

type LauncherState = {
  left: number
  top: number
  placement: LauncherPlacement
  closing?: boolean
}

export type SurfaceLauncherItem = {
  kind: SurfaceLauncherKind
  label: string
  icon: ReactNode
}

export const SURFACE_LAUNCHER_ITEMS: SurfaceLauncherItem[] = [
  { kind: 'browser', label: 'Browser', icon: <IconGlobe /> },
  { kind: 'note', label: 'Note', icon: <IconNote /> },
  { kind: 'chat', label: 'Chat', icon: <IconChat /> },
  { kind: 'widget', label: 'Widget', icon: <IconCode /> },
  { kind: 'folder', label: 'Folder', icon: <IconFolder /> }
  // Board is being slowly deprecated from primary creation UI. Keep SurfaceLauncherKind/backend support
  // for existing boards and non-primary flows, but do not expose it in the toolbar/sidebar or Option radial menu.
  // { kind: 'board', label: 'Board', icon: <IconBoard /> }
]

interface Props {
  onCreateSurface: (kind: SurfaceLauncherKind, source?: AnimationSourceRect | null) => void
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>
  label?: string | null
}

export function SurfaceLauncherButton({ onCreateSurface, buttonProps, label = 'Create' }: Props): JSX.Element {
  const { className, onClick, ...restButtonProps } = buttonProps ?? {}
  const buttonRef = useRef<HTMLButtonElement>(null)
  const launcherRef = useRef<HTMLDivElement>(null)
  const launcherCloseTimer = useRef<number | null>(null)
  const [launcher, setLauncher] = useState<LauncherState | null>(null)

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
    }
  }, [])

  const positionLauncher = (menuWidth: number, menuHeight: number): LauncherState => {
    const r = buttonRef.current?.getBoundingClientRect()
    const sidebar = buttonRef.current?.closest('.sidebar') as HTMLElement | null
    const gap = 14
    if (sidebar && r) {
      const left = Math.max(76, Math.min(window.innerWidth - menuWidth - 12, Math.round(r.right + gap)))
      const top = Math.max(44, Math.min(window.innerHeight - menuHeight - 12, Math.round(r.top + r.height / 2 - menuHeight / 2)))
      return { left, top, placement: 'sidebar' }
    }

    const toolbarShell = buttonRef.current?.closest('.toolbar-shell') as HTMLElement | null
    const toolbarTop = toolbarShell?.getBoundingClientRect().top ?? r?.top
    const left = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, Math.round((r?.left ?? window.innerWidth / 2) + (r?.width ?? 0) / 2 - menuWidth / 2)))
    const top = Math.max(44, Math.round((toolbarTop ?? window.innerHeight - 72) - menuHeight - gap))
    return { left, top, placement: 'toolbar' }
  }

  useLayoutEffect(() => {
    if (!launcher || launcher.closing) return
    const el = launcherRef.current
    if (!el) return
    const next = positionLauncher(el.offsetWidth || 236, el.offsetHeight || 260)
    if (Math.abs(next.left - launcher.left) > 1 || Math.abs(next.top - launcher.top) > 1) {
      setLauncher((cur) => (cur && !cur.closing ? { ...cur, ...next } : cur))
    }
  }, [launcher])

  useEffect(() => {
    if (!launcher || launcher.closing) return
    const onResize = (): void => {
      const el = launcherRef.current
      const next = positionLauncher(el?.offsetWidth || 236, el?.offsetHeight || 260)
      setLauncher((cur) => (cur && !cur.closing ? { ...cur, ...next } : cur))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [launcher])

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
    setLauncher(positionLauncher(236, 260))
  }

  const launcherOverlay =
    launcher &&
    createPortal(
      <div className={`surface-launcher-backdrop${launcher.closing ? ' closing' : ''}`} onPointerDown={closeLauncher}>
        <div
          ref={launcherRef}
          className={`surface-launcher surface-launcher-${launcher.placement}${launcher.closing ? ' closing' : ''}`}
          style={{ left: launcher.left, top: launcher.top }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {SURFACE_LAUNCHER_ITEMS.map((it) => (
            <button
              key={it.kind}
              className="surface-launcher-item"
              onClick={() => {
                const r = buttonRef.current?.getBoundingClientRect()
                onCreateSurface(it.kind, r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null)
                closeLauncher()
              }}
            >
              <span className="surface-launcher-icon">{it.icon}</span>
              <span className="surface-launcher-label">{it.label}</span>
            </button>
          ))}
          <div className="surface-launcher-hint">
            <IconSparkle size={13} />
            <span>Agents can fill widgets</span>
          </div>
        </div>
      </div>,
      document.body
    )

  return (
    <>
      <button
        {...restButtonProps}
        ref={buttonRef}
        className={['surface-launcher-trigger', className, launcher ? 'active' : null].filter(Boolean).join(' ')}
        onClick={(e) => {
          onClick?.(e)
          if (!e.defaultPrevented) toggleLauncher()
        }}
      >
        <IconPlus size={15} />
        {label !== null && <span className="surface-launcher-trigger-label">{label}</span>}
      </button>
      {launcherOverlay}
    </>
  )
}
