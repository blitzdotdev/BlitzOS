// IslandPanel — THE BlitzOS dynamic-island UI (LOCKED design), rendering REAL agent data. Deliberately MINIMAL:
// no header, no icons. ONE persistent tab strip: tab 0 is the new-session tab (a circle with a PEN), tabs 1..N
// are the live agents (a status dot + title). The body is the composer when the pen tab is active, else the
// active agent's TIMELINE — the conversation (iMessage bubbles) interleaved with the narrator's plain milestone
// STEPS — above a live status line + the steer bar. A "Details" expand reveals the raw tool rows (Grep/Edit/Run).
// Every composer has an attach "+" that toggles the AttachPanel inline (the island grows). The BLACK chassis +
// the original NotchShape are owned by NotchHost and are INVARIANT; this paints ONLY the interior.
import './island.css'
import './wf.css'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChatInput } from './ChatInput'
import { AttachPanel } from './AttachPanel'
import { AttachTray, type TrayGroup } from './attachTray'
import { useSentTray, recordSentTray, getLiveTray } from './sentTrayStore'
import { IslandTerminalPane } from './IslandTerminalPane'
import MarkdownMessage from './MarkdownMessage'
import IslandKanban, { type WfStats } from './IslandKanban'
import { isSubagentEvents } from './wfReduce'
import { fmtMs, fmtTok } from './wfShared'
import { matchingChoiceAnswer } from './messageParts'
import { agentGradient } from './agentVisuals'
import type { IslandPanelProps, IslandWfRun } from './types'

const AGENT_NAME_MAX = 24

// A compose / pen glyph for the new-session tab (kept distinct from the attach "+").
const PEN_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'
const ARCHIVE_PATH =
  'M4 7h16M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7M9 11h6M5 3h14a1 1 0 0 1 1 1v3H4V4a1 1 0 0 1 1-1Z'

// Raw host status → status symbol: warming/reconnecting pulses blue, working spins, everything else is quiet.
const dotStatus = (s: string): string =>
  s === 'starting' || s === 'reconnecting' ? 'warming' : s === 'working' ? 'working' : s === 'waiting' ? 'waiting' : s === 'error' ? 'error' : 'idle'
