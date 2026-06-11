import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconBoard, IconCode, IconFolder, IconGlobe, IconGrid, IconNote, IconPlus, IconSparkle } from './Icons'

export type SurfaceLauncherKind = 'browser' | 'note' | 'app' | 'widget' | 'folder' | 'board'

type LauncherState = {
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

interface Props {
  onCreateSurface: (kind: SurfaceLauncherKind) => void
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>
}

export function SurfaceLauncherButton({ onCreateSurface, buttonProps }: Props): JSX.Element {
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
    const toolbarShell = buttonRef.current?.closest('.toolbar-shell') as HTMLElement | null
    const toolbarTop = toolbarShell?.getBoundingClientRect().top ?? r?.top
    const gap = 14
    const left = Math.max(12, Math.min(window.innerWidth - menuWidth - 12, Math.round((r?.left ?? window.innerWidth / 2) + (r?.width ?? 0) / 2 - menuWidth / 2)))
    const top = Math.max(44, Math.round((toolbarTop ?? window.innerHeight - 72) - menuHeight - gap))
    return { left, top }
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
          className={`surface-launcher surface-launcher-toolbar${launcher.closing ? ' closing' : ''}`}
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

  return (
    <>
      <button
        {...restButtonProps}
        ref={buttonRef}
        className={[className, launcher ? 'active' : null].filter(Boolean).join(' ') || undefined}
        onClick={(e) => {
          onClick?.(e)
          if (!e.defaultPrevented) toggleLauncher()
        }}
      >
        <IconPlus size={15} /> Create
      </button>
      {launcherOverlay}
    </>
  )
}
