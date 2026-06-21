// NotchHost — the stateful shell for the island, now wired to REAL agent data (no mock). Rendered via a portal to
// document.body in App.tsx when the island is shown. It:
//   - pulls a one-shot snapshot of all agent sessions on open (agentOS.agents()), then rides the live
//     `os:action {type:'chat'}` broadcast for roster/status/transcript updates.
//   - owns the active page: 0 = the new-session (pen) tab; 1..N = the agent at page-1.
//   - TAB NAV: Ctrl+Tab / Ctrl+Shift+Tab (wrapping the pen tab + agents); click switches; swipe scrolls the strip.
//   - steers / spawns for real: page 0 → agentOS.notch.send (spawn a new session); an agent tab →
//     agentOS.sendMessage(text, sessionId) (steer that agent).
// It wraps IslandPanel in the invariant BLACK chassis (.nh-chassis), which grows wide when the attach panel opens.
import './notch.css'
import { useEffect, useRef, useState } from 'react'
import { clearStaged } from './stagingStore'
import IslandPanel from './IslandPanel'
import IslandHome from './IslandHome'
import IslandSettings from './IslandSettings'
import type { IslandSession, IslandMessage, IslandMilestone, IslandTerminalMeta, IslandWfRun } from './types'
import { applyWfRun } from '../../../main/wf-run-state.mjs'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const DEBUG_ACTIVE_TERMINAL_KEY = 'blitzos.debug.showActiveAgentTerminal'
const AGENT_NAME_MAX = 24

// peek toggle glyphs: compress (corners in → enter peek) / expand (corners out → back to chat).
const PEEK_IN = 'M5 9h4a1 1 0 0 0 1-1V4M19 9h-4a1 1 0 0 1-1-1V4M5 15h4a1 1 0 0 1 1 1v4M19 15h-4a1 1 0 0 0-1 1v4'
const PEEK_OUT = 'M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4'
const SETTINGS_PATH =
  'M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5ZM19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-.6a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 .6-1a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 .6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.18.35.39.68.6 1H20a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-.5 1Z'

// The chat broadcast / snapshot shapes (subset we use). The host sends raw host statuses + role'd transcripts.
type ChatAction = {
  type: 'chat'
  sessions?: Array<{ id?: unknown; title?: unknown; status?: unknown; lastMessagePreview?: unknown; archivedAt?: unknown }>
  archivedSessions?: Array<{ id?: unknown; title?: unknown; status?: unknown; lastMessagePreview?: unknown; archivedAt?: unknown }>
  threads?: Record<string, Array<{ role?: unknown; text?: unknown; ts?: unknown }>>
  status?: Record<string, string>
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
  title: String(s.title || `Chat ${s.id}`),
  status: String(s.status || 'idle'),
  ...(s.lastMessagePreview ? { lastMessagePreview: String(s.lastMessagePreview) } : {}),
  ...(s.archivedAt ? { archivedAt: Number(s.archivedAt) || undefined } : {})
})
const mapTerminal = (t: { id?: unknown; title?: unknown; status?: unknown; kind?: unknown }): IslandTerminalMeta | null => {
  if (t.id == null) return null
  return {
    id: String(t.id),
    title: String(t.title || `Agent ${t.id}`),
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
const cleanAgentName = (value: string): string => value.replace(/\s+/g, ' ').trim().slice(0, AGENT_NAME_MAX)
type MilestoneAction = { type: 'milestone'; agentId?: string; id?: unknown; ts?: unknown; kind?: string; text?: unknown }
type WfRunAction = { type: 'workflow-run'; runId?: unknown; agentId?: unknown; file?: unknown; started?: unknown; done?: unknown; ok?: unknown; skeleton?: unknown[]; memDir?: unknown }
// Strip the legacy "Attached before you started …" brief that older builds appended to the user's message text
// (it persisted in chat.md). New sends never inject it; this keeps already-persisted messages clean at display.
const stripAttachBrief = (text: string): string => text.replace(/\n+Attached before you started \(drive these with[\s\S]*$/, '').trim()

const mapThreads = (
  raw?: Record<string, Array<{ role?: unknown; text?: unknown; ts?: unknown }>>
): Record<string, IslandMessage[]> => {
  const out: Record<string, IslandMessage[]> = {}
  for (const id of Object.keys(raw || {})) {
    out[id] = (raw![id] || [])
      .map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('agent' as const), text: m.role === 'user' ? stripAttachBrief(String(m.text)) : String(m.text), ts: Number(m.ts) || undefined }))
      .filter((m) => m.text.trim())
  }
  return out
}

