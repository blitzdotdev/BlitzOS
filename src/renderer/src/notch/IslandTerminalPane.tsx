import './island.css'
import { useEffect, useRef, useState } from 'react'
import { subscribeTerminal } from '../terminalStream'

const MAX_LOG_CHARS = 220_000
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[PX^_][\s\S]*?(?:\x1B\\|\x07))/g

function toVisibleTerminalText(chunk: string): string {
  return chunk
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

function trimLog(text: string): string {
  return text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text
}

export function IslandTerminalPane({
  terminalId,
  title,
  status
}: {
  terminalId: string
  title: string
  status: string
}): JSX.Element {
  const logRef = useRef<HTMLPreElement>(null)
  const [logText, setLogText] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false

    const scrollToBottom = (): void => {
      requestAnimationFrame(() => {
        const el = logRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    }
    const appendLog = (raw: string): void => {
      const el = logRef.current
      const stickToBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 28
      const visible = toVisibleTerminalText(raw)
      if (!visible) return
      setLogText((prev) => trimLog(prev + visible))
      if (stickToBottom) scrollToBottom()
    }

    setLoading(true)
    setError(null)
    setExitCode(null)
    setLogText('')

    let unsubscribe: (() => void) | null = null
    const startSubscription = (): void => {
      if (disposed || unsubscribe) return
      unsubscribe = subscribeTerminal(
        terminalId,
        appendLog,
        ({ exitCode: code }) => {
          setExitCode(code)
        }
      )
    }

    Promise.resolve(window.agentOS?.terminalRead?.(terminalId) ?? '')
      .then((scrollback) => {
        if (disposed) return
        setLogText(trimLog(toVisibleTerminalText(scrollback || '')))
        setLoading(false)
        scrollToBottom()
        startSubscription()
      })
      .catch(() => {
        if (disposed) return
        setLoading(false)
        setError('Terminal unavailable')
        startSubscription()
      })

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [terminalId])

  const shownStatus = exitCode == null ? status : `exited ${exitCode}`

  return (
    <div className="isl-terminal-debug" data-status={status || 'unknown'}>
      <div className="isl-terminal-head">
        <span className="isl-debug-flag">DEBUG</span>
        <span className="isl-terminal-title">{title}</span>
        <span className="isl-terminal-status">{shownStatus || 'unknown'}</span>
      </div>
      <pre
        className="isl-terminal-log"
        ref={logRef}
        aria-label={`Terminal ${terminalId} scrollback`}
        role="region"
        tabIndex={0}
        onWheel={(e) => e.stopPropagation()}
      >
        {logText || (loading ? '' : 'No terminal output yet')}
      </pre>
      {(loading || error) && <div className="isl-terminal-overlay">{error || 'Loading terminal'}</div>}
    </div>
  )
}

export default IslandTerminalPane
