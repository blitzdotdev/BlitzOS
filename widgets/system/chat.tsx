import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bot, Circle, Loader2, MessageSquarePlus, Pencil, RotateCcw, Send, Sparkles, Square, TriangleAlert } from 'lucide-react'

const CHAT_RENDERER_VERSION = 'chat-actions-v6'

type ChatMessage = { role: 'user' | 'agent' | string; text: string; ts?: number; ref?: Record<string, unknown> }
type ChatSession = { id: string; title?: string; status?: ChatStatus; updatedAt?: number; lastMessagePreview?: string; unread?: boolean }
type ChatStatus = 'idle' | 'starting' | 'working' | 'watching' | 'waiting' | 'stopped' | 'error'
type ChatProps = {
  sessions?: ChatSession[]
  threads?: Record<string, ChatMessage[]>
  status?: Record<string, ChatStatus>
  activeAgentId?: string
  messages?: ChatMessage[]
  agentId?: string
  sessionId?: string
}

type BlitzApi = {
  props?: () => ChatProps
  onProps?: (cb: (props: ChatProps) => void) => void
  sendMessage?: (text: string, sessionId?: string) => Promise<unknown>
  chat?: (op: string, args?: Record<string, unknown>) => Promise<unknown>
  focusAnnotation?: (ref: Record<string, unknown>) => void
}

declare global {
  interface Window {
    blitz?: BlitzApi
  }
}

const DEFAULT_SESSION: ChatSession = { id: '0', title: 'Main', status: 'idle' }

function normalizeProps(raw: ChatProps | undefined): Required<Pick<ChatProps, 'sessions' | 'threads' | 'status'>> & { activeAgentId: string } {
  const base = raw || {}
  const active = String(base.activeAgentId || base.sessionId || base.agentId || '0')
  const sessions = Array.isArray(base.sessions) && base.sessions.length ? base.sessions.map((s) => ({ ...s, id: String(s.id) })) : [{ ...DEFAULT_SESSION, id: active }]
  const threads = base.threads && typeof base.threads === 'object' ? { ...base.threads } : {}
  if (Array.isArray(base.messages)) threads[active] = base.messages
  if (!threads['0']) threads['0'] = []
  const status = base.status && typeof base.status === 'object' ? { ...base.status } : {}
  for (const s of sessions) if (!status[s.id]) status[s.id] = (s.status as ChatStatus) || 'idle'
  return {
    sessions,
    threads,
    status,
    activeAgentId: active
  }
}

function isActiveStatus(status: ChatStatus | string | undefined): boolean {
  return status === 'working' || status === 'starting' || status === 'waiting'
}

function isWarmupStatus(status: ChatStatus | string | undefined): boolean {
  return status === 'starting'
}

function statusLabel(status: ChatStatus | string | undefined, hasMessages = true): string {
  if (!hasMessages && isWarmupStatus(status)) return 'Agent is warming up'
  if (status === 'starting') return 'Warming up'
  if (status === 'working') return 'Agent is working'
  if (status === 'watching') return 'Agent is watching'
  if (status === 'waiting') return 'Waiting for response'
  if (status === 'stopped') return 'Stopped'
  if (status === 'error') return 'Needs attention'
  return 'Ready'
}

function statusIcon(status: ChatStatus | string | undefined): React.ReactNode {
  if (isActiveStatus(status)) return <Loader2 size={13} className="spin" />
  if (status === 'watching') return <span className="watching-light" aria-hidden="true" />
  if (status === 'stopped') return <Square size={12} />
  if (status === 'error') return <TriangleAlert size={13} />
  return <Circle size={10} />
}