export function NotchHost({
  menuBarH,
  onChassisResize,
  onChassisHoverChange,
  onAttachChange,
  onStateChange,
  initialView = 'home',
  initialPage = 0,
  initialAttachOpen = false
}: {
  menuBarH: number
  onChassisResize?: () => void
  onChassisHoverChange?: (on: boolean) => void
  onAttachChange?: (open: boolean) => void // attach panel (the macOS window picker) opened/closed → App pins the island open
  onStateChange?: (view: 'home' | 'settings' | 'session', page: number, attachOpen: boolean) => void // report view+page+attach so App restores it on the next open
  initialView?: 'home' | 'settings' | 'session' // the view to open into — RESTORED from the last open (NotchHost remounts per open)
  initialPage?: number // the tab to open into (0 = composer, 1..N = agent) — also restored from the last open
  initialAttachOpen?: boolean // the attach panel's open/closed state — also restored from the last open
}): JSX.Element {
  // 'home' = the icon grid; 'settings' = debug settings; 'session' = today's agent chat/session UI.
  const [view, setView] = useState<'home' | 'settings' | 'session'>(initialView)
  const [page, setPage] = useState(initialPage) // 0 = new-session composer; 1..N = the agent at page-1
  const [attachOpen, setAttachOpen] = useState(initialAttachOpen)
  const [sessions, setSessions] = useState<IslandSession[]>([])
  const [archivedSessions, setArchivedSessions] = useState<IslandSession[]>([])
  const [threads, setThreads] = useState<Record<string, IslandMessage[]>>({})
  const [status, setStatus] = useState<Record<string, string>>({})
  const [milestones, setMilestones] = useState<Record<string, IslandMilestone[]>>({})
  const [runs, setRuns] = useState<Record<string, IslandWfRun[]>>({}) // per-agent live workflow runs (inline kanban)
  const [terminals, setTerminals] = useState<Record<string, IslandTerminalMeta>>({})
  const [debugActiveTerminal, setDebugActiveTerminal] = useState(readDebugActiveTerminal)
  const [peek, setPeek] = useState(false) // the peek (now-playing) view collapses the chat to summaries
  const pendingJump = useRef<string | null>(null) // after a spawn, jump to the new session once it appears
  const activeIdRef = useRef('') // the active chat id, mirrored for the picker arm (computed below the effect)
  const nRef = useRef(0)
  nRef.current = sessions.length

  // Report the island's view + tab up to App so reopening it (hover OR ⌥Space) restores where the user left off,
  // instead of resetting to Home. App stashes these and feeds them back as initialView/initialPage on the next open.
  useEffect(() => {
    onStateChange?.(view, page, attachOpen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, page, attachOpen])

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
  }, [attachOpen, debugActiveTerminal, peek, view]) // view/debug changes resize the chassis too — hold the island open across the transit

  const chooseDebugActiveTerminal = (on: boolean): void => {
    setDebugActiveTerminal(on)
    try {
      window.localStorage.setItem(DEBUG_ACTIVE_TERMINAL_KEY, on ? '1' : '0')
    } catch {
      /* debug-only persistence */
    }
  }

  // Apply a roster update; if we just spawned a session and it now exists, jump to its tab.
  const applySessions = (arr: IslandSession[]): void => {
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
        setStatus(snap.status || {})
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
        if (act.status) setStatus(act.status)
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
  useEffect(() => {
    if (!attachOpen) return
    const pick = window.agentOS?.pick
    if (!pick) return
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
      try {
        pick.stop()
      } catch {
        /* best-effort */
      }
    }
  }, [attachOpen])

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

  // Tab navigation by KEYBOARD: Ctrl+Tab → next, Ctrl+Shift+Tab → prev, wrapping the pen tab (0) + agents (1..N).
  // Disabled while the attachment panel is open. (Swipe just scrolls the strip; it never pages.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (attachOpen) return // while the attach panel is open, don't shuffle tabs underneath it (peek keeps tabs live)
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const total = nRef.current + 1
        setPage((p) => (clamp(p, 0, nRef.current) + (e.shiftKey ? total - 1 : 1)) % total)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [attachOpen])

  const N = sessions.length
  const safePage = clamp(page, 0, N)
  const activeIndex = safePage === 0 ? -1 : safePage - 1
  const activeSession = activeIndex >= 0 ? sessions[activeIndex] : null
  const activeId = activeSession?.id
  activeIdRef.current = activeId ?? '' // '' = the new-session composer; sources dropped there are reassigned on spawn
  const messages = activeId ? threads[activeId] || [] : []
  const activeMilestones = activeId ? milestones[activeId] || [] : []
  const activeRuns = activeId ? runs[activeId] || [] : []
  const activeStatus = activeId ? status[activeId] || activeSession?.status || 'idle' : 'idle'

  const goPage = (next: number): void => setPage(clamp(next, 0, N))
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
    // Attachments ride the message now (shown as chips on the sent bubble), so close the staging IMMEDIATELY. This
    // also fixes the new-session break: leaving attach open across the page-switch to the spawned agent collided
    // with the agent-chat attach layout (the height-lock) and broke the island.
    setAttachOpen(false)
    clearStaged(activeIdRef.current) // the staged sources rode this message (chips) → clear this chat's tray
    if (safePage === 0) {
      window.agentOS
        ?.notch?.send?.(text, false)
        .then((r) => {
          if (r?.ok && r.id != null) pendingJump.current = String(r.id)
        })
        .catch(() => {
          /* spawn failed; the chat error surfaces in the host */
        })
    } else if (activeId) {
      try {
        window.agentOS?.sendMessage?.(text, activeId)
      } catch {
        /* no bridge */
      }
    }
  }

  const togglePeek = (): void => {
    setPeek((v) => !v)
    setAttachOpen(false)
  }

  // The CHASSIS is invariant black + the original NotchShape, and grows wide when the attach panel opens. The
  // PEEK toggle lives at the very top (the notch / menu-bar band), top-right, ALWAYS visible across every view.
  const onHome = view === 'home'
  const inSession = view === 'session'
  const dataView = onHome ? 'home' : view === 'settings' ? 'settings' : safePage === 0 ? 'session' : 'process'
  const holdChassisHover = (): void => onChassisHoverChange?.(true)
  const openChat = (): void => {
    holdChassisHover()
    setPage(0)
    setPeek(false)
    setAttachOpen(false)
    setView('session')
  }
  return (
    <div className="nhost" data-view={dataView}>
      <div
        className={`nh-chassis${attachOpen && !onHome ? ' nh-wide' : ''}`}
        data-view={dataView}
        onPointerEnter={holdChassisHover}
        onPointerMove={holdChassisHover}
        onPointerDownCapture={holdChassisHover}
        onPointerLeave={() => onChassisHoverChange?.(false)}
      >
        {/* Settings is notch chrome, not a widget tile. It expands the home view into a settings list. */}
        {onHome && (
          <button
            type="button"
            className={`nh-settings-btn${debugActiveTerminal ? ' on' : ''}`}
            onClick={() => setView('settings')}
            title="Settings"
            aria-label="Settings"
          >
            <svg viewBox="0 0 24 24" aria-hidden focusable="false">
              <path d={SETTINGS_PATH} fill="currentColor" />
            </svg>
            {debugActiveTerminal && <span className="nh-settings-dot" aria-hidden />}
          </button>
        )}
        {/* The HOME button + Peek toggle live inside expanded island views; the home widget row stays widget-only. */}
        {!onHome && (
          <button type="button" className="nh-home-btn" onClick={() => setView('home')} title="Home" aria-label="Home">
            <svg viewBox="0 0 24 24" aria-hidden focusable="false">
              <path
                d="M3 11.4 12 4l9 7.4M5.5 9.8V20h4V14.5h5V20h4V9.8"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </button>
        )}
        {/* Peek toggle hidden for now (not needed). Restore this block to bring it back.
        {inSession && (
          <button
            type="button"
            className={`nh-peek-toggle${peek ? ' on' : ''}`}
            onClick={togglePeek}
            aria-pressed={peek}
            title={peek ? 'Expand to chat' : 'Peek all sessions'}
          >
            <svg viewBox="0 0 24 24" aria-hidden focusable="false">
              <path d={peek ? PEEK_OUT : PEEK_IN} stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
            <span>{peek ? 'Expand' : 'Peek'}</span>
          </button>
        )}
        */}
        {onHome ? (
          <IslandHome
            menuBarH={menuBarH}
            sessions={sessions}
            status={status}
            onOpenChat={openChat}
          />
        ) : view === 'settings' ? (
          <IslandSettings
            menuBarH={menuBarH}
            showActiveTerminal={debugActiveTerminal}
            onToggleActiveTerminal={chooseDebugActiveTerminal}
            archivedSessions={archivedSessions}
            onRestoreAgent={restoreAgent}
            onDeleteAgent={deleteArchivedAgent}
          />
        ) : (
          <IslandPanel
            sessions={sessions}
            page={safePage}
            onSelectPage={goPage}
            messages={messages}
            milestones={activeMilestones}
            runs={activeRuns}
            status={activeStatus}
            activeId={activeId}
            peek={peek}
            onSend={onSend}
            menuBarH={menuBarH}
            attachOpen={attachOpen}
            onToggleAttach={() => setAttachOpen((v) => !v)}
            debugTerminalEnabled={debugActiveTerminal}
            activeTerminal={activeId ? terminals[activeId] : undefined}
            onArchiveAgent={archiveAgent}
            onRenameAgent={renameAgent}
          />
        )}
      </div>
    </div>
  )
}

export default NotchHost
