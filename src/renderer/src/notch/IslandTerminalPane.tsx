import './island.css'
import { useState } from 'react'

// The DEBUG terminal view is a one-line handoff: NO embedded emulator (it stripped ANSI and garbled TUIs),
// just an "Open in Terminal" button that attaches a real macOS Terminal window to the agent's live tmux
// window — which renders the TUI correctly and is scrollable. See openTerminalExternal in src/main/index.ts.
export function IslandTerminalPane({
  terminalId,
  title,
  status,
  onClose
}: {
  terminalId: string
  title: string
  status: string
  onClose?: () => void
}): JSX.Element {
  const [launchErr, setLaunchErr] = useState<string | null>(null)

  const openInTerminal = (): void => {
    setLaunchErr(null)
    Promise.resolve(window.agentOS?.terminalOpenExternal?.(terminalId) ?? { ok: false, error: 'unavailable' })
      .then((r) => {
        if (!r?.ok) setLaunchErr(r?.error || 'could not open Terminal')
      })
      .catch((e) => setLaunchErr(String(e?.message || e)))
  }

  return (
    <div className="isl-terminal-debug" data-status={status || 'unknown'}>
      <div className="isl-terminal-head">
        <span className="isl-debug-flag">DEBUG</span>
        <span className="isl-terminal-title">{title}</span>
        <button
          type="button"
          className="isl-term-external"
          onClick={openInTerminal}
          title="Open this terminal in a macOS Terminal window (scrollable, interactive)"
        >
          Open in Terminal
        </button>
        {launchErr ? (
          <span className="isl-terminal-status isl-term-err" title={launchErr}>
            {launchErr}
          </span>
        ) : (
          <span className="isl-terminal-status">{status || 'unknown'}</span>
        )}
        {onClose && (
          <button type="button" className="isl-term-close" onClick={onClose} title="Close terminal" aria-label="Close terminal">
            <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

export default IslandTerminalPane
