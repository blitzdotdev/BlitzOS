import { useRef } from 'react'
import { WinItem } from '../types'
import { useDesktop } from '../store'

interface Props {
  win: WinItem
}

/** A window-plane item: chrome + a live <webview>. Drag by the title bar; focus raises z. */
export function WindowFrame({ win }: Props): JSX.Element {
  const moveWindow = useDesktop((s) => s.moveWindow)
  const focusWindow = useDesktop((s) => s.focusWindow)
  const closeWindow = useDesktop((s) => s.closeWindow)
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)

  function onBarPointerDown(e: React.PointerEvent): void {
    e.stopPropagation()
    focusWindow(win.id)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startY: e.clientY, origX: win.x, origY: win.y }
  }

  function onBarPointerMove(e: React.PointerEvent): void {
    if (!drag.current) return
    const scale = useDesktop.getState().transform.scale
    const dx = (e.clientX - drag.current.startX) / scale
    const dy = (e.clientY - drag.current.startY) / scale
    moveWindow(win.id, drag.current.origX + dx, drag.current.origY + dy)
  }

  function onBarPointerUp(e: React.PointerEvent): void {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    drag.current = null
  }

  return (
    <div
      className="window"
      style={{ left: win.x, top: win.y, width: win.w, height: win.h, zIndex: win.z }}
      onPointerDown={() => focusWindow(win.id)}
    >
      <div
        className="window-bar"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={onBarPointerUp}
      >
        <span className="window-title">{win.title}</span>
        <button
          className="window-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => closeWindow(win.id)}
        >
          ×
        </button>
      </div>
      <div className="window-body">
        <webview
          src={win.url}
          partition="persist:agentos"
          style={{ width: '100%', height: '100%', border: 'none', display: 'inline-flex' }}
        />
      </div>
    </div>
  )
}
