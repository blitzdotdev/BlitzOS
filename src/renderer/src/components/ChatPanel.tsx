import { useEffect, useRef } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'

interface ChatMsg {
  role: 'user' | 'agent'
  text: string
}

/**
 * In-canvas chat: message the OS directly. The user's line is appended locally AND
 * sent to the agent's moment stream (window.agentOS.sendMessage -> a trigger:'message'
 * moment), so a watching agent reads it and can reply via the `say` tool (which
 * arrives as an os:action 'chat' and is appended here by App's onAction handler).
 */
export function ChatPanel({ surface }: { surface: Surface }): JSX.Element {
  const update = useDesktop((s) => s.updateSurfaceProps)
  const msgs = (surface.props?.messages as ChatMsg[]) ?? []
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [msgs.length])

  function send(e: React.FormEvent): void {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement
    const input = form.elements.namedItem('msg') as HTMLInputElement
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    update(surface.id, { messages: [...msgs, { role: 'user', text }].slice(-200) })
    window.agentOS?.sendMessage?.(text)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--surface)', color: 'var(--text)' }}>
      <div
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, userSelect: 'text', WebkitUserSelect: 'text' }}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {msgs.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
            Message the OS — it sees your canvas and can open, arrange, and build things for you. Connect an AI first
            (toolbar → Connect AI) so something is listening.
          </div>
        )}
        {msgs.map((m, i) => (
          <div
            key={i}
            style={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '88%',
              padding: '7px 11px',
              borderRadius: 12,
              fontSize: 13,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: m.role === 'user' ? 'var(--accent)' : 'var(--surface-raised)',
              color: m.role === 'user' ? 'var(--paper-coral-ink)' : 'var(--text)',
              boxShadow: m.role === 'user' ? 'none' : 'inset 0 0 0 1px var(--hairline)'
            }}
          >
            {m.text}
          </div>
        ))}
        {msgs.length > 0 && msgs[msgs.length - 1].role === 'user' && (
          <div
            style={{
              alignSelf: 'flex-start',
              padding: '7px 11px',
              borderRadius: 12,
              fontSize: 13,
              background: 'var(--surface-raised)',
              color: 'var(--text-muted)',
              boxShadow: 'inset 0 0 0 1px var(--hairline)'
            }}
          >
            working… <span style={{ opacity: 0.7 }}>(see the Agent activity panel)</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
      <form
        onSubmit={send}
        onPointerDown={(e) => e.stopPropagation()}
        style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid var(--hairline)' }}
      >
        <input
          name="msg"
          autoComplete="off"
          placeholder="Message the agent…"
          spellCheck={false}
          style={{
            flex: 1,
            background: 'var(--canvas)',
            color: 'var(--text)',
            border: '1px solid var(--hairline)',
            borderRadius: 8,
            padding: '7px 10px',
            fontSize: 13,
            outline: 'none'
          }}
        />
        <button
          type="submit"
          className="btn primary"
          style={{ borderRadius: 8, padding: '0 14px' }}
        >
          Send
        </button>
      </form>
    </div>
  )
}
