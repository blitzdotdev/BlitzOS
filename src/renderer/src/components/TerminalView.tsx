import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Surface } from '../types'
import { subscribeTerminal } from '../terminalStream'
import { useDesktop } from '../store'

// The terminal surface: a real xterm.js terminal bound to a terminal id. It renders the live tmux
// %output stream (routed via terminalStream) and sends keystrokes/resize back to the terminal over
// window.agentOS (preload IPC on Electron, POST on the server) — the same renderer↔backend pattern
// as sendState, mirrored for terminals. The terminal itself lives in tmux (survives restarts); this
// is just the viewport.
type TerminalApi = {
  terminalRead?: (id: string) => Promise<string> | string
  terminalInput?: (id: string, data: string) => void
  terminalResize?: (id: string, cols: number, rows: number) => void
  terminalList?: () => Promise<unknown[]>
  terminalStop?: (id: string) => void
  terminalRestart?: (id: string) => void
  onAction?: (cb: (a: { type?: string; id?: string }) => void) => (() => void) | undefined
}
const tapi = (): TerminalApi => (window.agentOS as unknown as TerminalApi) || {}

type TerminalMeta = {
  id: string
  kind: string
  title?: string
  status?: string
}

export function TerminalView({ surface }: { surface: Surface }): JSX.Element {
  const id = String(surface.props?.terminalId || '')
  const hostRef = useRef<HTMLDivElement | null>(null)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const [meta, setMeta] = useState<TerminalMeta | null>(null)

  const refreshMeta = useCallback(() => {
    if (!id) {
      setMeta(null)
      return
    }
    Promise.resolve(tapi().terminalList?.() ?? [])
      .then((list) => {
        if (!Array.isArray(list)) return
        const match = (list as TerminalMeta[]).find((t) => String(t.id) === id) || null
        setMeta(match)
      })
      .catch(() => {})
  }, [id])

  useEffect(() => {
    refreshMeta()
    const off = tapi().onAction?.((a) => {
      if (a?.type && a.type.indexOf('terminal-') === 0 && (!a.id || String(a.id) === id)) refreshMeta()
    })
    return () => off?.()
  }, [id, refreshMeta])

  useEffect(() => {
    const el = hostRef.current
    if (!el || !id) return
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: { background: '#0b0c0e', foreground: '#e6e6e6', cursor: '#f4673b' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try { fit.fit() } catch { /* container not laid out yet */ }

    let disposed = false
    // Repaint the current screen+history once (the terminal may already be running), then go live.
    Promise.resolve(tapi().terminalRead?.(id)).then((scroll) => {
      if (disposed) return
      if (scroll) term.write(scroll)
    }).catch(() => {})
    const unsub = subscribeTerminal(
      id,
      (data) => term.write(data),
      ({ exitCode }) => term.write(`\r\n\x1b[2m[terminal exited${exitCode != null ? ' (' + exitCode + ')' : ''}]\x1b[0m\r\n`)
    )

    // keystrokes → the terminal
    const onData = term.onData((data) => tapi().terminalInput?.(id, data))

    // keep the PTY sized to the visible terminal
    const doFit = () => {
      try { fit.fit(); tapi().terminalResize?.(id, term.cols, term.rows) } catch { /* ignore */ }
    }
    const ro = new ResizeObserver(() => doFit())
    ro.observe(el)
    doFit()

    return () => {
      disposed = true
      ro.disconnect()
      onData.dispose()
      unsub()
      term.dispose()
    }
  }, [id])

  const isAgent = meta?.kind === 'agent'
  const isRunning = meta?.status === 'running'

  // stopPropagation so typing/clicking in the terminal doesn't pan the canvas or trigger surface drag.
  return (
    <div
      className="terminal-view-wrap"
      data-surface-scroll="true"
      onPointerDown={(e) => {
        e.stopPropagation()
        focusSurface(surface.id)
      }}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* ! DEBUG: temporary maintainer control for manually stopping/resuming agent terminals. */}
      {isAgent && (
        <div className="terminal-agent-controls" onPointerDown={(e) => e.stopPropagation()}>
          <span className="terminal-agent-debug-tag">DEBUG</span>
          <span className={`terminal-agent-status ${isRunning ? 'running' : 'stopped'}`}>
            Agent {meta?.status || 'unknown'}
          </span>
          <button
            className={`terminal-agent-btn ${isRunning ? 'danger' : ''}`}
            onClick={() => {
              if (isRunning) {
                tapi().terminalStop?.(id)
                setMeta((cur) => (cur ? { ...cur, status: 'stopped' } : cur))
              } else {
                tapi().terminalRestart?.(id)
                setMeta((cur) => (cur ? { ...cur, status: 'running' } : cur))
              }
              window.setTimeout(refreshMeta, 350)
            }}
          >
            {isRunning ? 'Stop agent' : 'Resume agent'}
          </button>
        </div>
      )}
      <div
        ref={hostRef}
        className="terminal-view session-terminal"
      />
    </div>
  )
}
