import { useEffect, useRef } from 'react'
import { Surface } from '../types'

interface ActivityEvent {
  at: number
  text: string
  agentId?: string
  tool?: string
}

/**
 * A live, read-only feed of what the connected agent is DOING — its tool calls
 * (open window, read page, reply…) stream in as `os:action 'activity'` events. This
 * exists so that, during the seconds an agent takes to reply, the user can see it is
 * actually working rather than wondering if anything is happening. It is pure
 * observability of the agent's actions — BlitzOS makes no decisions here.
 */
export function ActivityPanel({ surface }: { surface: Surface }): JSX.Element {
  const events = (surface.props?.events as ActivityEvent[]) ?? []
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  const last = events[events.length - 1]
  const working = last && Date.now() - last.at < 8000

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)', color: 'var(--text)' }}>
      <div
        style={{
          padding: '6px 10px',
          fontSize: 11,
          color: 'var(--text-muted)',
          borderBottom: '1px solid var(--hairline)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <span>
          <span style={{ color: working ? 'var(--positive)' : 'var(--text-muted)' }}>●</span> Agent activity
        </span>
        <span style={{ opacity: 0.6 }}>{events.length}</span>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontFamily: 'var(--font-mono)',
          fontSize: 12
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {events.length === 0 && <div style={{ color: 'var(--text-muted)' }}>Waiting for the agent…</div>}
        {events.map((e, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, lineHeight: 1.4 }}>
            <span style={{ color: 'var(--text-tertiary)', flex: '0 0 auto' }}>{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
            <span style={{ wordBreak: 'break-word' }}>{e.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}
