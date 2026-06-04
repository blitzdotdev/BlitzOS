import { useRef } from 'react'
import { IntegrationStatus, WIDGET_W, WIDGET_H } from '../types'
import { useDesktop } from '../store'

interface Props {
  integration: IntegrationStatus
  onConnect: (id: string) => void
}

export function IntegrationWidget({ integration, onConnect }: Props): JSX.Element {
  const pos = useDesktop((s) => s.positions[integration.id]) ?? { x: 0, y: 0 }
  const setPos = useDesktop((s) => s.setPos)
  const commitPos = useDesktop((s) => s.commitPos)
  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)

  function onHeaderDown(e: React.PointerEvent): void {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
  }
  function onHeaderMove(e: React.PointerEvent): void {
    if (!drag.current) return
    const scale = useDesktop.getState().transform.scale
    setPos(
      integration.id,
      drag.current.origX + (e.clientX - drag.current.startX) / scale,
      drag.current.origY + (e.clientY - drag.current.startY) / scale
    )
  }
  function onHeaderUp(e: React.PointerEvent): void {
    if (!drag.current) return
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    commitPos(integration.id, drag.current.origX, drag.current.origY)
    drag.current = null
  }

  async function disconnect(): Promise<void> {
    await window.agentOS?.integrations.disconnect(integration.id)
  }

  return (
    <div
      className="iwidget"
      style={{ left: pos.x, top: pos.y, width: WIDGET_W, height: WIDGET_H }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        className="iwidget-bar"
        style={{ background: integration.color }}
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
      >
        <span className="iwidget-name">{integration.name}</span>
        <span className={integration.connected ? 'dot dot-on' : 'dot dot-off'} />
      </div>

      <div className="iwidget-body">
        {integration.connected ? (
          <>
            <div className="iwidget-status connected">Connected</div>
            <div className="iwidget-label" title={integration.label ?? ''}>
              {integration.label}
            </div>
            <button className="iwidget-btn ghost" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            <div className="iwidget-status">{integration.configured ? 'Disconnected' : 'Setup needed'}</div>
            <button className="iwidget-btn" onClick={() => onConnect(integration.id)}>
              {integration.configured ? 'Sign in' : 'Set up'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
