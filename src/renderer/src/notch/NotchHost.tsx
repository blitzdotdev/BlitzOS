// NotchHost — the stateful shell for the island, now wired to REAL agent data (no mock). Rendered via a portal to
// document.body in App.tsx when the island is shown. It:
//   - pulls a one-shot snapshot of all agent sessions on open (agentOS.agents()), then rides the live
//     `os:action {type:'chat'}` broadcast for roster/status/transcript updates.
//   - owns the active page: 1..N = the agent at page-1 (Blitz '0' is page 1); the pen is a spawn button, not a page.
//   - TAB NAV: Ctrl+Tab / Ctrl+Shift+Tab (wrapping the agent tabs 1..N); click switches; swipe scrolls the strip.
//   - the pen button → agentOS.notch.newAgent (spawn a fresh agent + jump to it); sending in any tab →
//     agentOS.sendMessage(text, sessionId) (continue that agent, Blitz '0' included). Sending NEVER spawns.
// It wraps IslandPanel in the invariant BLACK chassis (.nh-chassis), which grows wide when the attach panel opens.
import './notch.css'
import { useEffect, useRef, useState } from 'react'
import { clearStaged } from './stagingStore'
import { usePickSuspended } from './pickSuspendStore'
import { clearLiveTray, dropChat } from './sentTrayStore'
import { onIslandViewRequest } from './islandNavStore'
import { useDoneAgents, clearDone } from './doneStore'
import IslandPanel from './IslandPanel'
import IslandSettings, { type SimStatus } from './IslandSettings'
import IslandOnboarding from './IslandOnboarding'
import type { AgentError, IslandAppMessagePart, IslandSession, IslandMessage, IslandMilestone, IslandTerminalMeta, IslandWfRun, IslandView } from './types'
import { applyWfRun } from '../../../main/wf-run-state.mjs'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const DEBUG_ACTIVE_TERMINAL_KEY = 'blitzos.debug.showActiveAgentTerminal'
const DEBUG_SIMULATE_STATUS_KEY = 'blitzos.debug.simulateStatus' // armed fake status injected on the next send (debug)
// Real (non-debug) preference: workflow kanban boards render expanded by default instead of the collapsed pill.
// Defaults ON (unset key reads true) so workflow always shows; the user can toggle it off in Settings.
const WORKFLOW_ALWAYS_SHOW_KEY = 'blitzos.workflowAlwaysShow'
const AGENT_NAME_MAX = 24