function emptyStateCopy(status: ChatStatus | string | undefined): { icon: React.ReactNode; title: string; body: string } {
  if (status === 'starting') {
    return {
      icon: <Loader2 size={22} className="spin" />,
      title: 'Agent is warming up',
      body: 'Getting its terminal and context ready. You can type while it starts.'
    }
  }
  if (status === 'working' || status === 'waiting') {
    return {
      icon: <Loader2 size={22} className="spin" />,
      title: 'Agent is working',
      body: 'It is using Blitz and will reply here when it has something to share.'
    }
  }
  if (status === 'watching') {
    return {
      icon: <span className="watching-light large" aria-hidden="true" />,
      title: 'Agent is watching',
      body: 'It is connected and listening for workspace or chat changes.'
    }
  }
  return {
    icon: <Sparkles size={22} />,
    title: 'Ask the agent anything.',
    body: 'It can work in Blitz, create surfaces, use terminals, and reply here.'
  }
}

type MessagePart = { kind: 'md'; value: string } | { kind: 'svg'; value: string } | { kind: 'card'; value: Record<string, unknown> }

function parseParts(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  const re = /```blitz-ui\s*([\s\S]*?)```|(<svg[\s\S]*?<\/svg>)/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ kind: 'md', value: text.slice(last, m.index) })
    if (m[1] != null) {
      try {
        parts.push({ kind: 'card', value: JSON.parse(m[1].trim()) })
      } catch {
        parts.push({ kind: 'md', value: m[1] })
      }
    } else {
      parts.push({ kind: 'svg', value: m[2] })
    }
    last = re.lastIndex
  }
  if (last < text.length) parts.push({ kind: 'md', value: text.slice(last) })
  return parts
}

function MessageMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        img: ({ src, alt }) => <img src={src || ''} alt={alt || ''} />
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function UiCard({ spec, onAnswer }: { spec: Record<string, unknown>; onAnswer: (text: string) => void }): JSX.Element {
  const [chosen, setChosen] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[]>([]) // multi-select: labels checked so far
  const [submitted, setSubmitted] = useState(false)
  const options = Array.isArray(spec.options) ? spec.options : []
  const type = String(spec.type || 'choice')
  if (type === 'status') {
    return (
      <div className="inline-status">
        <Loader2 size={14} className="spin" />
        <span>{String(spec.text || spec.prompt || 'Working...')}</span>
      </div>
    )
  }
  if (type === 'multi') {
    const toggle = (label: string): void => setPicked((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]))
    return (
      <div className={`choice-card multi ${submitted ? 'answered' : ''}`}>
        <div className="choice-question">{String(spec.prompt || spec.question || '')}</div>
        <div className="choice-options multi">
          {options.map((raw, index) => {
            const option = typeof raw === 'string' ? { label: raw } : ((raw || {}) as Record<string, unknown>)
            const label = String(option.label || `Option ${index + 1}`)
            const on = picked.includes(label)
            return (
              <button
                key={`${label}-${index}`}
                type="button"
                className={`choice-option check ${on ? 'on' : ''}`}
                disabled={submitted}
                onClick={() => toggle(label)}
              >
                <span className="check-tick">{on ? '✓' : ''}</span>
                <span className="check-label">
                  {label}
                  {typeof option.sub === 'string' && <small>{option.sub}</small>}
                </span>
              </button>
            )
          })}
        </div>
        <button
          type="button"
          className="multi-continue"
          disabled={submitted || !picked.length}
          onClick={() => {
            setSubmitted(true)
            onAnswer(picked.join(', '))
          }}
        >
          {submitted ? 'Sent' : picked.length ? `Continue (${picked.length})` : 'Select what you use'}
        </button>
      </div>
    )
  }
  return (
    <div className={`choice-card ${chosen ? 'answered' : ''}`}>
      <div className="choice-question">{String(spec.prompt || spec.question || '')}</div>
      <div className={`choice-options ${type === 'grid' ? 'grid' : ''} ${type === 'confirm' ? 'confirm' : ''}`}>
        {options.map((raw, index) => {
          const option = typeof raw === 'string' ? { label: raw } : (raw || {}) as Record<string, unknown>
          const label = String(option.label || `Option ${index + 1}`)
          return (
            <button
              key={`${label}-${index}`}
              type="button"
              className={`choice-option ${chosen === label ? 'chosen' : ''}`}
              disabled={!!chosen}
              onClick={() => {
                setChosen(label)
                onAnswer(label)
              }}
            >
              {typeof option.img === 'string' && <img src={option.img} alt="" />}
              <span>{label}</span>
              {typeof option.sub === 'string' && <small>{option.sub}</small>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function MessageBubble({ message, onAnswer }: { message: ChatMessage; onAnswer: (text: string) => void }): JSX.Element {
  const role = message.role === 'user' ? 'user' : 'agent'
  const hasRef = role === 'user' && message.ref && message.ref.surfaceId
  const parts = useMemo(() => parseParts(String(message.text || '')), [message.text])
  return (
    <div className={`message-row ${role}`}>
      <div
        className={`message-bubble ${hasRef ? 'annotation' : ''}`}
        onClick={() => {
          if (hasRef && message.ref) window.blitz?.focusAnnotation?.(message.ref)
        }}
      >
        {role === 'user' ? (
          <span>{message.text}</span>
        ) : (
          parts.map((part, index) => {
            if (part.kind === 'svg') return <div key={index} className="raw-svg" dangerouslySetInnerHTML={{ __html: part.value }} />
            if (part.kind === 'card') return <UiCard key={index} spec={part.value} onAnswer={onAnswer} />
            return <MessageMarkdown key={index} text={part.value} />
          })
        )}
        {hasRef && <span className="annotation-pin">Show on surface</span>}
      </div>
    </div>
  )
}

export default function ChatHub(): JSX.Element {
  const [props, setProps] = useState(() => normalizeProps(window.blitz?.props?.()))
  const [active, setActive] = useState(props.activeAgentId)
  const [draft, setDraft] = useState('')
  const [isSpawning, setIsSpawning] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [editingTitle, setEditingTitle] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    window.blitz?.onProps?.((next) => {
      const normalized = normalizeProps(next)
      setProps(normalized)
      setActive((cur) => normalized.sessions.some((s) => s.id === cur) ? cur : normalized.activeAgentId || normalized.sessions[0]?.id || '0')
    })
  }, [])

  const activeSession = props.sessions.find((s) => s.id === active) || props.sessions[0] || DEFAULT_SESSION
  const status = props.status[activeSession.id] || activeSession.status || 'idle'
  const messages = props.threads[activeSession.id] || []
  const hasMessages = messages.length > 0
  const emptyCopy = emptyStateCopy(status)

  useEffect(() => {
    if (!atBottom) return
    const el = logRef.current
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [active, messages.length, atBottom])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '42px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 42), 104)}px`
  }, [draft])

  // Switching threads abandons any in-flight rename / pending clear confirmation.
  useEffect(() => { setEditingTitle(false); setConfirmClear(false) }, [active])
  // A pending "Clear context?" confirmation lapses on its own (sandbox blocks window.confirm).
  useEffect(() => {
    if (!confirmClear) return
    const t = setTimeout(() => setConfirmClear(false), 3200)
    return () => clearTimeout(t)
  }, [confirmClear])

  function send(text: string): void {
    const clean = text.trim()
    if (!clean) return
    setDraft('')
    window.blitz?.sendMessage?.(clean, activeSession.id).catch(() => {})
  }

  function newChat(): void {
    setIsSpawning(true)
    window.blitz?.chat?.('new', { focus: false })
      .then((result) => {
        const r = result as { id?: unknown; title?: unknown } | undefined
        if (r?.id != null) setActive(String(r.id))
      })
      .finally(() => setIsSpawning(false))
  }

  // Retitle this thread (host: chat('rename') → osRenameAgent). No-op on empty/unchanged.
  function renameTo(title: string): void {
    setEditingTitle(false)
    const clean = title.trim()
    if (!clean || clean === (activeSession.title || '')) return
    window.blitz?.chat?.('rename', { id: activeSession.id, title: clean }).catch(() => {})
  }

  // "New context" — rotate this agent's session id + restart for a FRESH context (host: chat('clear') →
  // clearAgentContext). Destructive, so two-step: the first click arms it, the second confirms.
  function clearContext(): void {
    if (!confirmClear) { setConfirmClear(true); return }
    setConfirmClear(false)
    window.blitz?.chat?.('clear', { id: activeSession.id }).catch(() => {})
  }

  function onScroll(): void {
    const el = logRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 56)
  }

  return (
    <div className="chat-app" data-version={CHAT_RENDERER_VERSION}>
      <style>{CSS}</style>
      <aside className="chat-sidebar">
        <button className="new-chat" type="button" onClick={newChat} disabled={isSpawning}>
          {isSpawning ? <Loader2 size={16} className="spin" /> : <MessageSquarePlus size={16} />}
          <span>New chat</span>
        </button>
        <div className="thread-list">
          {props.sessions.map((session) => {
            const st = props.status[session.id] || session.status || 'idle'
            const selected = session.id === activeSession.id
            return (
              <button key={session.id} type="button" className={`thread ${selected ? 'selected' : ''}`} onClick={() => setActive(session.id)}>
                <span className={`thread-dot ${st}`} />
                <span className="thread-main">
                  <span className="thread-title">{session.title || `Chat ${session.id}`}</span>
                  <span className="thread-preview">{session.lastMessagePreview || statusLabel(st, !!(props.threads[session.id] || []).length)}</span>
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <div className="title-wrap">
            <Bot size={17} />
            <div>
              {editingTitle ? (
                <input
                  className="title-edit"
                  autoFocus
                  defaultValue={activeSession.title || ''}
                  onBlur={(event) => renameTo(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') { event.preventDefault(); renameTo(event.currentTarget.value) }
                    else if (event.key === 'Escape') { event.preventDefault(); setEditingTitle(false) }
                  }}
                />
              ) : (
                <h1 onDoubleClick={() => setEditingTitle(true)} title="Double-click to rename">{activeSession.title || 'Chat'}</h1>
              )}
              <div className={`status-pill ${status}`}>
                {statusIcon(status)}
                <span>{statusLabel(status, hasMessages)}</span>
              </div>
            </div>
          </div>
          <div className="header-actions">
            <button type="button" className="ghost-action" onClick={() => setEditingTitle(true)} title="Rename this chat">
              <Pencil size={14} />
              <span>Rename</span>
            </button>
            <button type="button" className={`ghost-action ${confirmClear ? 'confirming' : ''}`} onClick={clearContext} title="Start a fresh context for this agent (clears its working memory)">
              <RotateCcw size={14} />
              <span>{confirmClear ? 'Clear context?' : 'New context'}</span>
            </button>
          </div>
        </header>

        <section ref={logRef} className="message-log" onScroll={onScroll}>
          {!hasMessages ? (
            <div className="empty-state">
              {emptyCopy.icon}
              <strong>{emptyCopy.title}</strong>
              <span>{emptyCopy.body}</span>
            </div>
          ) : (
            <>
              {messages.map((message, index) => <MessageBubble key={`${message.ts || index}-${index}`} message={message} onAnswer={send} />)}
              {isActiveStatus(status) && (
                <div className="working-line">
                  <Loader2 size={14} className="spin" />
                  <span>{statusLabel(status, hasMessages)}</span>
                </div>
              )}
              {status === 'watching' && (
                <div className="watching-line">
                  <span className="watching-light" aria-hidden="true" />
                  <span>Agent is watching</span>
                </div>
              )}
            </>
          )}
        </section>

        {!atBottom && (
          <button
            className="jump-latest"
            type="button"
            onClick={() => {
              const el = logRef.current
              if (el) el.scrollTop = el.scrollHeight
              setAtBottom(true)
            }}
          >
            Jump to latest
          </button>
        )}

        <form className="composer" onSubmit={(event) => { event.preventDefault(); send(draft) }}>
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder="Message the agent..."
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send(draft)
              }
            }}
          />
          <button type="submit" disabled={!draft.trim()} aria-label="Send message">
            <Send size={17} />
          </button>
        </form>
      </main>
    </div>
  )
}

const CSS = `
* { box-sizing: border-box; }
html, body, #root {
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
}
body {
  overflow: hidden;
  background: var(--blitz-surface, #fff);
  color: var(--blitz-text, #1f2328);
  font: 13px/1.5 var(--blitz-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif);
  -webkit-font-smoothing: antialiased;
}
.chat-app {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(138px, 168px) minmax(0, 1fr);
  background: var(--blitz-surface, #fff);
}
.chat-sidebar {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 10px;
  border-right: 1px solid var(--blitz-hairline, rgba(0,0,0,.1));
  background: color-mix(in srgb, var(--blitz-surface-2, #f4f4f1) 88%, #fff);
}
.new-chat,
.thread,
.ghost-action,
.composer button,
.jump-latest {
  font: inherit;
  border: 0;
  cursor: pointer;
}
.new-chat {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 42px;
  padding: 0 12px;
  border-radius: 10px;
  background: var(--blitz-surface, #fff);
  color: var(--blitz-text, #1f2328);
  box-shadow: inset 0 0 0 1px var(--blitz-hairline, rgba(0,0,0,.12)), 0 1px 2px rgba(0,0,0,.04);
  font-weight: 700;
}
.new-chat:hover { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--blitz-accent, #eb1d36) 40%, transparent), 0 5px 14px rgba(0,0,0,.08); }
.new-chat:disabled { opacity: .7; cursor: default; }
.thread-list {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.thread {
  width: 100%;
  min-width: 0;
  display: grid;
  grid-template-columns: 9px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  padding: 10px;
  text-align: left;
  color: var(--blitz-text-dim, #75777c);
  background: transparent;
  border-radius: 10px;
}
.thread:hover { background: rgba(0,0,0,.045); }
.thread.selected {
  color: var(--blitz-text, #1f2328);
  background: var(--blitz-surface, #fff);
  box-shadow: 0 1px 2px rgba(0,0,0,.06), inset 0 0 0 1px rgba(0,0,0,.04);
}
.thread-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #b7babf;
}
.thread-dot.working,
.thread-dot.starting,
.thread-dot.waiting,
.thread-dot.watching {
  background: var(--blitz-positive, #25c24a);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--blitz-positive, #25c24a) 16%, transparent);
  animation: breathe 1.25s ease-in-out infinite;
}
.thread-dot.error { background: var(--blitz-danger, #eb1d36); }
.thread-dot.stopped { background: #8d9299; }
.thread-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.thread-title,
.thread-preview {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.thread-title { font-weight: 720; color: inherit; }
.thread-preview { font-size: 11px; color: var(--blitz-text-dim, #7b7f86); }
.chat-main {
  min-width: 0;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--blitz-surface, #fff);
}
.chat-header {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--blitz-hairline, rgba(0,0,0,.1));
}
.title-wrap {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}
.title-wrap h1 {
  margin: 0;
  max-width: 230px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 17px;
  line-height: 1.2;
  letter-spacing: 0;
}
.status-pill {
  margin-top: 4px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--blitz-text-dim, #73777f);
  font-size: 11px;
  font-weight: 650;
}
.status-pill.working,
.status-pill.starting,
.status-pill.waiting,
.status-pill.watching { color: var(--blitz-positive, #1aa33d); }
.status-pill.error { color: var(--blitz-danger, #eb1d36); }
.ghost-action {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 10px;
  color: var(--blitz-text-dim, #73777f);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--blitz-hairline, rgba(0,0,0,.1));
  font-weight: 700;
}
.ghost-action:hover { color: var(--blitz-text, #1f2328); background: rgba(0,0,0,.035); }
.header-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; }
.ghost-action.confirming {
  color: var(--blitz-danger, #eb1d36);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--blitz-danger, #eb1d36) 50%, transparent);
}
.title-edit {
  font: inherit;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.2;
  max-width: 230px;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--blitz-accent, #eb1d36) 50%, transparent);
  border-radius: 8px;
  outline: none;
  color: var(--blitz-text, #1f2328);
  background: var(--blitz-surface, #fff);
}
.title-edit:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--blitz-accent, #eb1d36) 12%, transparent); }
.message-log {
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  padding: 18px 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.empty-state {
  margin: auto;
  width: min(280px, 90%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--blitz-text-dim, #767a82);
  text-align: center;
  line-height: 1.55;
}
.empty-state strong { color: var(--blitz-text, #1f2328); font-size: 15px; }
.message-row { display: flex; width: 100%; }
.message-row.user { justify-content: flex-end; }
.message-bubble {
  max-width: min(88%, 680px);
  padding: 10px 13px;
  border-radius: 15px;
  overflow-wrap: anywhere;
}
.message-row.user .message-bubble {
  color: var(--blitz-accent-ink, #fff);
  background: var(--blitz-accent, #eb1d36);
  border-bottom-right-radius: 5px;
}
.message-row.agent .message-bubble {
  color: var(--blitz-text, #1f2328);
  background: var(--blitz-surface-2, #f4f4f1);
  border: 1px solid var(--blitz-hairline, rgba(0,0,0,.1));
  border-bottom-left-radius: 5px;
}
.message-bubble p { margin: 0 0 8px; }
.message-bubble p:last-child { margin-bottom: 0; }
.message-bubble ul,
.message-bubble ol { margin: 7px 0; padding-left: 18px; }
.message-bubble li { margin: 3px 0; }
.message-bubble code {
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(0,0,0,.07);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.message-bubble pre {
  margin: 8px 0;
  padding: 10px;
  border-radius: 10px;
  overflow: auto;
  background: rgba(0,0,0,.08);
}
.message-bubble pre code { padding: 0; background: transparent; }
.message-bubble a { color: var(--blitz-info, #356fc0); font-weight: 650; }
.message-bubble img,
.raw-svg svg {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 8px 0;
  border-radius: 10px;
}
.annotation { cursor: pointer; }
.annotation-pin {
  display: block;
  margin-top: 5px;
  font-size: 11px;
  opacity: .62;
}
.working-line,
.watching-line,
.inline-status {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--blitz-text-dim, #767a82);
  background: color-mix(in srgb, var(--blitz-surface-2, #f4f4f1) 76%, transparent);
  border: 1px solid var(--blitz-hairline, rgba(0,0,0,.1));
  border-radius: 999px;
  padding: 7px 10px;
  font-weight: 650;
}
.watching-line {
  color: var(--blitz-positive, #1aa33d);
  background: color-mix(in srgb, var(--blitz-positive, #25c24a) 7%, var(--blitz-surface-2, #f4f4f1));
}
.watching-light {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  display: inline-block;
  background: var(--blitz-positive, #25c24a);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--blitz-positive, #25c24a) 16%, transparent);
  animation: pulse-light 1.4s ease-in-out infinite;
}
.watching-light.large {
  width: 22px;
  height: 22px;
  box-shadow: 0 0 0 7px color-mix(in srgb, var(--blitz-positive, #25c24a) 13%, transparent);
}
.choice-card {
  margin: 9px 0 2px;
  overflow: hidden;
  border: 1px solid var(--blitz-hairline, rgba(0,0,0,.1));
  border-radius: 13px;
  background: var(--blitz-surface, #fff);
}
.choice-card.answered { opacity: .76; }
.choice-question { padding: 12px 13px 9px; font-weight: 720; }
.choice-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 12px 12px;
}
.choice-options.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); }
.choice-option {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  border: 1px solid var(--blitz-hairline, rgba(0,0,0,.1));
  border-radius: 10px;
  color: var(--blitz-text, #1f2328);
  background: var(--blitz-surface-2, #f4f4f1);
  text-align: left;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
.choice-options.confirm .choice-option:first-child {
  color: var(--blitz-accent-ink, #fff);
  background: var(--blitz-accent, #eb1d36);
}
.choice-option:hover:not(:disabled) { border-color: color-mix(in srgb, var(--blitz-accent, #eb1d36) 45%, transparent); }
.choice-option:disabled { cursor: default; }
.choice-option.chosen { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--blitz-accent, #eb1d36) 55%, transparent); }
.choice-option small { color: var(--blitz-text-dim, #767a82); font-weight: 500; }
.choice-option img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 8px; }
/* multi-select: a vertical checklist + one Continue button (select all that apply) */
.choice-options.multi { flex-direction: column; gap: 6px; }
.choice-option.check { flex-direction: row; align-items: center; gap: 9px; width: 100%; }
.choice-option.check .check-tick {
  flex: 0 0 auto; width: 18px; height: 18px; display: grid; place-items: center;
  border: 1.5px solid var(--blitz-hairline, rgba(0,0,0,.25)); border-radius: 6px;
  font-size: 12px; line-height: 1; color: var(--blitz-accent-ink, #fff);
}
.choice-option.check.on .check-tick { background: var(--blitz-accent, #eb1d36); border-color: var(--blitz-accent, #eb1d36); }
.choice-option.check.on { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--blitz-accent, #eb1d36) 55%, transparent); }
.choice-option.check .check-label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.multi-continue {
  margin: 0 12px 12px; padding: 9px 14px; width: calc(100% - 24px);
  border: none; border-radius: 10px; font: inherit; font-weight: 720; cursor: pointer;
  color: var(--blitz-accent-ink, #fff); background: var(--blitz-accent, #eb1d36);
}
.multi-continue:disabled { opacity: .5; cursor: default; }
.jump-latest {
  position: absolute;
  right: 18px;
  bottom: 78px;
  z-index: 2;
  padding: 7px 11px;
  border-radius: 999px;
  color: var(--blitz-text, #1f2328);
  background: color-mix(in srgb, var(--blitz-surface, #fff) 88%, transparent);
  box-shadow: 0 10px 24px rgba(0,0,0,.12), inset 0 0 0 1px var(--blitz-hairline, rgba(0,0,0,.1));
  backdrop-filter: blur(10px);
  font-weight: 720;
}
.composer {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 44px;
  align-items: end;
  gap: 10px;
  padding: 12px 16px 14px;
  border-top: 1px solid var(--blitz-hairline, rgba(0,0,0,.1));
  background: var(--blitz-surface, #fff);
}
.composer textarea {
  width: 100%;
  height: 42px;
  min-height: 42px;
  max-height: 104px;
  resize: none;
  overflow-y: auto;
  padding: 11px 13px;
  border: 1px solid var(--blitz-hairline, rgba(0,0,0,.12));
  border-radius: 13px;
  outline: none;
  color: var(--blitz-text, #1f2328);
  background: var(--blitz-surface, #fff);
  font: inherit;
}
.composer textarea:focus {
  border-color: color-mix(in srgb, var(--blitz-accent, #eb1d36) 48%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--blitz-accent, #eb1d36) 12%, transparent);
}
.composer button {
  width: 44px;
  height: 42px;
  align-self: end;
  display: grid;
  place-items: center;
  border-radius: 13px;
  color: var(--blitz-accent-ink, #fff);
  background: var(--blitz-accent, #eb1d36);
}
.composer button:disabled {
  cursor: default;
  opacity: .38;
}
.spin { animation: spin .85s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes breathe { 0%, 100% { transform: scale(.9); opacity: .72; } 50% { transform: scale(1.08); opacity: 1; } }
@keyframes pulse-light { 0%, 100% { transform: scale(.86); opacity: .66; } 50% { transform: scale(1); opacity: 1; } }
@media (max-width: 520px) {
  .chat-app { grid-template-columns: 118px minmax(0, 1fr); }
  .chat-sidebar { padding: 10px 7px; }
  .ghost-action span { display: none; }
  .message-bubble { max-width: 94%; }
}
`
