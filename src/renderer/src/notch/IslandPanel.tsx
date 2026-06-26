// IslandPanel — THE BlitzOS dynamic-island UI (LOCKED design), rendering REAL agent data. Deliberately MINIMAL:
// no header, no icons. ONE persistent tab strip: a PEN button that spawns a brand-new agent (and enters it), then
// tabs 1..N for the live agents (a status dot + title; Blitz '0' is the first). The body is ALWAYS the active
// agent's TIMELINE — the conversation (iMessage bubbles) interleaved with the narrator's plain milestone
// STEPS — above a live status line + the steer bar. A "Details" expand reveals the raw tool rows (Grep/Edit/Run).
// Every composer has an attach "+" that toggles the AttachPanel inline (the island grows). The BLACK chassis +
// the original NotchShape are owned by NotchHost and are INVARIANT; this paints ONLY the interior.
import './island.css'
import './wf.css'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChatInput } from './ChatInput'
import { AttachPanel } from './AttachPanel'
import { useBrowserOnboard } from './browserGrantStore'
import { AttachTray, type TrayGroup } from './attachTray'
import { useSentTray, recordSentTray, getLiveTray } from './sentTrayStore'
import MarkdownMessage from './MarkdownMessage'
import IslandKanban, { type WfStats } from './IslandKanban'
import { isSubagentEvents } from './wfReduce'
import { fmtMs, fmtTok } from './wfShared'
import { matchingChoiceAnswerForMessage, messagePartsFor } from './messageParts'
import { agentGradient } from './agentVisuals'
import { isRunExpanded, toggleRunExpanded, setRunExpanded, hasAutoOpened, markAutoOpened, useWfExpandVersion } from './islandWfExpandStore'
import { normalizedBlitzAppPart, normalizedBlitzAppUrl } from './appEmbeds'
import type { IslandAppMessagePart, IslandPanelProps, IslandWfRun } from './types'

const AGENT_NAME_MAX = 24

// A "+" glyph for the new-chat button (spawns + enters a fresh agent). The attach "+" lives in the composer.
const PLUS_PATH = 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z'

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
const choiceSelectionKey = (activeId: string | undefined, index: number, ts: number | undefined, text: string): string =>
  `${activeId || 'new'}:${index}:${ts || 0}:${text.slice(0, 80)}`