// The chat broadcast / snapshot shapes (subset we use). The host sends raw host statuses + role'd transcripts.
type ChatAction = {
  type: 'chat'
  sessions?: Array<{ id?: unknown; title?: unknown; status?: unknown; lastMessagePreview?: unknown; archivedAt?: unknown }>
  archivedSessions?: Array<{ id?: unknown; title?: unknown; status?: unknown; lastMessagePreview?: unknown; archivedAt?: unknown }>
  threads?: Record<string, Array<{ role?: unknown; text?: unknown; ts?: unknown; parts?: unknown }>>
  status?: Record<string, string>
  errors?: Record<string, AgentError>
}
type AgentMutationResult = { ok?: boolean; error?: string; archived?: boolean; title?: string }
type TerminalAction = {
  type: 'terminal-spawn' | 'terminal-exit' | 'terminal-stop' | 'agent-remove'
  id?: unknown
  exitCode?: unknown
  terminal?: { id?: unknown; title?: unknown; status?: unknown; kind?: unknown }
}
const mapSession = (s: { id?: unknown; title?: unknown; status?: unknown; lastMessagePreview?: unknown; archivedAt?: unknown }): IslandSession => ({
  id: String(s.id),
  title: String(s.title || (String(s.id) === '0' ? 'Blitz' : 'New Agent')),
  status: String(s.status || 'idle'),
  ...(s.lastMessagePreview ? { lastMessagePreview: String(s.lastMessagePreview) } : {}),
  ...(s.archivedAt ? { archivedAt: Number(s.archivedAt) || undefined } : {})
})
const mapTerminal = (t: { id?: unknown; title?: unknown; status?: unknown; kind?: unknown }): IslandTerminalMeta | null => {
  if (t.id == null) return null
  return {
    id: String(t.id),
    title: String(t.title || (String(t.id) === '0' ? 'Blitz' : 'New Agent')),
    status: String(t.status || 'unknown'),
    kind: String(t.kind || 'terminal')
  }
}
const mapAgentTerminals = (raw: unknown[]): Record<string, IslandTerminalMeta> => {
  const out: Record<string, IslandTerminalMeta> = {}
  for (const item of raw) {
    const meta = mapTerminal((item || {}) as { id?: unknown; title?: unknown; status?: unknown; kind?: unknown })
    if (meta && meta.kind === 'agent') out[meta.id] = meta
  }
  return out
}
function readDebugActiveTerminal(): boolean {
  try {
    return window.localStorage.getItem(DEBUG_ACTIVE_TERMINAL_KEY) === '1'
  } catch {
    return false
  }
}
const SIM_STATUS_VALUES: readonly SimStatus[] = ['off', 'connection', 'usage-limit', 'server-error', 'rate-limit', 'auth', 'crash', 'reconnecting']
function readDebugSimulateStatus(): SimStatus {
  try {
    const v = window.localStorage.getItem(DEBUG_SIMULATE_STATUS_KEY) as SimStatus | null
    return v && SIM_STATUS_VALUES.includes(v) ? v : 'off'
  } catch {
    return 'off'
  }
}
function readWorkflowAlwaysShow(): boolean {
  try {
    const v = window.localStorage.getItem(WORKFLOW_ALWAYS_SHOW_KEY)
    return v === null ? true : v === '1' // default ON: an unset preference means workflow boards always show
  } catch {
    return true
  }
}
const cleanAgentName = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, AGENT_NAME_MAX)
type MilestoneAction = { type: 'milestone'; agentId?: string; id?: unknown; ts?: unknown; kind?: string; text?: unknown }
type WfRunAction = { type: 'workflow-run'; runId?: unknown; agentId?: unknown; file?: unknown; started?: unknown; done?: unknown; ok?: unknown; skeleton?: unknown[]; memDir?: unknown }
// Strip the legacy "Attached before you started …" brief that older builds appended to the user's message text
// (it persisted in chat.md). New sends never inject it; this keeps already-persisted messages clean at display.
const stripAttachBrief = (text: string): string => text.replace(/\n+Attached before you started \(drive these with[\s\S]*$/, '').trim()

const mapMessageParts = (value: unknown): IslandMessage['parts'] | undefined => {
  if (!Array.isArray(value)) return undefined
  const parts = value.filter((part) => part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string') as NonNullable<IslandMessage['parts']>
  return parts.length ? parts : undefined
}

const mapThreads = (raw?: Record<string, Array<{ role?: unknown; text?: unknown; ts?: unknown; parts?: unknown }>>): Record<string, IslandMessage[]> => {
  const out: Record<string, IslandMessage[]> = {}
  for (const id of Object.keys(raw || {})) {
    out[id] = (raw![id] || [])
      .map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('agent' as const),
        text: m.role === 'user' ? stripAttachBrief(String(m.text || '')) : String(m.text || ''),
        ts: Number(m.ts) || undefined,
        parts: mapMessageParts(m.parts)
      }))
      .filter((m) => m.text.trim() || m.parts?.length)
  }
  return out
}

