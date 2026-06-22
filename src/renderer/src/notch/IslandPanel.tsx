// IslandPanel — THE BlitzOS dynamic-island UI (LOCKED design), rendering REAL agent data. Deliberately MINIMAL:
// no header, no icons. ONE persistent tab strip: tab 0 is the new-session tab (a circle with a PEN), tabs 1..N
// are the live agents (a status dot + title). The body is the composer when the pen tab is active, else the
// active agent's TIMELINE — the conversation (iMessage bubbles) interleaved with the narrator's plain milestone
// STEPS — above a live status line + the steer bar. A "Details" expand reveals the raw tool rows (Grep/Edit/Run).
// Every composer has an attach "+" that toggles the AttachPanel inline (the island grows). The BLACK chassis +
// the original NotchShape are owned by NotchHost and are INVARIANT; this paints ONLY the interior.
import './island.css'
import './wf.css'
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChatInput } from './ChatInput'
import { AttachPanel } from './AttachPanel'
import { AttachTray, type TrayGroup } from './attachTray'
import { useSentTray, recordSentTray, getLiveTray } from './sentTrayStore'
import { IslandTerminalPane } from './IslandTerminalPane'
import MarkdownMessage from './MarkdownMessage'
import IslandKanban, { type WfStats } from './IslandKanban'
import { fmtMs, fmtTok } from './wfShared'
import { matchingChoiceAnswer } from './messageParts'
import type { IslandPanelProps, IslandWfRun } from './types'

const AGENT_NAME_MAX = 24

// A compose / pen glyph for the new-session tab (kept distinct from the attach "+").
const PEN_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'
const ARCHIVE_PATH =
  'M4 7h16M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M9 11h6M5 3h14a1 1 0 0 1 1 1v3H4V4a1 1 0 0 1 1-1Z'
// A stable, vibrant per-agent gradient (the peek "album art") derived from the agent id.
function agentGradient(id: string): string {
  // Spread hues by the GOLDEN ANGLE so sequential agent ids ('0','1','2'…) get maximally DIFFERENT, diverse colors
  // (a plain char-hash put them ~1° apart, so every agent looked the same). Numeric ids use the number directly.
  let n = 0
  for (let i = 0; i < id.length; i++) n = (n * 33 + id.charCodeAt(i)) >>> 0
  const base = /^\d+$/.test(id) ? parseInt(id, 10) : n
  const h = (base * 137.508) % 360
  return `radial-gradient(120% 120% at 28% 18%, rgba(255,255,255,0.42) 0%, transparent 40%), linear-gradient(145deg, hsl(${h} 85% 60%), hsl(${(h + 50) % 360} 80% 56%) 45%, hsl(${(h + 110) % 360} 82% 60%))`
}

