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
    update(surface.id, { messages: [...msgs, { role: 'user', text }] })
    window.agentOS?.sendMessage?.(text)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0e1116', color: '#e6edf3' }}>
      <div
        style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        {msgs.length === 0 && (
          <div style={{ color: '#7d8590', fontSize: 12, lineHeight: 1.5 }}>
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
              background: m.role === 'user' ? '#2563eb' : '#161b22',
              color: m.role === 'user' ? '#fff' : '#e6edf3',
              border: m.role === 'user' ? 'none' : '1px solid #21262d'
            }}
          >
            {m.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form
        onSubmit={send}
        onPointerDown={(e) => e.stopPropagation()}
        style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #21262d' }}
      >
        <input
          name="msg"
          autoComplete="off"
          placeholder="Message the agent…"
          spellCheck={false}
          style={{
            flex: 1,
            background: '#0d1117',
            color: '#e6edf3',
            border: '1px solid #30363d',
            borderRadius: 8,
            padding: '7px 10px',
            fontSize: 13,
            outline: 'none'
          }}
        />
        <button
          type="submit"
          style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', fontSize: 13, cursor: 'pointer' }}
        >
          Send
        </button>
      </form>
    </div>
  )
}
