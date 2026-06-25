import './island.css'
import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react'
import type { IslandSession } from './types'

const ARCHIVED_PREVIEW_CHARS = 68

// Debug-only: arm a fake agent problem so the four status surfaces (home card, glance bar, chat chip, inline detail)
// AND the inline error message + Retry/hint can be eyeballed without a real failure. Each value is a real
// classifyApiError cause — it injects the SAME sticky red 'error' + specific detail Claude Code's own error would
// (so "Network error" / "Usage limit reached" etc. show with the right hint), except 'reconnecting' which drives
// the self-healing override. While armed, the next sent message injects it instead of reaching the agent. See
// NotchHost.onSend + os:debug-force-status (main) + errorPresentation (workspace-host).
export type SimStatus = 'off' | 'connection' | 'usage-limit' | 'server-error' | 'rate-limit' | 'auth' | 'crash' | 'reconnecting'
const SIM_OPTIONS: Array<{ value: SimStatus; label: string; title: string }> = [
  { value: 'off', label: 'Off', title: 'Normal — your messages reach the agent' },
  { value: 'connection', label: 'Network', title: 'Network / connection failure → red Error, "Network error"' },
  { value: 'usage-limit', label: 'Usage limit', title: 'Claude usage/session limit ran out → red Error, "Usage limit reached"' },
  { value: 'server-error', label: 'Server 5xx', title: 'Server-side 5xx error → red Error, "Server error"' },
  { value: 'rate-limit', label: 'Rate limit', title: 'Rate limited (429) → red Error, "Rate limited"' },
  { value: 'auth', label: 'Auth', title: 'Not signed in / credits → red Error, "Not signed in"' },
  { value: 'crash', label: 'Crash', title: 'Backend process exited → red Error, "Agent stopped"' },
  { value: 'reconnecting', label: 'Reconnecting', title: 'Self-healing reconnect (blue) — what a transient throttle shows while reviving' }
]

const archivedMessagePreview = (session: IslandSession): string => {
  const text = String(session.lastMessagePreview || '').replace(/\s+/g, ' ').trim()
  if (!text) return 'No messages yet'
  if (text.length <= ARCHIVED_PREVIEW_CHARS) return text
  return `${text.slice(0, ARCHIVED_PREVIEW_CHARS).trimEnd()}...`
}

// ── Open/close-island shortcut rebind (persisted + re-registered in main via the keybind bridge). ──────────────
type KeybindBridge = {
  keybindGet?: () => Promise<{ notchToggle: string }>
  keybindSet?: (accel: string) => Promise<{ ok: boolean; notchToggle: string }>
  keybindSuspend?: (on: boolean) => Promise<{ ok: boolean }>
}
const keybindBridge = (): KeybindBridge | undefined => (window as unknown as { agentOS?: KeybindBridge }).agentOS

const ARROWS: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }
// Build an Electron accelerator (e.g. 'Alt+Space', 'Command+Shift+K') from a key event. Returns null while only
// modifiers are held, and requires a modifier for non-function keys so a rebind can't steal a plain letter globally.
function accelFromEvent(e: RKeyboardEvent): string | null {
  const k = e.key
  if (k === 'Meta' || k === 'Control' || k === 'Alt' || k === 'Shift') return null
  const mods: string[] = []
  if (e.metaKey) mods.push('Command')
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let key: string
  if (ARROWS[k]) key = ARROWS[k]
  else if (k === ' ') key = 'Space'
  else if (k.length === 1) key = k.toUpperCase()
  else key = k.charAt(0).toUpperCase() + k.slice(1) // Enter, Tab, Backspace, Delete, F-keys
  const isFn = /^F\d{1,2}$/.test(key)
  if (!mods.length && !isFn) return null
  return [...mods, key].join('+')
}
// Pretty key caps for display (⌘ ⌥ ⌃ ⇧ + the key).
function accelCaps(accel: string): string[] {
  return accel.split('+').map((p) => {
    if (p === 'Command' || p === 'Cmd' || p === 'Meta' || p === 'Super') return '⌘'
    if (p === 'Control' || p === 'Ctrl') return '⌃'
    if (p === 'Alt' || p === 'Option') return '⌥'
    if (p === 'Shift') return '⇧'
    return p
  })
}