export function NotchHost({
  menuBarH,
  visible = true,
  onChassisResize,
  onChassisHoverChange,
  onAttachChange,
  onStateChange,
  initialView = 'session',
  initialPage = 1,
  initialAttachOpen = false,
  initialActiveApp = null,
  onOnboardingComplete,
  onIslandHoldOpen
}: {
  menuBarH: number
  visible?: boolean // false parks the mounted island off visually so app iframes survive hover-close
  onChassisResize?: () => void
  onChassisHoverChange?: (on: boolean) => void
  onAttachChange?: (open: boolean) => void // attach panel (the macOS window picker) opened/closed → App pins the island open
  onStateChange?: (view: IslandView, page: number, attachOpen: boolean, activeApp: IslandAppMessagePart | null) => void // report state so App restores it on the next open
  initialView?: Exclude<IslandView, 'home'> // the view to open into — RESTORED from the last open (NotchHost remounts per open)
  initialPage?: number // the tab to open into (1..N = agent) — also restored from the last open
  initialAttachOpen?: boolean // the attach panel's open/closed state — also restored from the last open
  initialActiveApp?: IslandAppMessagePart | null // generated app preview restored after hover-close/remount
  onOnboardingComplete?: () => void
  onIslandHoldOpen?: () => void // onboarding step changes resize the chassis → re-stamp App's keep-open hold
}): JSX.Element {
  const [view, setView] = useState<IslandView>(initialView)
  const [page, setPage] = useState(initialPage) // 1..N = the agent at page-1 (Blitz '0' is page 1); page 0 retired
  const [attachOpen, setAttachOpen] = useState(initialAttachOpen)
  const [sessions, setSessions] = useState<IslandSession[]>([])
  const [archivedSessions, setArchivedSessions] = useState<IslandSession[]>([])
  const [threads, setThreads] = useState<Record<string, IslandMessage[]>>({})
  const [status, setStatus] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, AgentError>>({}) // per-agent last-problem detail (id -> AgentError)
  const [milestones, setMilestones] = useState<Record<string, IslandMilestone[]>>({})
  const [runs, setRuns] = useState<Record<string, IslandWfRun[]>>({}) // per-agent live workflow runs (inline kanban)
  const [terminals, setTerminals] = useState<Record<string, IslandTerminalMeta>>({})
  const [debugActiveTerminal, setDebugActiveTerminal] = useState(readDebugActiveTerminal)
  const [debugSimStatus, setDebugSimStatus] = useState<SimStatus>(readDebugSimulateStatus)
  const debugSimStatusRef = useRef<SimStatus>(debugSimStatus)
  debugSimStatusRef.current = debugSimStatus
  const [workflowAlwaysShow, setWorkflowAlwaysShow] = useState(readWorkflowAlwaysShow)
  const [activeApp, setActiveApp] = useState<IslandAppMessagePart | null>(initialActiveApp)
  const [appViewerOpen, setAppViewerOpen] = useState(Boolean(initialActiveApp))
  const [peek, setPeek] = useState(false) // the peek (now-playing) view collapses the chat to summaries
  const pendingJump = useRef<string | null>(null) // after a spawn, jump to the new session once it appears
  const activeIdRef = useRef('') // the active chat id, mirrored for the picker arm (computed below the effect)
  const sessionsRef = useRef<IslandSession[]>([])
  const statusRef = useRef<Record<string, string>>({})
  const nRef = useRef(0)
  nRef.current = sessions.length
  sessionsRef.current = sessions

  // Report the island's view + tab up to App so reopening it (hover OR ⌥Space) restores where the user left off,
  // instead of resetting to Home. App stashes these and feeds them back as initialView/initialPage on the next open.
  useEffect(() => {
    onStateChange?.(view, page, attachOpen, activeApp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, page, attachOpen, activeApp])

  // Imperative view nav from out-of-tree (the native menu's "Show Settings" → App → islandNavStore). When the
  // island is already open, App can't change our `view` via the mount-only initialView, so it pushes through here.
  // Switching to settings leaves `page` (the chat tab) untouched, so the exit X lands back on the same tab.
  useEffect(() => onIslandViewRequest((next) => setView(next)), [])

  // Tell the host whenever the chassis SIZE changes (attach panel opens/closes, peek toggles) so its hover-close
  // grace timer holds the island open: a shrink otherwise pulls the chassis out from under the cursor and the
  // host's mousemove handler immediately hides the whole island. Skip the initial mount (no resize yet).
  const firstResizeRef = useRef(true)
  useEffect(() => {
    if (firstResizeRef.current) {
      firstResizeRef.current = false
      return
    }
    onChassisResize?.()
  }, [appViewerOpen, attachOpen, debugActiveTerminal, peek, view]) // view/debug changes resize the chassis too — hold the island open across the transit

  const chooseDebugActiveTerminal = (on: boolean): void => {
    setDebugActiveTerminal(on)
    try {
      window.localStorage.setItem(DEBUG_ACTIVE_TERMINAL_KEY, on ? '1' : '0')
    } catch {
      /* debug-only persistence */
    }
  }
  const chooseDebugSimStatus = (kind: SimStatus): void => {
    setDebugSimStatus(kind)
    try {
      window.localStorage.setItem(DEBUG_SIMULATE_STATUS_KEY, kind)
    } catch {
      /* debug-only persistence */
    }
  }
  const chooseWorkflowAlwaysShow = (on: boolean): void => {
    setWorkflowAlwaysShow(on)
    try {
      window.localStorage.setItem(WORKFLOW_ALWAYS_SHOW_KEY, on ? '1' : '0')
    } catch {
      /* preference persistence is best-effort */
    }
  }
  const applyStatus = (nextStatus: Record<string, string>): void => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }

  // Apply a roster update; if we just spawned a session and it now exists, jump to its tab.
  const applySessions = (arr: IslandSession[]): void => {
    sessionsRef.current = arr
    setSessions(arr)
    if (pendingJump.current) {
      const idx = arr.findIndex((s) => s.id === pendingJump.current)
      if (idx >= 0) {
        setPage(idx + 1)
        pendingJump.current = null
      }
    }
  }

  const applyArchivedSessions = (arr: IslandSession[]): void => {
    setArchivedSessions(arr.filter((s) => s.id !== '0'))
  }

  // Snapshot on open + subscribe to the live chat broadcast.
  useEffect(() => {
    let live = true
    window.agentOS
      ?.agents?.()
      .then((snap) => {
        if (!live || !snap) return
        applySessions((snap.sessions || []).map(mapSession))
        applyArchivedSessions((snap.archivedSessions || []).map(mapSession))
        setThreads(mapThreads(snap.threads))
        applyStatus(snap.status || {})
        setErrors((snap.errors || {}) as Record<string, AgentError>)
        setMilestones((snap.milestones || {}) as Record<string, IslandMilestone[]>)
        setRuns((snap.runs || {}) as Record<string, IslandWfRun[]>)
      })
      .catch(() => {
        /* no host yet */
      })
    const off = window.agentOS?.onAction?.((a: unknown) => {
      const act = a as ChatAction | MilestoneAction | WfRunAction
      if (!act) return
      if (act.type === 'chat') {
        if (Array.isArray(act.sessions)) applySessions(act.sessions.map(mapSession))
        if (Array.isArray(act.archivedSessions)) applyArchivedSessions(act.archivedSessions.map(mapSession))
        if (act.threads) setThreads(mapThreads(act.threads))
        if (act.status) applyStatus(act.status)
        // errors rides the same chat broadcast as status (host updateChatHubState). An override-only push (the wake
        // watchdog's status map) omits it, so a missing field LEAVES the current detail; an empty {} CLEARS it.
        if (act.errors) setErrors(act.errors)
      } else if (act.type === 'milestone' && act.agentId) {
        const text = String(act.text || '').trim()
        if (!text) return
        const m: IslandMilestone = {
          id: String(act.id),
          ts: Number(act.ts) || Date.now(),
          kind: (act.kind as IslandMilestone['kind']) || 'step',
          text
        }
        const aid = String(act.agentId)
        setMilestones((prev) => {
          const list = prev[aid] || []
          if (list.some((x) => x.id === m.id)) return prev
          return { ...prev, [aid]: [...list, m].slice(-60) }
        })
      } else if (act.type === 'workflow-run') {
        // The island's inline kanban board: a run started or finished for an agent. Fold through the SAME
        // applyWfRun rule the main registry uses, so a late skeleton-bearing `started` UPSERTS the skeleton (the
        // live board gains its TODO cards) without un-finishing a run that already received its `done`.
        const runId = String((act as WfRunAction).runId || '')
        const aid = String((act as WfRunAction).agentId ?? '0')
        if (!runId) return
        setRuns((prev) => {
          const list = prev[aid] || []
          const existing = list.find((r) => r.runId === runId)
          const next = applyWfRun(existing, act as unknown as Record<string, unknown>) as IslandWfRun | null
          if (!next) return prev
          const nextList = existing ? list.map((r) => (r.runId === runId ? next : r)) : [...list, next]
          return { ...prev, [aid]: nextList }
        })
      }
    })
    return () => {
      live = false
      try {
        off?.()
      } catch {
        /* best-effort */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The active tab's agent id (mirrors the activeId computed in the render body below). Derived here so the load
  // effect can key on this STRING — firing only on a real tab change, not on every chat broadcast (each makes a
  // fresh `sessions` array, which would otherwise re-fire the IPC + reload on every message).
  const activeTabIdx = clamp(page, 0, sessions.length)
  const activeTabId = activeTabIdx === 0 ? '' : sessions[activeTabIdx - 1]?.id || ''
  // Load an agent's persisted + live workflow boards whenever its tab becomes active, and ping "viewed" so the
  // board memory-eviction sweep keeps it cached. Disk is the source of truth (index.json + events.jsonl), so this
  // pulls back runs that were evicted from memory or survived a relaunch — finished boards never vanish. Merges
  // (never clobbers) any in-flight run that arrived via a live broadcast but isn't yet in the loaded list.
  useEffect(() => {
    const id = activeTabId
    if (!id) return
    let live = true
    try { window.agentOS?.tabViewed?.(id) } catch { /* best-effort */ }
    window.agentOS
      ?.wfLoadAgentRuns?.(id)
      .then((list: Array<Record<string, unknown>>) => {
        if (!live || !Array.isArray(list)) return
        const loaded = list as unknown as IslandWfRun[]
        setRuns((prev) => {
          const byId = new Map<string, IslandWfRun>()
          for (const r of prev[id] || []) byId.set(r.runId, r) // keep in-flight runs (live-broadcast race)
          for (const r of loaded) {
            const cur = byId.get(r.runId)
            if (!cur) { byId.set(r.runId, r); continue }
            // A `done`/skeleton-bearing broadcast can reach the RENDERER before main's osLoadAgentRuns read its
            // registry, so the loaded (disk) row may be STALER than the live one. Merge with the same invariants
            // applyWfRun enforces: a run never un-finishes, and a non-empty skeleton is never dropped. (A raw
            // overwrite reintroduced exactly the "live board reverts to running / loses its TODO cards" class.)
            byId.set(r.runId, {
              ...r,
              done: cur.done || r.done,
              ok: cur.done ? cur.ok : r.ok,
              skeleton: cur.skeleton && cur.skeleton.length ? cur.skeleton : r.skeleton,
              startedAt: cur.startedAt || r.startedAt,
              memDir: r.memDir || cur.memDir
            })
          }
          return { ...prev, [id]: [...byId.values()].sort((a, b) => a.startedAt - b.startedAt) }
        })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [activeTabId])

  // Clear an agent's "unseen DONE" glance pip once the user actually VIEWS it: the island is open (visible) and this
  // agent's chat (IslandPanel, i.e. not the settings/onboarding view) is the active tab. Covers a tab click
  // (activeTabId changes), opening straight onto an already-active agent (visible flips), and an agent finishing
  // while you are already looking at it (doneAgents changes). The pip only ever shows in the COLLAPSED bar, so
  // clearing on view means it is gone before the next collapse — no stale pip.
  const doneAgents = useDoneAgents()
  const showingAgentChat = view !== 'settings' && view !== 'onboarding'
  useEffect(() => {
    if (!visible || !showingAgentChat || !activeTabId) return
    if (doneAgents.has(activeTabId)) clearDone(activeTabId)
  }, [visible, showingAgentChat, activeTabId, doneAgents])

  // Tell App when the attach panel opens/closes so it can pin the island open (the picker needs the cursor to roam
  // off the chassis onto other windows). Reset on unmount so a closed island never stays pinned.
  useEffect(() => {
    onAttachChange?.(attachOpen)
    return () => onAttachChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachOpen])

  // Window picker: while the attach panel is open, the computer-use helper highlights the macOS window under the
  // cursor and lets you drag its app icon into the drop-zone (.att-drop) to connect it. Arm it with the drop-zone's
  // ON-SCREEN rect, re-measuring across the open transition (the chassis grows + the panel expands, so the rect
  // settles a few frames late). Cleanup (panel closed / island unmounted) disarms the overlay.
  const pickSuspended = usePickSuspended()
  useEffect(() => {
    const pick = window.agentOS?.pick
    if (!pick) return
    const stop = (): void => {
      try {
        void pick.stop()
      } catch {
        /* best-effort */
      }
    }
    // The picker is armed ONLY while attach is open AND not suspended by a grant flow. In EVERY other state — attach
    // closed via the X, a grant card up, the island unmounting — the overlay MUST come down. The old guard returned
    // early WITHOUT stopping, so a close that happened while the picker was suspended left the overlay stuck on
    // screen (the "X doesn't clear it" bug). Stop unconditionally here for the non-armed states.
    if (!attachOpen || pickSuspended) {
      stop()
      return
    }
    let stopped = false
    // viewport rect → on-screen rect (top-left global points; the overlay window's origin + the element offset).
    const measure = (sel: string): { x: number; y: number; w: number; h: number } | null => {
      const el = document.querySelector(sel) as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return null
      return { x: window.screenX + r.left, y: window.screenY + r.top, w: r.width, h: r.height }
    }
    const arm = (): void => {
      if (stopped) return
      const drop = measure('.att-drop') // releasing a drag here = drop
      const self = measure('.nh-chassis') // the whole island chrome — never grab a window behind it
      if (drop && self) void pick.start(drop, self, activeIdRef.current) // the dropped window is owned by the active chat
    }
    // re-measure across the 0.32s chassis-grow transition (+ settle margin) so the on-screen rect is final.
    const raf = requestAnimationFrame(arm)
    const timers = [200, 460, 720].map((ms) => window.setTimeout(arm, ms))
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      timers.forEach(clearTimeout)
      stop()
    }
  }, [attachOpen, pickSuspended])

  // Track managed agent terminals for the debug pane. The active agent id is the canonical terminal id, but the
  // metadata gives the pane a title/status and lets terminal lifecycle actions update without reopening surfaces.
  useEffect(() => {
    let live = true
    const refreshTerminals = (): void => {
      Promise.resolve(window.agentOS?.terminalList?.() ?? [])
        .then((list) => {
          if (!live || !Array.isArray(list)) return
          setTerminals(mapAgentTerminals(list))
        })
        .catch(() => {
          /* terminal debug pane remains best-effort */
        })
    }
    refreshTerminals()
    const off = window.agentOS?.onAction?.((a: unknown) => {
      const act = a as TerminalAction
      if (!act) return
      if (act.type === 'terminal-spawn') {
        const fromPayload = mapTerminal({
          id: act.id ?? act.terminal?.id,
          title: act.terminal?.title,
          status: act.terminal?.status,
          kind: act.terminal?.kind
        })
        if (fromPayload && fromPayload.kind === 'agent') setTerminals((prev) => ({ ...prev, [fromPayload.id]: fromPayload }))
        refreshTerminals()
      } else if (act.type === 'terminal-exit' || act.type === 'terminal-stop') {
        const id = act.id == null ? '' : String(act.id)
        if (id) {
          setTerminals((prev) => {
            const cur = prev[id]
            return cur ? { ...prev, [id]: { ...cur, status: 'exited' } } : prev
          })
        }
        refreshTerminals()
      } else if (act.type === 'agent-remove') {
        const id = act.id == null ? '' : String(act.id)
        if (id) {
          dropChat(id) // a closed agent's frozen attachment snapshot must not resurface on a future agent that reuses its id (archive does NOT fire agent-remove, so archived chats keep theirs)
          setTerminals((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
        }
      }
    })
    return () => {
      live = false
      try {
        off?.()
      } catch {
        /* best-effort */
      }
    }
  }, [])

  // Tab navigation by KEYBOARD: Ctrl+Tab → next, Ctrl+Shift+Tab → prev, wrapping the agent tabs (1..N).
  // Disabled while the attachment panel is open. (Swipe just scrolls the strip; it never pages.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (attachOpen) return // while the attach panel is open, don't shuffle tabs underneath it (peek keeps tabs live)
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const total = nRef.current
        if (total <= 0) return
        setPage((p) => ((clamp(p, 1, total) - 1 + (e.shiftKey ? total - 1 : 1)) % total) + 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [attachOpen])

  const displaySessions = sessions.map((s) => ({ ...s, status: status[s.id] || s.status }))
  const N = displaySessions.length
  const safePage = N === 0 ? 0 : clamp(page, 1, N) // pages are 1..N (agents); page 0 (the old composer) is retired
  const activeIndex = safePage === 0 ? -1 : safePage - 1
  const activeSession = activeIndex >= 0 ? displaySessions[activeIndex] : null
  const activeId = activeSession?.id
  activeIdRef.current = activeId ?? '' // '' only in the transient no-agent state (pre-boot); normally the active agent
  const messages = activeId ? threads[activeId] || [] : []
  const activeMilestones = activeId ? milestones[activeId] || [] : []
  const activeRuns = activeId ? runs[activeId] || [] : []
  const activeStatus = activeId ? status[activeId] || activeSession?.status || 'idle' : 'idle'
  const activeError = activeId ? errors[activeId] : undefined
  // Retry after a (retryable) error: a gentle nudge re-wakes the agent and, being a user message, clears the sticky
  // 'error' status. Goes through the normal send path (NOT the debug intercept), so a simulated error clears too.
  const onRetryAgent = (): void => {
    if (!activeId) return
    try {
      window.agentOS?.sendMessage?.('Please try that again.', activeId)
    } catch {
      /* no bridge */
    }
  }

  const goPage = (next: number): void => {
    const nextPage = N === 0 ? 0 : clamp(next, 1, N)
    const nextSession = nextPage > 0 ? displaySessions[nextPage - 1] : null
    if (nextSession?.id) window.agentOS?.activity?.track('agent.selected', { agentId: nextSession.id, source: 'notch' })
    setPage(nextPage)
  }
  const requestArchiveAgent = (id: string): Promise<AgentMutationResult> => {
    if (window.agentOS?.archiveAgent) return window.agentOS.archiveAgent(id)
    if (window.agentOS?.chatControl) return window.agentOS.chatControl('archive', { id }) as Promise<AgentMutationResult>
    return Promise.resolve({ ok: false, error: 'archive bridge unavailable' })
  }
  const requestRestoreAgent = (id: string): Promise<AgentMutationResult> => {
    if (window.agentOS?.unarchiveAgent) return window.agentOS.unarchiveAgent(id)
    if (window.agentOS?.chatControl) return window.agentOS.chatControl('unarchive', { id }) as Promise<AgentMutationResult>
    return Promise.resolve({ ok: false, error: 'restore bridge unavailable' })
  }
  const moveSessionToArchive = (id: string): void => {
    const session = sessions.find((s) => s.id === id)
    if (!session) return
    const archivedAt = session.archivedAt || Date.now()
    const localPreview = [...(threads[id] || [])]
      .reverse()
      .find((m) => String(m.text || '').trim())
      ?.text.replace(/\s+/g, ' ')
      .trim()
    const archived: IslandSession = { ...session, status: status[id] || session.status, lastMessagePreview: session.lastMessagePreview || localPreview, archivedAt }
    setSessions((prev) => prev.filter((s) => s.id !== id))
    setArchivedSessions((prev) => (prev.some((s) => s.id === id) ? prev.map((s) => (s.id === id ? archived : s)) : [...prev, archived]))
    setPage(0)
  }
  const moveSessionFromArchive = (id: string): void => {
    const session = archivedSessions.find((s) => s.id === id)
    if (!session) return
    const restored: IslandSession = { id: session.id, title: session.title, status: status[id] || session.status }
    setArchivedSessions((prev) => prev.filter((s) => s.id !== id))
    setSessions((prev) => {
      const next = prev.some((s) => s.id === id) ? prev.map((s) => (s.id === id ? restored : s)) : [...prev, restored]
      const idx = next.findIndex((s) => s.id === id)
      if (idx >= 0) setPage(idx + 1)
      return next
    })
    setView('session')
  }
  const archiveAgent = (id: string): void => {
    if (id === '0') return
    if (!sessions.some((s) => s.id === id)) return
    requestArchiveAgent(id)
      .then((r) => {
        if (r?.ok) {
          if (pendingJump.current === id) pendingJump.current = null
          moveSessionToArchive(id)
        } else {
          console.warn('[notch] archive failed', r?.error || id)
        }
      })
      .catch((e) => {
        console.warn('[notch] archive failed', e)
      })
  }
  const restoreAgent = (id: string): void => {
    if (id === '0') return
    pendingJump.current = id
    requestRestoreAgent(id)
      .then((r) => {
        if (r?.ok) moveSessionFromArchive(id)
        else {
          if (pendingJump.current === id) pendingJump.current = null
          console.warn('[notch] restore failed', r?.error || id)
        }
      })
      .catch((e) => {
        if (pendingJump.current === id) pendingJump.current = null
        console.warn('[notch] restore failed', e)
      })
  }
  const deleteArchivedAgent = (id: string): void => {
    if (id === '0') return
    window.agentOS
      ?.closeAgent?.(id)
      .then((r) => {
        if (r?.ok) {
          if (pendingJump.current === id) pendingJump.current = null
          setArchivedSessions((prev) => prev.filter((s) => s.id !== id))
        }
      })
      .catch(() => {
        /* delete failed; leave it in the archived list */
      })
  }
  const renameAgent = (id: string, title: string): Promise<boolean> => {
    const next = cleanAgentName(title)
    if (!id || !next) return Promise.resolve(false)
    const request =
      window.agentOS?.renameAgent?.(id, next) ??
      (window.agentOS?.chatControl?.('rename', { id, title: next }) as Promise<AgentMutationResult> | undefined)
    if (!request) return Promise.resolve(false)
    return request
      .then((r) => {
        if (!r?.ok) {
          console.warn('[notch] rename failed', r?.error || id)
          return false
        }
        const saved = cleanAgentName((r as AgentMutationResult).title || next)
        setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: saved } : s)))
        setArchivedSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: saved } : s)))
        return true
      })
      .catch((e) => {
        console.warn('[notch] rename failed', e)
        return false
      })
  }

  // page 0 (pen) = spawn a NEW session; an agent tab = steer that session. Both are real (no mock append).
  const onSend = (text: string): void => {
    // Always routes to the ACTIVE agent (Blitz '0' or a peer) — sending NEVER spawns. A new agent comes only from
    // the pen button (onNewAgent). Close the attach staging immediately; the staged sources rode this message (chips).
    setAttachOpen(false)
    // Clear staging under whatever key was used — including '' (the transient pre-boot composer). Hoisted
    // above the early-return so the '' key is always wiped even when no live agent is present.
    const clearKey = activeId ?? ''
    clearStaged(clearKey)
    clearLiveTray(clearKey) // IslandPanel already froze the tray onto this message; drop the mirror so it can't re-attach next send
    if (!activeId) return // no live agent yet (transient, pre-boot) — never blind-spawn on a send
    // DEBUG: while a fake status is armed (Settings → Simulate agent status), the send injects that status onto the
    // active agent instead of reaching it — so the four status surfaces can be eyeballed. Pick Off to resume normal.
    const sim = debugSimStatusRef.current
    if (sim !== 'off') {
      try {
        window.agentOS?.debugForceStatus?.(activeId, sim)
      } catch {
        /* debug-only bridge */
      }
      return
    }
    try {
      window.agentOS?.sendMessage?.(text, activeId)
    } catch {
      /* no bridge */
    }
  }

  const togglePeek = (): void => {
    setPeek((v) => !v)
    setAttachOpen(false)
  }
  const handleActiveAppChange = (app: IslandAppMessagePart | null): void => {
    setActiveApp(app)
    setAppViewerOpen(Boolean(app))
    onStateChange?.(view, page, attachOpen, app)
  }
  const handleAppViewerToggle = (open: boolean): void => {
    setAppViewerOpen(open)
    window.agentOS?.activity?.track(open ? 'app_card.opened' : 'app_card.closed', {
      agentId: activeIdRef.current || undefined,
      source: 'notch'
    })
    holdChassisHover()
    if (open) {
      setPeek(false)
      setAttachOpen(false)
    }
    onChassisResize?.()
    window.setTimeout(() => onChassisResize?.(), 220)
  }

  const dataView = view === 'settings' ? 'settings' : view === 'onboarding' ? 'onboarding' : safePage === 0 ? 'session' : 'process'
  const holdChassisHover = (): void => onChassisHoverChange?.(true)
  const openChat = (): void => {
    holdChassisHover()
    // Chat → Blitz ('0'); sending there continues '0', it never spawns. ('0' is always present once booted.)
    const i = sessionsRef.current.findIndex((s) => s.id === '0')
    setPage(i >= 0 ? i + 1 : 1)
    setPeek(false)
    setAttachOpen(false)
    setView('session')
  }
  // Pen "new session" button: spawn a fresh agent immediately and jump into its tab once it appears (pendingJump).
  const onNewAgent = (): void => {
    holdChassisHover()
    setPeek(false)
    setAttachOpen(false)
    setView('session')
    window.agentOS
      ?.notch?.newAgent?.()
      .then((r) => {
        if (!r?.ok || r.id == null) return
        pendingJump.current = String(r.id)
        // Proactively refresh the roster so the new agent appears (and pendingJump fires → setPage) RIGHT NOW,
        // instead of waiting on the live chat broadcast. The broadcast is still the backstop if it lands first.
        window.agentOS
          ?.agents?.()
          .then((snap) => {
            if (snap) applySessions((snap.sessions || []).map(mapSession))
          })
          .catch(() => {})
      })
      .catch(() => {
        /* spawn failed; the chat error surfaces in the host */
      })
  }
  return (
    <div className="nhost" data-view={dataView} data-visible={visible ? 'true' : 'false'}>
      <div
        className={`nh-chassis${!visible ? ' nh-parked' : ''}${attachOpen ? ' nh-wide' : ''}${appViewerOpen ? ' nh-app-viewing' : ''}`}
        data-view={dataView}
        aria-hidden={!visible}
        onPointerEnter={holdChassisHover}
        onPointerMove={holdChassisHover}
        onPointerDownCapture={holdChassisHover}
        onPointerLeave={() => onChassisHoverChange?.(false)}
      >
        {view === 'settings' ? (
          <IslandSettings
            menuBarH={menuBarH}
            workflowAlwaysShow={workflowAlwaysShow}
            onToggleWorkflowAlwaysShow={chooseWorkflowAlwaysShow}
            showActiveTerminal={debugActiveTerminal}
            onToggleActiveTerminal={chooseDebugActiveTerminal}
            simulateStatus={debugSimStatus}
            onSimulateStatus={chooseDebugSimStatus}
            archivedSessions={archivedSessions}
            onRestoreAgent={restoreAgent}
            onDeleteAgent={deleteArchivedAgent}
            onClose={() => {
              holdChassisHover()
              setView('session') // back to the chat tab the user was on (page is untouched; draft is in draftStore)
            }}
          />
        ) : view === 'onboarding' ? (
          <IslandOnboarding
            menuBarH={menuBarH}
            onHoldOpen={onIslandHoldOpen}
            onComplete={() => {
              setAttachOpen(false)
              setPeek(false)
              // Land in Blitz's chat ('0'), not the home grid — mirror openChat.
              const i = sessionsRef.current.findIndex((s) => s.id === '0')
              setPage(i >= 0 ? i + 1 : 1)
              if (i < 0) {
                // '0' hasn't reached the roster yet (boot race) — jump to it once it appears, and refresh now
                // so the chat fills in instead of sitting on a blank page (mirror onNewAgent's pendingJump).
                pendingJump.current = '0'
                window.agentOS
                  ?.agents?.()
                  .then((snap) => {
                    if (snap) applySessions((snap.sessions || []).map(mapSession))
                  })
                  .catch(() => {})
              }
              setView('session')
              onOnboardingComplete?.()
            }}
          />
        ) : (
          <IslandPanel
            sessions={displaySessions}
            page={safePage}
            onSelectPage={goPage}
            onNewAgent={onNewAgent}
            messages={messages}
            milestones={activeMilestones}
            runs={activeRuns}
            status={activeStatus}
            errorDetail={activeError}
            onRetry={onRetryAgent}
            activeId={activeId}
            peek={peek}
            onSend={onSend}
            menuBarH={menuBarH}
            attachOpen={attachOpen}
            onToggleAttach={() => setAttachOpen((v) => !v)}
            activeApp={activeApp}
            onActiveAppChange={handleActiveAppChange}
            onAppViewerToggle={handleAppViewerToggle}
            debugTerminalEnabled={debugActiveTerminal}
            activeTerminal={activeId ? terminals[activeId] : undefined}
            onArchiveAgent={archiveAgent}
            onRenameAgent={renameAgent}
            onHoldOpen={onIslandHoldOpen}
            alwaysShowWorkflow={workflowAlwaysShow}
          />
        )}
      </div>
    </div>
  )
}

export default NotchHost
