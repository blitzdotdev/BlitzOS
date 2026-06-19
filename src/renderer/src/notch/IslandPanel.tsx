// IslandPanel — THE BlitzOS dynamic-island UI (LOCKED design, macOS/iOS Dynamic Island direction). Deliberately
// MINIMAL: no header, no icons, no agent title/subtitle. ONE persistent tab strip across every view: tab 0 is the
// new-session tab (a circle with a PEN — just a tab, not a special view), tabs 1..N are the agents (status dot +
// label). The body below the strip is the composer when the new-session tab is active, else the agent's activity
// feed + steer bar. Every composer has an attach button (a circle "+") to its left that toggles the AttachPanel
// INLINE, injected just below the message bar (the island grows to accommodate it). The BLACK chassis + the
// original NotchShape are owned by `.nh-chassis` (NotchHost) and are INVARIANT; this paints ONLY the interior.
// Visual-only for now: NotchHost owns all state + the mock data.
import './island.css'
import { ChatInput } from './ChatInput'
import { AttachPanel } from './AttachPanel'
import type { IslandPanelProps } from './types'

// A compose / pen glyph for the new-session tab (kept distinct from the attach "+").
const PEN_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'

export default function IslandPanel(props: IslandPanelProps): JSX.Element {
  const { sessions, page, onSelectPage, messages, activity, onSend, menuBarH, attachOpen, onToggleAttach } = props
  // Clear the physical notch band, then a little breathing room (8/16 grid).
  const top = Math.max(28, menuBarH) + 8
  const isNew = page === 0 // the new-session (pen) tab
  const lastMessages = messages.slice(-2)

  // The message bar (with the attach toggle "+"/"×" to the left of the pill), then the inline attachment panel
  // injected BELOW it (the island grows when open). Vertical order: message bar, then skills, then the dropboxes.
  const composerBlock = (placeholder: string, maxHeight: number, autoFocus: boolean): JSX.Element => (
    <>
      <div className="isl-composer">
        <button
          type="button"
          className={`isl-attach${attachOpen ? ' on' : ''}`}
          aria-label={attachOpen ? 'Close attachments' : 'Add attachments'}
          aria-pressed={attachOpen}
          onClick={onToggleAttach}
        >
          <span className="isl-attach-glyph" aria-hidden>
            {attachOpen ? '×' : '+'}
          </span>
        </button>
        <ChatInput
          className="isl-bar"
          placeholder={placeholder}
          onSend={onSend}
          autoFocus={autoFocus}
          maxHeight={maxHeight}
          sendLabel="↑"
        />
      </div>
      <div className={`isl-attach-wrap${attachOpen ? ' open' : ''}`} aria-hidden={!attachOpen}>
        <div className="isl-attach-inner">
          <AttachPanel />
        </div>
      </div>
    </>
  )

  return (
    <div className={`nh-island ${isNew ? 'isl-session' : 'isl-process'}`} style={{ paddingTop: top }}>
      {/* Persistent tab strip: the new-session PEN tab first, then one chip per agent. The pen tab is JUST a tab —
          selecting it shows the composer. Swipe scrolls the strip; click / Ctrl+Tab switches. */}
      <div className="isl-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={isNew}
          aria-label="New session"
          title="New session"
          className={`isl-chip isl-chip-new${isNew ? ' active' : ''}`}
          onClick={() => onSelectPage(0)}
        >
          <svg className="isl-pen" viewBox="0 0 24 24" aria-hidden focusable="false">
            <path d={PEN_PATH} fill="currentColor" />
          </svg>
        </button>
        {sessions.map((s, i) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={page === i + 1}
            className={`isl-chip${page === i + 1 ? ' active' : ''}`}
            onClick={() => onSelectPage(i + 1)}
          >
            <span className="isl-chip-dot" data-status={s.status} aria-hidden />
            <span className="isl-chip-label">{s.title}</span>
          </button>
        ))}
      </div>

      {isNew ? (
        // New-session tab: just the composer (with the inline attach panel above it).
        composerBlock('Ask Blitz, or describe a task', 132, true)
      ) : (
        // Agent tab: the activity feed scrolling above the composer (with the inline attach panel above it).
        <>
          <div className="isl-feed">
            {activity.map((a) => (
              <div key={a.id} className="isl-act" data-status={a.status}>
                <span className="isl-act-glyph" aria-hidden />
                <span className="isl-act-label">{a.label}</span>
                <span className="isl-act-detail">{a.detail}</span>
                <span className="isl-act-ts">{a.ts}</span>
              </div>
            ))}
            {lastMessages.map((m) => (
              <div key={m.id} className={`isl-msg ${m.role}`}>
                {m.text}
              </div>
            ))}
          </div>
          {composerBlock('Steer this agent…', 108, false)}
        </>
      )}
    </div>
  )
}