// Raw host status → the dot (working + reconnecting pulse so a stuck/reviving agent never reads as a dead gray
// 'Idle'; everything else is a gray dot).
const dotStatus = (s: string): string => (s === 'working' || s === 'starting' || s === 'reconnecting' ? 'working' : 'idle')
// Raw host status → a plain one-word label for the live status line.
const statusLabel = (s: string): string => {
  switch (s) {
    case 'working':
    case 'starting':
      return 'Working'
    case 'reconnecting': // the OS is reviving a deaf agent (wait-loop died, e.g. rate-limited) — see agent-wake-watchdog
      return 'Reconnecting'
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
const cleanAgentName = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, AGENT_NAME_MAX)

export default function IslandPanel(props: IslandPanelProps): JSX.Element {
  const {
    sessions,
    page,
    onSelectPage,
    messages,
    milestones,
    runs: runsProp,
    status,
    activeId,
    peek,
    onSend,
    menuBarH,
    attachOpen,
    onToggleAttach,
    debugTerminalEnabled,
    activeTerminal,
    onArchiveAgent,
    onRenameAgent
  } = props
  // KANBAN BOARD HIDDEN (2026-06-21): the in-chat workflow board is unreliable — runs are ephemeral (dropped
  // from memory 30s after done, no disk persistence, gone on relaunch), so a finished/long run shows nothing.
  // Disabled at the render layer (run_workflow itself still runs and writes its journal to disk). The full
  // persistence design that fixes this is in plans/blitzos-kanban-persistence.md. Flip KANBAN_HIDDEN to false to
  // re-enable; the render path below (renderBoard / IslandKanban) is intact, just fed an empty run list.
  const KANBAN_HIDDEN: boolean = true
  const runs = KANBAN_HIDDEN ? [] : runsProp
  const top = Math.max(28, menuBarH) + 8
  const isNew = page === 0 // the pen tab
  const feedRef = useRef<HTMLDivElement>(null)
  const lyricsRef = useRef<HTMLDivElement>(null)
  // Attach mode in an AGENT chat: lock the island to the height it had BEFORE attach opened, so the attachment panel
  // rises only as tall as its own content and the chat feed shrinks to fit (instead of the island growing). We keep
  // the last closed-state height in a ref (recorded after every closed render) and apply it while attach is open.
  const panelRef = useRef<HTMLDivElement>(null)
  const closedHeightRef = useRef<number | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailRows, setDetailRows] = useState<Array<{ label: string }>>([])
  // Attachment SNAPSHOT: a frozen, read-only copy of the dropbox shown above the user message it rode on. PERSISTED
  // (sentTrayStore → disk) so it survives island reopen AND a full quit/restart. Keyed by the user-message ORDINAL —
  // the dropbox clears on send, so each message's snapshot is exactly what was staged at THAT send.
  const sentTray = useSentTray(activeId)
  const pendingNewSessionRef = useRef<TrayGroup[] | null>(null) // composer ('') tray, pinned to the spawned agent's msg 0
  const seenChatRef = useRef<Set<string>>(new Set())
  // On first sight of a freshly spawned agent, pin the composer tray captured at its spawning send to its first message.
  useEffect(() => {
    if (!activeId) return
    if (seenChatRef.current.has(activeId)) return
    seenChatRef.current.add(activeId)
    const pending = pendingNewSessionRef.current
    pendingNewSessionRef.current = null
    if (pending && pending.length) recordSentTray(activeId, 0, pending)
  }, [activeId])
  // Freeze an EXACT copy of the live dropbox (getLiveTray) onto the message being sent, THEN send (NotchHost.onSend
  // clears the live tray). New-session composer ('') → stash it to pin onto the spawned agent's first message.
  const handleSend = (text: string): void => {
    if (activeId) {
      const groups = getLiveTray(activeId)
      if (groups.length) {
        const ord = messages.reduce((n, m) => n + (m.role === 'user' ? 1 : 0), 0) // ordinal of the user msg being sent
        recordSentTray(activeId, ord, groups)
      }
      onSend(text)
      return
    }
    const groups = getLiveTray('')
    if (groups.length) pendingNewSessionRef.current = groups
    onSend(text)
  }
  // The frozen tray per transcript index (pinned to each user message's ordinal; undefined for agent rows / no tray).
  let userOrdinal = -1
  const trayByIndex = messages.map((m) => {
    if (m.role !== 'user') return undefined
    userOrdinal++
    return sentTray[userOrdinal]
  })
  // Per-run rolled-up stats for the board caption (reported up by each IslandKanban on run:done). The callback is
  // STABLE (useCallback) and no-ops when the value is unchanged, so it never loops the child's reporting effect.
  const [runStats, setRunStats] = useState<Record<string, WfStats | null>>({})
  const handleRunStats = useCallback((runId: string, s: WfStats | null) => {
    setRunStats((prev) => (prev[runId] === s ? prev : { ...prev, [runId]: s }))
  }, [])
  // Anchor each live workflow board AFTER the last message that preceded its run (the agent's "running…" line),
  // so the board sits in TIME ORDER in the transcript instead of stacking at the top. A run whose start predates
  // every message (no preceding message) renders at the very top. Keyed by message index → the runs anchored there.
  const runsByAnchor = new Map<number, IslandWfRun[]>()
  const leadingRuns: IslandWfRun[] = []
  for (const r of runs) {
    let idx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if ((messages[i].ts || 0) <= r.startedAt) {
        idx = i
        break
      }
    }
    if (idx < 0) leadingRuns.push(r)
    else {
      const arr = runsByAnchor.get(idx) || []
      arr.push(r)
      runsByAnchor.set(idx, arr)
    }
  }
  const renderBoard = (r: IslandWfRun): JSX.Element => {
    const s = runStats[r.runId]
    return (
      <div className={`isl-wf-board${r.done ? ' isl-wf-done' : ''}`} key={r.runId}>
        <div className="isl-wf-board-head">
          <span className="isl-wf-dot" aria-hidden />
          <span>{r.done ? (r.ok ? 'workflow done' : 'workflow failed') : 'workflow running'}</span>
          {r.file ? <span className="isl-wf-file">{r.file.replace(/^.*\//, '')}</span> : null}
          <span className="isl-wf-stats">{s ? `${fmtMs(s.ms)} · ${s.calls} agents · ${fmtTok(s.tokens)} tok` : 'running…'}</span>
        </div>
        <IslandKanban runId={r.runId} skeleton={r.skeleton} onStats={handleRunStats} />
      </div>
    )
  }
  // Brandon's tab-rename state ("Rename agent tabs from notch").
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const skipRenameBlurRef = useRef(false)
  const committingRenameRef = useRef<string | null>(null)
  const latestMessageText = messages[messages.length - 1]?.text || ''

  // The chat is PURE messages (the agent's real say() + your steers). The narrator's summaries do NOT appear here
  // — they live in the peek "now playing" view. Keep the chat pinned to the latest message — also when attach
  // opens/closes (the feed resizes), re-pinning after the 0.3s grow so the newest message stays at the new bottom.
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    const t = window.setTimeout(() => {
      if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
    }, 340)
    return () => clearTimeout(t)
  }, [messages.length, latestMessageText, attachOpen])

  // Record the island's height whenever attach is CLOSED, so opening attach can lock to that height (above).
  useLayoutEffect(() => {
    if (!attachOpen && panelRef.current) closedHeightRef.current = panelRef.current.offsetHeight
  })

  // Keep the peek lyrics scrolled to the newest (you scroll up for older).
  useEffect(() => {
    const el = lyricsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [milestones.length, peek])

  // Reset the Details expand when switching sessions.
  useEffect(() => {
    setDetailsOpen(false)
    setDetailRows([])
  }, [activeId])

  useEffect(() => {
    if (!editingId) return
    const el = renameInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editingId])

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

  const startRename = (sessionId: string, title: string): void => {
    setEditingId(sessionId)
    setEditingName(title.slice(0, AGENT_NAME_MAX))
    setRenameBusy(false)
  }
  const cancelRename = (skipBlur = false): void => {
    skipRenameBlurRef.current = skipBlur
    committingRenameRef.current = null
    setEditingId(null)
    setEditingName('')
    setRenameBusy(false)
  }
  const commitRename = (sessionId: string): void => {
    if (renameBusy || committingRenameRef.current) return
    const next = cleanAgentName(editingName)
    const current = sessions.find((s) => s.id === sessionId)?.title || ''
    if (!next || next === current) {
      cancelRename()
      return
    }
    committingRenameRef.current = sessionId
    setRenameBusy(true)
    onRenameAgent(sessionId, next)
      .then((ok) => {
        if (ok) cancelRename()
        else {
          committingRenameRef.current = null
          setRenameBusy(false)
          renameInputRef.current?.focus()
        }
      })
      .catch(() => {
        committingRenameRef.current = null
        setRenameBusy(false)
        renameInputRef.current?.focus()
      })
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
          onSend={handleSend}
          autoFocus={autoFocus}
          maxHeight={maxHeight}
          sendLabel="↑"
          draftKey={activeId ?? ''}
        />
      </div>
      <div className={`isl-attach-wrap${attachOpen ? ' open' : ''}`} aria-hidden={!attachOpen}>
        <div className="isl-attach-inner">
          <AttachPanel activeSessionId={activeId ?? ''} />
        </div>
      </div>
    </>
  )

  // The shared horizontal tab strip (pen + one chip per agent), kept in BOTH the chat and the peek view.
  const tabStrip = (
    <div
      className="isl-tabs"
      role="tablist"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
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
      {sessions.map((s, i) => {
        const selected = page === i + 1
        const editing = editingId === s.id
        if (editing) {
          return (
            <form
              key={s.id}
              role="tab"
              aria-selected={selected}
              className={`isl-chip isl-chip-agent isl-chip-editing${selected ? ' active' : ''}`}
              onSubmit={(e) => {
                e.preventDefault()
                commitRename(s.id)
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
            >
              <span className="isl-chip-album" style={{ background: agentGradient(s.id) }} aria-hidden />
              <input
                ref={renameInputRef}
                className="isl-chip-input"
                value={editingName}
                maxLength={AGENT_NAME_MAX}
                disabled={renameBusy}
                aria-label="Rename agent"
                onChange={(e) => setEditingName(e.currentTarget.value)}
                onBlur={() => {
                  if (skipRenameBlurRef.current) {
                    skipRenameBlurRef.current = false
                    return
                  }
                  commitRename(s.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelRename(true)
                  }
                }}
              />
              <span className="isl-chip-dot" data-status={dotStatus(s.status)} aria-hidden />
            </form>
          )
        }
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`isl-chip isl-chip-agent${selected ? ' active' : ''}`}
            onClick={() => onSelectPage(i + 1)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (s.id === '0') return
              onSelectPage(i + 1)
              startRename(s.id, s.title)
            }}
            title={s.id === '0' ? 'Main' : 'Right-click to rename'}
          >
            <span className="isl-chip-album" style={{ background: agentGradient(s.id) }} aria-hidden />
            <span className="isl-chip-label">{s.title}</span>
            <span className="isl-chip-dot" data-status={dotStatus(s.status)} aria-hidden />
          </button>
        )
      })}
    </div>
  )

  // PEEK VIEW: keep the horizontal tab bar; the area BELOW it becomes the ACTIVE agent's "now playing" — a gradient
  // album + the latest summary as the big title + past summaries above as "lyrics". Switching tabs (click / Ctrl+Tab)
  // changes which agent shows. Reuses the milestone data; the toggle itself lives in the notch band (NotchHost).
  if (peek) {
    const shown = milestones.slice(0, -1).slice(-20) // past summaries (kept for scrolling; the CSS shows ~3 at a time)
    const current = milestones[milestones.length - 1]
    const working = dotStatus(status) === 'working'
    return (
      <div className="nh-island isl-peek-mode" style={{ paddingTop: top }}>
        {tabStrip}
        {activeId ? (
          // bottom-pinned: the album + title + status sit flush at the island bottom, the lyrics fade above.
          <div className="isl-peek-body">
            {shown.length > 0 && (
              <div className="isl-peek-lyrics" ref={lyricsRef}>
                {shown.map((m, i) => (
                  <div
                    key={m.id}
                    className="isl-peek-ly"
                    style={{ opacity: 0.28 + 0.5 * (shown.length === 1 ? 1 : i / (shown.length - 1)) }}
                  >
                    {m.text}
                  </div>
                ))}
              </div>
            )}
            <div className="isl-peek-now">
              <div className="isl-peek-album" style={{ background: agentGradient(activeId) }}>
                {working && (
                  <span className="isl-peek-eq" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </div>
              {/* top-aligned with the album; title clamps to 2 lines so the status tag always fits within it. */}
              <div className="isl-peek-nowtext">
                <div className="isl-peek-title">{current ? current.text : 'Getting started…'}</div>
                <div className="isl-peek-status" data-status={dotStatus(status)}>
                  <span className="isl-peek-statusdot" aria-hidden />
                  {statusLabel(status)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="isl-empty">Pick a session to peek</div>
        )}
      </div>
    )
  }

  // ATTACH MODE: the tab strip always collapses (grid-rows pop). In an AGENT chat the chat STAYS — the island height
  // is locked to what it was, so the attachment panel rises only as tall as its own content and the feed shrinks to
  // fit (still scrollable + bottom-pinned). The new-session tab has no chat, so it just sizes to the composer + attach.
  const lockHeight = attachOpen && !isNew ? closedHeightRef.current ?? undefined : undefined
  return (
    <div
      ref={panelRef}
      className={`nh-island ${isNew ? 'isl-session' : 'isl-process'}${attachOpen ? ' isl-attaching' : ''}`}
      style={lockHeight ? { paddingTop: top, height: lockHeight } : { paddingTop: top }}
    >
      <div className={`isl-tabwrap${attachOpen ? ' collapsed' : ''}`}>
        <div className="isl-tabwrap-inner">{tabStrip}</div>
      </div>
      {!isNew && (
        // Agent tab: a PURE chat (the agent's real messages only) + Details + a live status line — KEPT in attach mode.
        <>
          <div className="isl-agent-meta">
            <div className="isl-status" data-status={dotStatus(status)}>
              <span className="isl-status-dot" aria-hidden />
              {statusLabel(status)}
            </div>
            {activeId && (
              <button
                type="button"
                className={`isl-archive${activeId === '0' ? ' placeholder' : ''}`}
                disabled={activeId === '0'}
                aria-hidden={activeId === '0'}
                tabIndex={activeId === '0' ? -1 : undefined}
                onClick={() => {
                  if (activeId !== '0') onArchiveAgent(activeId)
                }}
                title={activeId === '0' ? undefined : 'Archive agent'}
                aria-label={activeId === '0' ? undefined : 'Archive agent'}
              >
                <svg viewBox="0 0 24 24" aria-hidden focusable="false">
                  <path d={ARCHIVE_PATH} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Archive</span>
              </button>
            )}
          </div>
          <div className="isl-feed" ref={feedRef}>
            {messages.length === 0 && runs.length === 0 ? (
              <div className="isl-empty">No messages yet</div>
            ) : (
              <>
                {/* runs that started before any message render at the top; the rest are interleaved below */}
                {leadingRuns.map((r) => renderBoard(r))}
                {messages.map((m, i) => {
                  const previous = messages[i - 1]
                  const selectedAnswer =
                    m.role === 'agent' && messages[i + 1]?.role === 'user' ? matchingChoiceAnswer(m.text, messages[i + 1]?.text) : undefined
                  const isSubmittedAskAnswer = m.role === 'user' && previous?.role === 'agent' && Boolean(matchingChoiceAnswer(previous.text, m.text))
                  if (isSubmittedAskAnswer) return null
                  return (
                    <Fragment key={`${i}:${m.ts || ''}`}>
                      {trayByIndex[i] && trayByIndex[i]!.length > 0 && (
                        // a frozen, read-only, glass-pill copy of the dropbox — scrolls + tooltips, no delete.
                        <div className="isl-msg-tray">
                          <AttachTray groups={trayByIndex[i]!} readOnly />
                        </div>
                      )}
                      <MarkdownMessage role={m.role} text={m.text} parts={m.parts} selectedAnswer={selectedAnswer} onChoose={(choice) => onSend(choice)} />
                      {/* live workflow board(s) anchored right after THIS message (the agent's "running…" line) */}
                      {(runsByAnchor.get(i) || []).map((r) => renderBoard(r))}
                    </Fragment>
                  )
                })}
              </>
            )}
          </div>
          {debugTerminalEnabled && activeId && (
            <IslandTerminalPane
              terminalId={activeId}
              title={activeTerminal?.title || `Agent ${activeId}`}
              status={activeTerminal?.status || 'unknown'}
            />
          )}
          <div className="isl-actions">
            <button type="button" className={`isl-details${detailsOpen ? ' open' : ''}`} onClick={toggleDetails}>
              <span className="isl-details-caret" aria-hidden>
                {detailsOpen ? '▾' : '▸'}
              </span>
              Details
            </button>
          </div>
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
        </>
      )}
      {/* the composer + attachment panel are ALWAYS visible. */}
      {composerBlock(isNew ? 'Ask Blitz, or describe a task' : 'Steer this agent…', isNew ? 132 : 108, isNew)}
    </div>
  )
}