export function IslandSettings({
  menuBarH,
  workflowAlwaysShow,
  onToggleWorkflowAlwaysShow,
  showActiveTerminal,
  onToggleActiveTerminal,
  simulateStatus,
  onSimulateStatus,
  archivedSessions,
  onRestoreAgent,
  onDeleteAgent,
  onClose
}: {
  menuBarH: number
  workflowAlwaysShow: boolean
  onToggleWorkflowAlwaysShow: (on: boolean) => void
  showActiveTerminal: boolean
  onToggleActiveTerminal: (on: boolean) => void
  simulateStatus: SimStatus
  onSimulateStatus: (kind: SimStatus) => void
  archivedSessions: IslandSession[]
  onRestoreAgent: (id: string) => void
  onDeleteAgent: (id: string) => void
  onClose: () => void // exit Settings → back to the chat tab the user was on
}): JSX.Element {
  const top = Math.max(28, menuBarH) + 8
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const archivedCount = archivedSessions.length

  // Rebind for the global open/close-island shortcut. The button captures the next combo while focused; main
  // suspends the live chord during capture so it isn't swallowed before the renderer sees it.
  const [toggleAccel, setToggleAccel] = useState('Alt+Space')
  const [capturing, setCapturing] = useState(false)
  const keybindBtnRef = useRef<HTMLButtonElement>(null)
  const capturingRef = useRef(false)
  capturingRef.current = capturing
  useEffect(() => {
    keybindBridge()
      ?.keybindGet?.()
      .then((r) => {
        if (r?.notchToggle) setToggleAccel(r.notchToggle)
      })
      .catch(() => {})
    // If the panel unmounts mid-capture (e.g. Esc closed the island before onBlur fired), re-arm the chord so the
    // global shortcut is never left dead.
    return () => {
      if (capturingRef.current) void keybindBridge()?.keybindSuspend?.(false)
    }
  }, [])
  const startCapture = (): void => {
    setCapturing(true)
    keybindBtnRef.current?.focus() // guarantee keydown lands on the button, not whatever had focus
    void keybindBridge()?.keybindSuspend?.(true)
  }
  const cancelCapture = (): void => {
    setCapturing(false)
    void keybindBridge()?.keybindSuspend?.(false)
  }
  const onKeybindKey = (e: RKeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      cancelCapture()
      return
    }
    const accel = accelFromEvent(e)
    if (!accel) return // modifiers held but no key yet
    setCapturing(false)
    keybindBridge()
      ?.keybindSet?.(accel)
      .then((r) => {
        if (r?.notchToggle) setToggleAccel(r.notchToggle)
      })
      .catch(() => void keybindBridge()?.keybindSuspend?.(false))
  }

  return (
    <div className="nh-island isl-settings" style={{ paddingTop: top }}>
      <div className="isl-settings-head">
        <span className="isl-settings-title">Settings</span>
        <button type="button" className="isl-settings-close" onClick={onClose} title="Close settings" aria-label="Close settings">
          <svg viewBox="0 0 24 24" aria-hidden focusable="false">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          </svg>
        </button>
      </div>
      <div className="isl-settings-list">
        <div className="isl-setting-row">
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Open / close Blitz</span>
            <span className="isl-setting-note">Global shortcut to show or hide the island</span>
          </span>
          <button
            ref={keybindBtnRef}
            type="button"
            className={`isl-keybind${capturing ? ' capturing' : ''}`}
            onClick={() => (capturing ? cancelCapture() : startCapture())}
            onKeyDown={onKeybindKey}
            onBlur={() => capturing && cancelCapture()}
            aria-label="Rebind the open and close shortcut"
          >
            {capturing ? (
              <span className="isl-keybind-hint">Press keys…</span>
            ) : (
              accelCaps(toggleAccel).map((cap, i) => (
                <kbd key={i} className="isl-kbd">
                  {cap}
                </kbd>
              ))
            )}
          </button>
        </div>
        {/* Workflow board is always-on for users (default ON, driven by NotchHost). The toggle is intentionally
            hidden — uncomment to expose it again.
        <label className="isl-setting-row">
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Always show workflow board</span>
            <span className="isl-setting-note">Expand each run instead of a collapsed pill</span>
          </span>
          <input
            className="isl-setting-input"
            type="checkbox"
            checked={workflowAlwaysShow}
            onChange={(e) => onToggleWorkflowAlwaysShow(e.currentTarget.checked)}
          />
          <span className="isl-setting-toggle" aria-hidden>
            <span />
          </span>
        </label>
        */}
        <label className="isl-setting-row">
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Show agent terminal button</span>
            <span className="isl-setting-note">Read-only</span>
          </span>
          <input
            className="isl-setting-input"
            type="checkbox"
            checked={showActiveTerminal}
            onChange={(e) => onToggleActiveTerminal(e.currentTarget.checked)}
          />
          <span className="isl-setting-toggle" aria-hidden>
            <span />
          </span>
        </label>
        {/* Simulate agent status (debug) — temporarily commented out. Uncomment to re-enable: while armed (≠ Off),
            the next message you send injects this status instead of reaching the agent.
        <div className="isl-setting-row isl-setting-col">
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Simulate agent status</span>
            <span className="isl-setting-note">
              Debug — your next message injects this status instead of messaging the agent
            </span>
          </span>
          <div className="isl-debug-seg" role="group" aria-label="Simulate agent status">
            {SIM_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`isl-debug-seg-btn${simulateStatus === opt.value ? ' active' : ''}`}
                aria-pressed={simulateStatus === opt.value}
                title={opt.title}
                onClick={() => onSimulateStatus(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        */}
        <button
          type="button"
          className="isl-settings-quit"
          onClick={() => void (window as unknown as { agentOS?: { quit?: () => Promise<unknown> } }).agentOS?.quit?.()}
          aria-label="Quit BlitzOS"
        >
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Quit BlitzOS</span>
            <span className="isl-setting-note">Close the app</span>
          </span>
          <span className="isl-settings-quit-glyph" aria-hidden>
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 4v8" />
              <path d="M7.5 6.7a7 7 0 1 0 9 0" />
            </svg>
          </span>
        </button>
        <button
          type="button"
          className={`isl-settings-disclosure${archivedOpen ? ' open' : ''}`}
          aria-expanded={archivedOpen}
          onClick={() => {
            setArchivedOpen((v) => !v)
            setConfirmDeleteId(null)
          }}
        >
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Archived agents</span>
            <span className="isl-setting-note">{archivedCount === 1 ? '1 hidden agent' : `${archivedCount} hidden agents`}</span>
          </span>
          <span className="isl-settings-count">{archivedCount}</span>
          <span className="isl-settings-chevron" aria-hidden>
            {archivedOpen ? '▾' : '▸'}
          </span>
        </button>
        {archivedOpen && (
          <div className="isl-archived-list">
            {archivedSessions.length === 0 ? (
              <div className="isl-archived-empty">No archived agents</div>
            ) : (
              archivedSessions.map((session) => {
                const confirming = confirmDeleteId === session.id
                return (
                  <div key={session.id} className={`isl-archived-row${confirming ? ' confirming' : ''}`}>
                    <span className="isl-archived-main">
                      <span className="isl-archived-title">{session.title}</span>
                      <span className="isl-archived-preview">{archivedMessagePreview(session)}</span>
                    </span>
                    {confirming ? (
                      <span className="isl-archived-confirm">
                        <span>Delete forever?</span>
                        <button type="button" className="isl-archived-btn" onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="isl-archived-btn danger"
                          onClick={() => {
                            onDeleteAgent(session.id)
                            setConfirmDeleteId(null)
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    ) : (
                      <span className="isl-archived-actions">
                        <button type="button" className="isl-archived-btn" onClick={() => onRestoreAgent(session.id)}>
                          Restore
                        </button>
                        <button type="button" className="isl-archived-btn danger" onClick={() => setConfirmDeleteId(session.id)}>
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default IslandSettings
