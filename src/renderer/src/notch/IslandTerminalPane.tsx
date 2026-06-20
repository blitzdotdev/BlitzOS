import './island.css'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { subscribeTerminal } from '../terminalStream'

const terminalTheme = {
  background: '#050505',
  foreground: '#f4f4f5',
  cursor: '#ffd84d',
  selectionBackground: '#ffffff26',
  black: '#0a0a0a',
  red: '#ff6b6b',
  green: '#7ddf7a',
  yellow: '#ffd84d',
  blue: '#58a6ff',
  magenta: '#f778ba',
  cyan: '#76e4f7',
  white: '#f4f4f5',
  brightBlack: '#737373',
  brightRed: '#ff8787',
  brightGreen: '#9af59b',
  brightYellow: '#ffe680',
  brightBlue: '#7dbbff',
  brightMagenta: '#ff99cc',
  brightCyan: '#9bf2ff',
  brightWhite: '#ffffff'
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
  const mountRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exitCode, setExitCode] = useState<number | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    setLoading(true)
    setError(null)
    setExitCode(null)

    const term = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 10,
      lineHeight: 1.18,
      rows: 10,
      scrollback: 5000,
      theme: terminalTheme
    })
    const fit = new FitAddon()
    let disposed = false
    term.loadAddon(fit)
    term.open(mount)

    const fitTerminal = (): void => {
      try {
        fit.fit()
      } catch {
        /* fit can fail while the island is animating; the next observer tick fixes it */
      }
    }
    requestAnimationFrame(fitTerminal)

    const resizeObserver = new ResizeObserver(() => fitTerminal())
    resizeObserver.observe(mount)

    let unsubscribe: (() => void) | null = null
    const startSubscription = (): void => {
      if (disposed || unsubscribe) return
      unsubscribe = subscribeTerminal(
        terminalId,
        (data) => {
          term.write(data)
        },
        ({ exitCode: code }) => {
          setExitCode(code)
        }
      )
    }

    Promise.resolve(window.agentOS?.terminalRead?.(terminalId) ?? '')
      .then((scrollback) => {
        if (disposed) return
        if (scrollback) term.write(scrollback)
        setLoading(false)
        requestAnimationFrame(fitTerminal)
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
      resizeObserver.disconnect()
      unsubscribe?.()
      term.dispose()
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
      <div className="isl-terminal-mount" ref={mountRef} aria-label={`Terminal ${terminalId}`} />
      {(loading || error) && <div className="isl-terminal-overlay">{error || 'Loading terminal'}</div>}
    </div>
  )
}

export default IslandTerminalPane