export default function IslandPanel(props: IslandPanelProps): JSX.Element {
  const {
    sessions,
    page,
    onSelectPage,
    onNewAgent,
    messages,
    milestones,
    runs: runsProp,
    status,
    errorDetail,
    onRetry,
    activeId,
    peek,
    onSend,
    menuBarH,
    attachOpen,
    onToggleAttach,
    activeApp,
    onActiveAppChange,
    onAppViewerToggle,
    debugTerminalEnabled,
    activeTerminal,
    onArchiveAgent,
    onRenameAgent,
    onHoldOpen,
    alwaysShowWorkflow
  } = props
  // In-chat workflow boards are durable now: each run is event-sourced on disk (index.json + events.jsonl +
  // skeleton.json), reloaded on tab-open (NotchHost.wfLoadAgentRuns), and evicted from memory only after 15 min
  // of tab inactivity — so a finished or long-past board never vanishes. See plans/blitzos-kanban-persistence.md.
  const runs = runsProp
  // The browser grant mini-onboarding (in the attach panel) takes over the whole island: while it's active we hide the
  // chat transcript AND the message bar so the grant card is the only thing on screen (the user asked for exactly this).
  const onboarding = !!useBrowserOnboard()
  const top = Math.max(28, menuBarH) + 8
  const feedRef = useRef<HTMLDivElement>(null)
  const lyricsRef = useRef<HTMLDivElement>(null)
  const tabRailRef = useRef<HTMLDivElement>(null) // the horizontally-scrolling agent-tab rail (the + sits OUTSIDE it)
  // Attach mode in an AGENT chat: hold the island to AT LEAST the height it had BEFORE attach opened (a FLOOR via
  // min-height, NOT a hard cap), so a tall chat feed shrinks to absorb the attach panel and the island does not jump.
  // On a short/empty chat the feed cannot shrink the full ~168px, so the floor lets the island grow to fit the boxes
  // instead of clipping them (the bug when opening attach on a brand-new agent chat). We keep the last closed-state
  // height in a ref (recorded after every closed render) and apply it as min-height while attach is open.
  const panelRef = useRef<HTMLDivElement>(null)
  const closedHeightRef = useRef<number | null>(null)
  const appReturnScrollTopRef = useRef<number | null>(null)
  const previousActiveIdRef = useRef<string | undefined>(activeId)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailRows, setDetailRows] = useState<Array<{ label: string }>>([])
  const [pendingChoiceSelections, setPendingChoiceSelections] = useState<Record<string, string>>({})
  const [openApp, setOpenApp] = useState<IslandAppMessagePart | null>(() => activeApp)
  // The app viewer iframe is mounted PERSISTENTLY and kept warm so opening an app is an instant reveal, not a cold
  // multi-second load. warmAppUrl = the OPEN app's url while viewing (its iframe never remounts), else the LATEST
  // app card in chat (prewarmed offscreen). appLoadedUrl tracks which url finished loading so the spinner only
  // shows for a genuinely-unloaded app; warmArmed gates the offscreen prewarm behind a short settle delay.
  const [appLoadedUrl, setAppLoadedUrl] = useState<string | null>(null)
  const [warmArmed, setWarmArmed] = useState(false)
  const warmAppUrl = useMemo(() => {
    const open = normalizedBlitzAppUrl(openApp?.url)
    if (open) return open
    for (let i = messages.length - 1; i >= 0; i--) {
      const parts = messages[i]?.parts
      if (!parts) continue
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]
        if (p?.type === 'app') {
          const u = normalizedBlitzAppUrl(p.url)
          if (u) return u
        }
      }
    }
    return null
  }, [openApp, messages])
  const appViewerReady = !!warmAppUrl && appLoadedUrl === warmAppUrl
  // Attachment SNAPSHOT: a frozen, read-only copy of the dropbox shown above the user message it rode on. PERSISTED
  // (sentTrayStore → disk) so it survives island reopen AND a full quit/restart. Keyed by the user-message ORDINAL —
  // the dropbox clears on send, so each message's snapshot is exactly what was staged at THAT send.
  const sentTray = useSentTray(activeId)
  const pendingNewSessionRef = useRef<TrayGroup[] | null>(null) // composer ('') tray, pinned to the spawned agent's msg 0
  const seenChatRef = useRef<Set<string>>(new Set())
  const shownChoiceEventsRef = useRef<Set<string>>(new Set())
  // On first sight of a freshly spawned agent, pin the composer tray captured at its spawning send to its first message.
  useEffect(() => {
    if (!activeId) return
    if (seenChatRef.current.has(activeId)) return
    seenChatRef.current.add(activeId)
    const pending = pendingNewSessionRef.current
    pendingNewSessionRef.current = null
    if (pending && pending.length) recordSentTray(activeId, '0', pending) // first user msg has userIdx 0
  }, [activeId])
  useEffect(() => {
    if (!activeId) return
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (!message || message.role !== 'agent') continue
      const choice = messagePartsFor(message).find((part) => part.type === 'choice')
      if (!choice) continue
      const key = choiceSelectionKey(activeId, i, message.ts, message.text)
      if (shownChoiceEventsRef.current.has(key)) continue
      shownChoiceEventsRef.current.add(key)
      window.agentOS?.activity?.track('choice.shown', { agentId: activeId, count: choice.options.length, source: 'notch' })
    }
  }, [activeId, messages])
  // Freeze an EXACT copy of the live dropbox (getLiveTray) onto the message being sent, THEN send (NotchHost.onSend
  // clears the live tray). New-session composer ('') → stash it to pin onto the spawned agent's first message.
  const handleSend = (text: string): void => {
    if (activeId) {
      const groups = getLiveTray(activeId)
      if (groups.length) {
        // Use the absolute user-message index from the last user message; the next message is idx+1.
        // Falls back to the windowed count if userIdx isn't present (old messages before this field existed).
        const lastUserMsg = messages.slice().reverse().find((m) => m.role === 'user')
        const newUserIdx = lastUserMsg?.userIdx != null
          ? lastUserMsg.userIdx + 1
          : messages.filter((m) => m.role === 'user').length
        recordSentTray(activeId, String(newUserIdx), groups)
      }
      onSend(text)
      return
    }
    const groups = getLiveTray('')
    if (groups.length) pendingNewSessionRef.current = groups
    onSend(text)
  }
  // The frozen tray per transcript index. Keyed by m.userIdx (absolute, survives the 400-message window cap);
  // falls back to positional ordinal for messages that predate userIdx (old transcripts without the field).
  let userOrdinal = -1
  const trayByIndex = messages.map((m) => {
    if (m.role !== 'user') return undefined
    userOrdinal++
    const key = m.userIdx != null ? String(m.userIdx) : String(userOrdinal)
    return sentTray[key]
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
  // Expand/collapse the open/closed VIEW lives in a MODULE store (islandWfExpandStore) so a manual collapse/expand
  // survives the island close+reopen that REMOUNTS IslandPanel — the per-mount Set used to reset, re-expanding a
  // board the user had collapsed (the same remount-resets-local-state class as the onboarding initialHoverSeen fix).
  // The store is in-memory only, so a fresh app relaunch still starts every board collapsed → the lazy-mount
  // freeze-guard below is preserved (no mount-all-on-relaunch).
  const expandVersion = useWfExpandVersion() // re-render when any run's expand state changes
  // mountedRuns stays LOCAL (the freeze-guard): mount the heavy IslandKanban only once a run is expanded, then keep
  // it mounted (add-only). A remount re-mounts only the runs that are still expanded per the store (effect below).
  const [mountedRuns, setMountedRuns] = useState<Set<string>>(() => new Set())
  const toggleRun = useCallback((runId: string) => {
    setMountedRuns((prev) => (prev.has(runId) ? prev : new Set(prev).add(runId))) // mount on first expand, stay mounted
    toggleRunExpanded(runId)
  }, [])
  // "Always show workflow board" setting: when ON, auto-expand each NOT-yet-seen run exactly once (a manual collapse
  // afterward sticks because the run is marked auto-opened in the store). The bookkeeping + the choice both live in
  // the store so they survive the remount. OFF → touch nothing (lazy-mount default: N persisted runs render as cheap
  // pills, not N boards each replaying backlog).
  useEffect(() => {
    if (!alwaysShowWorkflow) return
    const fresh = runs.map((r) => r.runId).filter((id) => !hasAutoOpened(id))
    if (!fresh.length) return
    fresh.forEach((id) => {
      markAutoOpened(id)
      setRunExpanded(id, true)
    })
    setMountedRuns((prev) => {
      const next = new Set(prev)
      fresh.forEach((id) => next.add(id))
      return next
    })
  }, [alwaysShowWorkflow, runs])
  // Mount any run that is EXPANDED per the store but not yet mounted — covers a remount where the persisted choice is
  // expanded (so an open board's body actually renders), and the always-show seeding above. Add-only: never unmounts
  // a warm board. Keyed on expandVersion + runs so it re-runs on any expand change or roster change.
  useEffect(() => {
    setMountedRuns((prev) => {
      let next = prev
      for (const r of runs) {
        if (isRunExpanded(r.runId) && !prev.has(r.runId)) {
          if (next === prev) next = new Set(prev)
          next.add(r.runId)
        }
      }
      return next
    })
  }, [expandVersion, runs])
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
    // Finished-state class, mutually exclusive: green 'done' ONLY when ok, red 'fail' when not. A failed run
    // must never read as a green done dot (the status text already says "workflow failed").
    const doneClass = r.done ? (r.ok ? ' isl-wf-done' : ' isl-wf-fail') : ''
    // SINGLE-PHASE fan-out ("subagents"): each leaf is already its own row pill, so the run-level "workflow
    // running" pill is redundant — drop it and render the rows directly (always mounted; a fan-out board is small,
    // not the heavy multi-phase grid the lazy-mount guards). Detected from the dry-preflight skeleton alone, so no
    // board mount is needed to decide. Before the skeleton lands it reads false → the normal pill shows, then this
    // switches to the headless rows once the plan is known.
    if (isSubagentEvents(r.skeleton as unknown[])) {
      return (
        <div className={`isl-wf-board isl-wf-subagents${doneClass}`} key={r.runId}>
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
    const open = isRunExpanded(r.runId)
    const statsLine = s ? `${fmtMs(s.ms)} · ${s.calls} agents · ${fmtTok(s.tokens)} tok` : r.done ? '' : 'running…'
    return (
      <div className={`isl-wf-board${doneClass}${open ? ' isl-wf-open' : ''}`} key={r.runId}>
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

  // Reset the Details expand when switching sessions. Skip the initial mount so an app preview restored by App
  // after a hover-close/remount is not immediately cleared before the iframe can reopen.
  useEffect(() => {
    const previousActiveId = previousActiveIdRef.current
    if (previousActiveId === activeId) return
    previousActiveIdRef.current = activeId
    if (!previousActiveId && activeApp) return
    setDetailsOpen(false)
    setDetailRows([])
    setPendingChoiceSelections({})
    setOpenApp(null)
    onActiveAppChange(null)
    onAppViewerToggle?.(false)
  }, [activeId, onActiveAppChange, onAppViewerToggle])

  useEffect(() => {
    setOpenApp(activeApp)
  }, [activeApp])

  // Prewarm the latest app's iframe shortly after it appears — a short settle delay dodges the brief post-deploy
  // 522/propagation window the doctrine warns about (a prewarm landing inside it could cache a transient error).
  // When an app is actually opened we arm immediately (correctness beats the dodge).
  useEffect(() => {
    if (!warmAppUrl) {
      setWarmArmed(false)
      return
    }
    if (openApp) {
      setWarmArmed(true)
      return
    }
    setWarmArmed(false)
    const t = window.setTimeout(() => setWarmArmed(true), 2500)
    return () => window.clearTimeout(t)
  }, [warmAppUrl, openApp])

  useEffect(() => {
    if (!editingId) return
    const el = renameInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [editingId])

  useLayoutEffect(() => {
    if (openApp) return
    const restoreTop = appReturnScrollTopRef.current
    if (restoreTop == null) return
    appReturnScrollTopRef.current = null
    const restore = (): void => {
      if (feedRef.current) feedRef.current.scrollTop = restoreTop
    }
    restore()
    const frame = window.requestAnimationFrame(restore)
    return () => window.cancelAnimationFrame(frame)
  }, [openApp])

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

  // The Terminal button opens the REAL macOS Terminal (read-only) in one click. No toggle/close state — the user
  // closes the Terminal window themselves.
  const openTerminal = (): void => {
    if (activeId) void window.agentOS?.terminalOpenExternal?.(activeId).catch(() => {})
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
  // Right-click an agent tab → the native macOS menu (Rename / Archive). Blitz '0' has no menu (can't be
  // renamed/archived). Hold the island open across the menu's lifecycle so dismissing it can't retract the island.
  const openTabMenu = (sessionId: string, title: string, tabIndex: number): void => {
    if (sessionId === '0') return
    onSelectPage(tabIndex + 1) // act on the tab you right-clicked
    onHoldOpen?.()
    void window.agentOS?.agentTabMenu?.({ isPrimary: false }).then((action) => {
      onHoldOpen?.()
      if (action === 'rename') startRename(sessionId, title)
      else if (action === 'archive') onArchiveAgent(sessionId)
    })
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
      {/* The message bar is HIDDEN during the grant mini-onboarding — the grant card owns the island then. */}
      {!onboarding && (
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
      )}
      {/* Keep the attach panel mounted+open during onboarding (it renders the grant card), even if attach was toggled. */}
      <div className={`isl-attach-wrap${attachOpen || onboarding ? ' open' : ''}`} aria-hidden={!attachOpen && !onboarding}>
        <div className="isl-attach-inner">
          <AttachPanel activeSessionId={activeId ?? ''} />
        </div>
      </div>
    </>
  )

  const showAppViewer = (part: IslandAppMessagePart): void => {
    const normalized = normalizedBlitzAppPart(part)
    if (!normalized) return
    appReturnScrollTopRef.current = feedRef.current?.scrollTop ?? null
    setOpenApp(normalized)
    onActiveAppChange(normalized)
    if (attachOpen) onToggleAttach()
    onAppViewerToggle?.(true)
  }
  const closeAppViewer = (): void => {
    setOpenApp(null)
    onActiveAppChange(null)
    onAppViewerToggle?.(false)
  }

  // Keep the SELECTED tab in view: spawning a new agent (the "+") appends its chip at the far right and selects it,
  // but a left-scrolled rail would leave that chip off-screen with no visible feedback. On every selection change
  // (new agent, click, or Ctrl+Tab) smooth-scroll the rail just far enough that the active chip clears both edges —
  // so the strip visibly slides to the tab you land on. Honors prefers-reduced-motion (jumps instead of animating).
  useEffect(() => {
    const rail = tabRailRef.current
    if (!rail) return
    const chip = rail.querySelector<HTMLElement>('.isl-chip.active')
    if (!chip) return
    const railRect = rail.getBoundingClientRect()
    const chipRect = chip.getBoundingClientRect()
    const PAD = 8 // breathing room so the chip never sits flush against the clipped edge
    let delta = 0
    if (chipRect.left < railRect.left + PAD) delta = chipRect.left - (railRect.left + PAD)
    else if (chipRect.right > railRect.right - PAD) delta = chipRect.right - (railRect.right - PAD)
    if (delta === 0) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    rail.scrollTo({ left: rail.scrollLeft + delta, behavior: reduce ? 'auto' : 'smooth' })
  }, [page, sessions.length])

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
      {/* The agent tabs scroll INSIDE this rail; the new-chat + is a sibling pinned to the RIGHT (Chrome-style),
          so it stays visible no matter how many tabs there are — the tabs scroll under it instead of pushing it off. */}
      <div className="isl-tab-rail" ref={tabRailRef}>
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
              openTabMenu(s.id, s.title, i)
            }}
            title={s.id === '0' ? 'Blitz' : 'Right-click for options'}
          >
            <span className="isl-chip-album" style={{ background: agentGradient(s.id) }} aria-hidden />
            <span className="isl-chip-label">{s.title}</span>
            <span className="isl-chip-dot" data-status={dotStatus(s.status)} aria-hidden />
          </button>
        )
      })}
      </div>
      <button
        type="button"
        aria-label="New chat"
        title="New chat"
        className="isl-chip isl-chip-new"
        onClick={onNewAgent}
      >
        <svg className="isl-pen" viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d={PLUS_PATH} fill="currentColor" />
        </svg>
      </button>
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
  // fit (still scrollable + bottom-pinned). Locks the height while the attach panel is open in any agent chat.
  // During onboarding we don't floor the height to the pre-attach height (the chat is hidden), so the island shrinks
  // to fit just the grant card instead of leaving a tall empty gap above it.
  const lockHeight = attachOpen && !onboarding ? closedHeightRef.current ?? undefined : undefined
  const lastVisibleTurnIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === 'user') {
        const previous = messages[i - 1]
        if (previous?.role === 'agent' && matchingChoiceAnswerForMessage(previous, message.text)) return i - 1
        return i
      }
    }
    return -1
  })()
  const latestDetail = detailRows[detailRows.length - 1]?.label
  // On error, the SPECIFIC problem Claude reported ("Network error" / "Usage limit reached") wins over a stale
  // tool-row label or the generic "Problem", so the user sees what actually broke.
  const inlineDetailText = errorDetail?.title || latestDetail || (dotStatus(status) === 'idle' ? statusLabel(status) : `${statusLabel(status)}…`)
  const showInlineDetails = Boolean(activeId && (errorDetail || latestDetail || dotStatus(status) !== 'idle' || detailsOpen))
  const inlineDetails = showInlineDetails ? (
    <div className={`isl-inline-details${detailsOpen ? ' open' : ''}${errorDetail ? ' has-error' : ''}`} data-status={dotStatus(status)}>
      <button type="button" className="isl-inline-details-summary" onClick={toggleDetails}>
        <span className="isl-inline-status-dot" aria-hidden />
        <span className="isl-inline-details-text">{inlineDetailText}</span>
        <span className="isl-inline-details-caret" aria-hidden>
          {detailsOpen ? '▾' : '›'}
        </span>
      </button>
      {/* On error: a one-line "what to do" hint + a Retry (only when a plain retry makes sense — not for auth /
          usage-limit / full-context, where retrying won't help). Always visible (not gated by the steps expand) so
          the user is never left in the dark about a problem. */}
      {errorDetail && (errorDetail.hint || (errorDetail.retryable && onRetry)) && (
        <div className="isl-inline-error">
          {errorDetail.hint && <span className="isl-inline-error-hint">{errorDetail.hint}</span>}
          {errorDetail.retryable && onRetry && (
            <button type="button" className="isl-inline-retry" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
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
  // The persistent app iframe. Mounted whenever there is a warm url (an open app, or — once armed — the latest
  // card to prewarm), and promoted to the foreground via `.viewing` only when an app is actually open. The src is
  // the SAME across prewarm -> open -> close for one app, so revealing it never remounts the iframe: instant.
  const appLayer =
    warmAppUrl && (openApp || warmArmed) ? (
      <div
        className={`isl-app-viewer isl-app-warm${openApp ? ' viewing' : ''}`}
        data-tone={openApp?.tone}
        data-loaded={appViewerReady ? 'true' : 'false'}
        aria-hidden={!openApp}
      >
        <div className="isl-app-scroll">
          <iframe
            className="isl-app-frame"
            title="Generated app"
            src={warmAppUrl}
            scrolling="auto"
            sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
            onLoad={() => setAppLoadedUrl(warmAppUrl)}
          />
        </div>
        {openApp && !appViewerReady && (
          <div className="isl-app-loading" role="status" aria-live="polite">
            <span className="isl-app-loading-mark" aria-hidden />
            <span className="isl-app-loading-copy">
              <span>Opening app</span>
              <span>{openApp.title}</span>
            </span>
          </div>
        )}
      </div>
    ) : null
  const viewerControls = openApp ? (
    <>
      {openApp.claimUrl && (
        <button
          type="button"
          className="isl-app-viewer-claim"
          aria-label={`Claim ${openApp.title}`}
          title="Keep this app — claim it before it expires"
          onClick={() => {
            if (openApp?.claimUrl) void window.agentOS?.openExternalUrl?.(openApp.claimUrl)
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden focusable="false">
            <path d="M6 3h12v18l-6-4-6 4V3Z" />
          </svg>
          <span>Claim app</span>
        </button>
      )}
      <button type="button" className="isl-app-viewer-close" aria-label="Close generated app" onClick={closeAppViewer}>
        <svg viewBox="0 0 24 24" aria-hidden focusable="false">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </>
  ) : null
  return (
    <div
      ref={panelRef}
      className={`nh-island isl-process${attachOpen || onboarding ? ' isl-attaching' : ''}${openApp ? ' isl-app-viewing' : ''}`}
      style={lockHeight && !openApp ? { paddingTop: top, minHeight: lockHeight } : { paddingTop: top }}
    >
      {appLayer}
      {viewerControls}
      {!openApp && (
        <div className={`isl-tabwrap${attachOpen || onboarding ? ' collapsed' : ''}`}>
          <div className="isl-tabwrap-inner">{tabStrip}</div>
        </div>
      )}
      {!openApp && !onboarding && (
        // The active agent's chat (Blitz '0' or a peer): real messages + inline activity details — KEPT in attach mode.
        <>
          {/* Rename + Archive moved to the tab's native right-click menu (openTabMenu). This row now holds ONLY the
              debug Terminal button, so it renders solely when that debug flag is on — no empty gap for normal users. */}
          {debugTerminalEnabled && activeId && (
            <div className="isl-agent-meta">
              <button
                type="button"
                className="isl-termbtn"
                onClick={openTerminal}
                title="Open the agent terminal (read-only)"
                aria-label="Open the agent terminal"
              >
                <svg viewBox="0 0 24 24" aria-hidden focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M7 10l2.4 2.4L7 14.8" />
                  <path d="M12.5 15H16" />
                </svg>
                <span>Terminal</span>
              </button>
            </div>
          )}
          <div className="isl-feed" ref={feedRef}>
            {messages.length === 0 && runs.length === 0 ? (
              // BRAND-NEW / pre-transcript agent: there's no message bubble to anchor the inline status under yet, but
              // the agent already has a status (warming up, or an error hit during startup). Show that standalone so a
              // fresh chat is never blank+silent — otherwise the user sends a message and sees nothing happening.
              // Only show inline details when NOT idle — avoids stale tool rows from a previous session floating in
              // an otherwise empty chat (loadDetails fires on mount and can return rows from the last agent run).
              (dotStatus(status) !== 'idle' ? inlineDetails : null) || <div className="isl-empty">No messages yet</div>
            ) : (
              <>
                {/* runs that started before any message render at the top; the rest are interleaved below */}
                {leadingRuns.map((r) => renderBoard(r))}
                {messages.map((m, i) => {
                  const previous = messages[i - 1]
                  const askKey = choiceSelectionKey(activeId, i, m.ts, m.text)
                  const selectedAnswer =
                    m.role === 'agent' && messages[i + 1]?.role === 'user'
                      ? matchingChoiceAnswerForMessage(m, messages[i + 1]?.text) || pendingChoiceSelections[askKey]
                      : pendingChoiceSelections[askKey]
                  const isSubmittedAskAnswer =
                    m.role === 'user' && previous?.role === 'agent' && Boolean(matchingChoiceAnswerForMessage(previous, m.text))
                  if (isSubmittedAskAnswer) return null
                  const hasTray = Boolean(trayByIndex[i] && trayByIndex[i]!.length > 0)
                  // The bubble renders the same with or without attachments; only its WRAPPER differs.
                  const bubble = (
                    <MarkdownMessage
                      role={m.role}
                      text={m.text}
                      parts={m.parts}
                      selectedAnswer={selectedAnswer}
                      showDivider={m.role === 'agent' && i > 0}
                      onOpenApp={showAppViewer}
                      onChoose={(choice) => {
                        setPendingChoiceSelections((prev) => ({ ...prev, [askKey]: choice }))
                        window.agentOS?.activity?.track('choice.answered', { agentId: activeId, source: 'notch' })
                        onSend(choice)
                      }}
                    />
                  )
                  return (
                    <Fragment key={`${i}:${m.ts || ''}`}>
                      {hasTray ? (
                        // The frozen snapshot is GROUPED FLUSH with its bubble as ONE scroll unit, so a partial
                        // scroll never leaves an isolated clipped chip floating above a complete message (the strip
                        // itself scrolls sideways, never vertical-clips). See plans/blitzos-connector-snapshot-clip-fix.md.
                        <div className="isl-msg-group">
                          <div className="isl-msg-tray">
                            <AttachTray groups={trayByIndex[i]!} readOnly />
                          </div>
                          {bubble}
                        </div>
                      ) : (
                        bubble
                      )}
                      {i === lastVisibleTurnIndex && inlineDetails}
                      {/* live workflow board(s) anchored right after THIS message (the agent's "running…" line) */}
                      {(runsByAnchor.get(i) || []).map((r) => renderBoard(r))}
                    </Fragment>
                  )
                })}
                {/* No user turn to anchor under (e.g. an agent-only transcript that then errored): trail the inline
                    status at the bottom so a problem still surfaces. (When a user turn exists it renders above.) */}
                {lastVisibleTurnIndex < 0 && inlineDetails}
              </>
            )}
          </div>
        </>
      )}
      {/* the composer + attachment panel are ALWAYS visible. */}
      {!openApp && composerBlock(activeId === '0' ? 'Message Blitz' : 'Steer this agent…', 108, false)}
    </div>
  )
}
