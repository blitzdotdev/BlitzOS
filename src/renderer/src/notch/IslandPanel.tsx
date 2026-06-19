// IslandPanel — THE BlitzOS dynamic-island UI (LOCKED design), rendering REAL agent data. Deliberately MINIMAL:
// no header, no icons. ONE persistent tab strip: tab 0 is the new-session tab (a circle with a PEN), tabs 1..N
// are the live agents (a status dot + title). The body is the composer when the pen tab is active, else the
// active agent's TIMELINE — the conversation (iMessage bubbles) interleaved with the narrator's plain milestone
// STEPS — above a live status line + the steer bar. A "Details" expand reveals the raw tool rows (Grep/Edit/Run).
// Every composer has an attach "+" that toggles the AttachPanel inline (the island grows). The BLACK chassis +
// the original NotchShape are owned by NotchHost and are INVARIANT; this paints ONLY the interior.
import './island.css'
import { useEffect, useRef, useState } from 'react'
import { ChatInput } from './ChatInput'
import { AttachPanel } from './AttachPanel'
import type { IslandPanelProps } from './types'

// A compose / pen glyph for the new-session tab (kept distinct from the attach "+").
const PEN_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'
// A stable, vibrant per-agent gradient (the peek "album art") derived from the agent id.
function agentGradient(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.42) 0%, transparent 40%), linear-gradient(145deg, hsl(${h} 85% 60%), hsl(${(h + 55) % 360} 80% 56%) 45%, hsl(${(h + 120) % 360} 82% 60%))`
}

// Raw host status → the dot (only 'working' pulses blue; everything else is a gray dot).
const dotStatus = (s: string): string => (s === 'working' || s === 'starting' ? 'working' : 'idle')
// Raw host status → a plain one-word label for the live status line.
const statusLabel = (s: string): string => {
  switch (s) {
    case 'working':
    case 'starting':
      return 'Working'
    case 'waiting':
      return 'Needs you'
    case 'stopped':
      return 'Done'
    case 'error':
      return 'Problem'
    default:
      return 'Idle' // watching, idle
  }
}

export default function IslandPanel(props: IslandPanelProps): JSX.Element {
  const { sessions, page, onSelectPage, messages, milestones, allMilestones, status, activeId, peek, onTogglePeek, onSend, menuBarH, attachOpen, onToggleAttach } =
    props
  const top = Math.max(28, menuBarH) + 8
  const isNew = page === 0 // the pen tab
  const feedRef = useRef<HTMLDivElement>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailRows, setDetailRows] = useState<Array<{ label: string }>>([])

  // The timeline = the conversation (user/agent bubbles) interleaved with the narrator's milestone STEPS, oldest
  // → newest. Messages and milestones are different content (the agent talking vs a summary of what it did), so
  // both show; the live status line below is the current state.
  const entries = [
    ...messages.map((m, i) => ({ key: 'm' + i, ts: m.ts || 0, kind: m.role as 'user' | 'agent', text: m.text })),
    ...milestones.map((ms) => ({ key: 's' + ms.id, ts: ms.ts || 0, kind: 'step' as const, text: ms.text }))
  ].sort((a, b) => (a.ts || 0) - (b.ts || 0))

  // Keep the timeline pinned to the latest entry.
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])

  // Reset the Details expand when switching sessions.
  useEffect(() => {
    setDetailsOpen(false)
    setDetailRows([])
  }, [activeId])

  const toggleDetails = (): void => {
    const next = !detailsOpen
    setDetailsOpen(next)
    if (next && activeId) {
      window.agentOS
        ?.agentDetails?.(activeId)
        .then((r) => setDetailRows(r?.rows || []))
        .catch(() => {
          /* best-effort */
        })
    }
  }

  // The message bar (attach "+" to the left of the pill), then the inline attachment panel BELOW it (the island
  // grows when open). Vertical order: message bar, then skills, then the dropboxes.
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

  // PEEK VIEW (now-playing across ALL sessions): collapse every chat into a list of agent cards — each a gradient
  // "album" + the agent's latest summary as the title (+ one prior as a "lyric") + a live pulse. Tap a card to
  // open that agent's chat. The toggle itself lives in the notch band (NotchHost). Reuses the milestone data.
  if (peek) {
    return (
      <div className="nh-island isl-peek-mode" style={{ paddingTop: top }}>
        {sessions.length === 0 ? (
          <div className="isl-empty">No sessions yet</div>
        ) : (
          <div className="isl-peek-list">
            {sessions.map((s, i) => {
              const ms = allMilestones[s.id] || []
              const current = ms[ms.length - 1]
              const prev = ms[ms.length - 2]
              const working = dotStatus(s.status) === 'working'
              return (
                <button
                  key={s.id}
                  type="button"
                  className="isl-peek-card"
                  onClick={() => {
                    onSelectPage(i + 1)
                    onTogglePeek()
                  }}
                >
                  <div className="isl-peek-album" style={{ background: agentGradient(s.id) }}>
                    {working && (
                      <span className="isl-peek-eq" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                  <div className="isl-peek-cardtext">
                    <div className="isl-peek-name">
                      {s.title}
                      {working && <span className="isl-peek-livedot" aria-hidden />}
                    </div>
                    <div className="isl-peek-cardtitle">{current ? current.text : statusLabel(s.status)}</div>
                    {prev && <div className="isl-peek-cardly">{prev.text}</div>}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`nh-island ${isNew ? 'isl-session' : 'isl-process'}`} style={{ paddingTop: top }}>
      {/* Persistent tab strip: the new-session PEN tab first, then one chip per live agent. */}
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
            <span className="isl-chip-dot" data-status={dotStatus(s.status)} aria-hidden />
            <span className="isl-chip-label">{s.title}</span>
          </button>
        ))}
      </div>

      {isNew ? (
        // New-session tab: just the composer (spawns a session on send).
        composerBlock('Ask Blitz, or describe a task', 132, true)
      ) : (
        // Agent tab: the timeline (bubbles + milestone steps) + Details + a live status line + the steer bar.
        <>
          <div className="isl-feed" ref={feedRef}>
            {entries.length === 0 ? (
              <div className="isl-empty">No activity yet</div>
            ) : (
              entries.map((e) =>
                e.kind === 'step' ? (
                  <div key={e.key} className="isl-step">
                    <span className="isl-step-dot" aria-hidden />
                    <span className="isl-step-text">{e.text}</span>
                  </div>
                ) : (
                  <div key={e.key} className={`isl-msg ${e.kind}`}>
                    {e.text}
                  </div>
                )
              )
            )}
          </div>
          <button type="button" className={`isl-details${detailsOpen ? ' open' : ''}`} onClick={toggleDetails}>
            <span className="isl-details-caret" aria-hidden>
              {detailsOpen ? '▾' : '▸'}
            </span>
            Details
          </button>
          {detailsOpen && (
            <div className="isl-detail-rows">
              {detailRows.length === 0 ? (
                <div className="isl-detail-empty">No steps recorded</div>
              ) : (
                detailRows.map((r, i) => (
                  <div key={i} className="isl-detail-row">
                    {r.label}
                  </div>
                ))
              )}
            </div>
          )}
          <div className="isl-status" data-status={dotStatus(status)}>
            <span className="isl-status-dot" aria-hidden />
            {statusLabel(status)}
          </div>
          {composerBlock('Steer this agent…', 108, false)}
        </>
      )}
    </div>
  )
}