// Raw host status → a plain one-word label for the live status line.
const statusLabel = (s: string): string => {
  switch (s) {
    case 'working':
      return 'Working'
    case 'starting':
      return 'Warming up'
    case 'reconnecting': // the OS is reviving a deaf agent (wait-loop died, e.g. rate-limited) — see agent-wake-watchdog
      return 'Reconnecting'
    case 'waiting':
      return 'Response Needed'
    case 'stopped':
      return 'Idle'
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
  // In-chat workflow boards are durable now: each run is event-sourced on disk (index.json + events.jsonl +
  // skeleton.json), reloaded on tab-open (NotchHost.wfLoadAgentRuns), and evicted from memory only after 15 min
  // of tab inactivity — so a finished or long-past board never vanishes. See plans/blitzos-kanban-persistence.md.
  const runs = runsProp
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
  // The kanban board is COLLAPSED by default — each run shows just a compact status pill (dot + state + stats);
  // clicking the pill expands/minimizes the full board. LAZY-MOUNT: the heavy IslandKanban (which subscribes to
  // the bus + hydrates the run's full event stream from disk) is mounted ONLY once a run has been expanded, and
  // then kept mounted (the add-only `mountedRuns` set) so re-expand is instant. This is what keeps a relaunch
  // from freezing: opening a tab with N persisted runs renders N cheap pills, NOT N boards each replaying its
  // backlog. The trade: a never-expanded done run's pill shows status only (no stats) until first expand.
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(() => new Set())
  const [mountedRuns, setMountedRuns] = useState<Set<string>>(() => new Set())
  const toggleRun = useCallback((runId: string) => {
    setMountedRuns((prev) => (prev.has(runId) ? prev : new Set(prev).add(runId))) // mount on first expand, stay mounted
    setExpandedRuns((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }, [])
  // Anchor each live workflow board AFTER the last message that preceded its run (the agent's "running…" line),
  // so the board sits in TIME ORDER in the transcript instead of stacking at the top. A run whose start predates
  // every message (no preceding message) renders at the very top. Keyed by message index → the runs anchored
  // there. MEMOIZED on [runs, messages] so this O(runs × messages) walk doesn't re-run on every panel render
  // (chat broadcasts, status ticks, steer-bar keystrokes) — only when the runs or transcript actually change.
  const { runsByAnchor, leadingRuns } = useMemo(() => {
    const byAnchor = new Map<number, IslandWfRun[]>()
    const leading: IslandWfRun[] = []
    for (const r of runs) {
      let idx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i].ts || 0) <= r.startedAt) {
          idx = i
          break
        }
      }
      if (idx < 0) leading.push(r)
      else {
        const arr = byAnchor.get(idx) || []
        arr.push(r)
        byAnchor.set(idx, arr)
      }
    }
    return { runsByAnchor: byAnchor, leadingRuns: leading }
  }, [runs, messages])
  const renderBoard = (r: IslandWfRun): JSX.Element => {
    // SINGLE-PHASE fan-out ("subagents"): each leaf is already its own row pill, so the run-level "workflow
    // running" pill is redundant — drop it and render the rows directly (always mounted; a fan-out board is small,
    // not the heavy multi-phase grid the lazy-mount guards). Detected from the dry-preflight skeleton alone, so no
    // board mount is needed to decide. Before the skeleton lands it reads false → the normal pill shows, then this
    // switches to the headless rows once the plan is known.
    if (isSubagentEvents(r.skeleton as unknown[])) {
      return (
        <div className={`isl-wf-board isl-wf-subagents${r.done ? ' isl-wf-done' : ''}`} key={r.runId}>
          <div className="isl-wf-board-body">
            <IslandKanban runId={r.runId} skeleton={r.skeleton} onStats={handleRunStats} />
          </div>
        </div>
      )
    }
    // Prefer the LIVE stats a mounted board reports (freshest), else the final stats stored on the run record
    // (index.json) — so a collapsed/never-expanded done board still shows "{ms} · {calls} agents · {tokens} tok"
    // with no board mount. Both are null while a run is still running.
    const s = runStats[r.runId] || r.stats || null
    const open = expandedRuns.has(r.runId)
    const statsLine = s ? `${fmtMs(s.ms)} · ${s.calls} agents · ${fmtTok(s.tokens)} tok` : r.done ? '' : 'running…'
    return (
      <div className={`isl-wf-board${r.done ? ' isl-wf-done' : ''}${open ? ' isl-wf-open' : ''}`} key={r.runId}>
        <button
          type="button"
          className="isl-wf-board-head"
          aria-expanded={open}
          onClick={() => toggleRun(r.runId)}
          title={open ? 'Hide the board' : 'Show the board'}
        >
          <span className="isl-wf-caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="isl-wf-dot" aria-hidden />
          <span className="isl-wf-status">{r.done ? (r.ok ? 'workflow done' : 'workflow failed') : 'workflow running'}</span>
          <span className="isl-wf-stats">{statsLine}</span>
        </button>
        {/* LAZY: mount the board only after the run has been expanded once; then keep it mounted (hidden when
            collapsed) so re-expand is instant + a live run's onStats keeps feeding the pill. */}
        {mountedRuns.has(r.runId) ? (
          <div className="isl-wf-board-body" hidden={!open}>
            <IslandKanban runId={r.runId} skeleton={r.skeleton} onStats={handleRunStats} />
          </div>
        ) : null}
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

  const loadDetails = useCallback((): void => {
    if (!activeId) return
    window.agentOS
      ?.agentDetails?.(activeId)
      .then((r) => setDetailRows(r?.rows || []))
      .catch(() => {
        /* best-effort */
      })
  }, [activeId])

  const toggleDetails = (): void => {
    const next = !detailsOpen
    setDetailsOpen(next)
    if (next) loadDetails()
  }

  // Keep the inline activity row fresh while the agent is doing something. This is the same raw tool-row source
  // the old bottom Details section used; the redesign changes placement first, not the backend contract.
  useEffect(() => {
    if (!activeId) return
    loadDetails()
    if (dotStatus(status) === 'idle') return
    const timer = window.setInterval(loadDetails, 2500)
    return () => window.clearInterval(timer)
  }, [activeId, loadDetails, status])

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
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i
    return -1
  })()
  const latestDetail = detailRows[detailRows.length - 1]?.label
  const inlineDetailText = latestDetail || (dotStatus(status) === 'idle' ? statusLabel(status) : `${statusLabel(status)}…`)
  const showInlineDetails = Boolean(activeId && (latestDetail || dotStatus(status) !== 'idle' || detailsOpen))
  const inlineDetails = showInlineDetails ? (
    <div className={`isl-inline-details${detailsOpen ? ' open' : ''}`} data-status={dotStatus(status)}>
      <button type="button" className="isl-inline-details-summary" onClick={toggleDetails}>
        <span className="isl-inline-status-dot" aria-hidden />
        <span className="isl-inline-details-text">{inlineDetailText}</span>
        <span className="isl-inline-details-caret" aria-hidden>
          {detailsOpen ? '▾' : '›'}
        </span>
      </button>
      {detailsOpen && (
        <div className="isl-inline-detail-rows">
          {detailRows.length === 0 ? (
            <div className="isl-inline-detail-empty">No steps recorded</div>
          ) : (
            detailRows.slice(-40).map((r, i, rows) => (
              <div key={`${i}:${r.label}`} className={`isl-inline-detail-row${i === rows.length - 1 ? ' latest' : ''}`}>
                <span className="isl-inline-detail-bullet" aria-hidden />
                <span>{r.label}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  ) : null
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
        // Agent tab: a PURE chat (the agent's real messages only) + inline activity details — KEPT in attach mode.
        <>
          <div className="isl-agent-meta">
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
                      {i === lastUserIndex && inlineDetails}
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
        </>
      )}
      {/* the composer + attachment panel are ALWAYS visible. */}
      {composerBlock(isNew ? 'Ask Blitz, or describe a task' : 'Steer this agent…', isNew ? 132 : 108, isNew)}
    </div>
  )
}
