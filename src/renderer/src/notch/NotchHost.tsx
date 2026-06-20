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
import IslandPanel from './IslandPanel'
import IslandHome from './IslandHome'
import type { IslandSession, IslandMessage, IslandMilestone } from './types'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

// peek toggle glyphs: compress (corners in → enter peek) / expand (corners out → back to chat).
const PEEK_IN = 'M5 9h4a1 1 0 0 0 1-1V4M19 9h-4a1 1 0 0 1-1-1V4M5 15h4a1 1 0 0 1 1 1v4M19 15h-4a1 1 0 0 0-1 1v4'
const PEEK_OUT = 'M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4'

// The chat broadcast / snapshot shapes (subset we use). The host sends raw host statuses + role'd transcripts.
type ChatAction = {
  type: 'chat'
  sessions?: Array<{ id?: unknown; title?: unknown; status?: unknown }>
  threads?: Record<string, Array<{ role?: unknown; text?: unknown; ts?: unknown }>>
  status?: Record<string, string>
}
const mapSession = (s: { id?: unknown; title?: unknown; status?: unknown }): IslandSession => ({
  id: String(s.id),
  title: String(s.title || `Chat ${s.id}`),
  status: String(s.status || 'idle')
})
type MilestoneAction = { type: 'milestone'; agentId?: string; id?: unknown; ts?: unknown; kind?: string; text?: unknown }
const mapThreads = (
  raw?: Record<string, Array<{ role?: unknown; text?: unknown; ts?: unknown }>>
): Record<string, IslandMessage[]> => {
  const out: Record<string, IslandMessage[]> = {}
  for (const id of Object.keys(raw || {})) {
    out[id] = (raw![id] || [])
      .filter((m) => m && String(m.text || '').trim())
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'agent', text: String(m.text), ts: Number(m.ts) || undefined }))
  }
  return out
}

export function NotchHost({
  menuBarH,
  onChassisResize,
  onChassisHoverChange,
  onAttachChange,
  initialView = 'home'
}: {
  menuBarH: number
  onChassisResize?: () => void
  onChassisHoverChange?: (on: boolean) => void
  onAttachChange?: (open: boolean) => void // attach panel (the macOS window picker) opened/closed → App pins the island open
  initialView?: 'home' | 'session' // the view to open into: 'home' (hover) or 'session' (⌥Space). Remounts per open.
}): JSX.Element {
  // 'home' = the widget home screen (the grid); 'session' = a widget is open (today's agent chat/session UI).
  const [view, setView] = useState<'home' | 'session'>(initialView)
  const [page, setPage] = useState(0) // 0 = new-session composer; 1..N = the agent at page-1
  const [attachOpen, setAttachOpen] = useState(false)
  const [sessions, setSessions] = useState<IslandSession[]>([])
  const [threads, setThreads] = useState<Record<string, IslandMessage[]>>({})
  const [status, setStatus] = useState<Record<string, string>>({})
  const [milestones, setMilestones] = useState<Record<string, IslandMilestone[]>>({})
  const [peek, setPeek] = useState(false) // the peek (now-playing) view collapses the chat to summaries
  const pendingJump = useRef<string | null>(null) // after a spawn, jump to the new session once it appears
  const nRef = useRef(0)
  nRef.current = sessions.length

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
  }, [attachOpen, peek, view]) // home↔session resizes the chassis too — hold the island open across the transit

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

  // Snapshot on open + subscribe to the live chat broadcast.
  useEffect(() => {
    let live = true
    window.agentOS
      ?.agents?.()
      .then((snap) => {
        if (!live || !snap) return
        applySessions((snap.sessions || []).map(mapSession))
        setThreads(mapThreads(snap.threads))
        setStatus(snap.status || {})
        setMilestones((snap.milestones || {}) as Record<string, IslandMilestone[]>)
      })
      .catch(() => {
        /* no host yet */
      })
    const off = window.agentOS?.onAction?.((a: unknown) => {
      const act = a as ChatAction | MilestoneAction
      if (!act) return
      if (act.type === 'chat') {
        if (Array.isArray(act.sessions)) applySessions(act.sessions.map(mapSession))
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
    const measure = (): { x: number; y: number; w: number; h: number } | null => {
      const el = document.querySelector('.att-drop') as HTMLElement | null
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return null
      // viewport rect → on-screen rect (top-left global points; the overlay window's origin + the element offset).
      return { x: window.screenX + r.left, y: window.screenY + r.top, w: r.width, h: r.height }
    }
    const arm = (): void => {
      if (stopped) return
      const z = measure()
      if (z) void pick.start(z)
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
  const messages = activeId ? threads[activeId] || [] : []
  const activeMilestones = activeId ? milestones[activeId] || [] : []
  const activeStatus = activeId ? status[activeId] || activeSession?.status || 'idle' : 'idle'

  const goPage = (next: number): void => setPage(clamp(next, 0, N))

  // page 0 (pen) = spawn a NEW session; an agent tab = steer that session. Both are real (no mock append).
  const onSend = (text: string): void => {
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
  const dataView = onHome ? 'home' : safePage === 0 ? 'session' : 'process'
  return (
    <div className="nhost" data-view={dataView}>
      <div
        className={`nh-chassis${attachOpen && !onHome ? ' nh-wide' : ''}`}
        data-view={dataView}
        onPointerEnter={() => onChassisHoverChange?.(true)}
        onPointerMove={() => onChassisHoverChange?.(true)}
        onPointerLeave={() => onChassisHoverChange?.(false)}
      >
        {/* The HOME button (the only island chrome) + the Peek toggle live ONLY inside a widget; the home grid is bare. */}
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
        {!onHome && (
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
        {onHome ? (
          <IslandHome menuBarH={menuBarH} sessions={sessions} status={status} onOpenChat={() => setView('session')} />
        ) : (
          <IslandPanel
            sessions={sessions}
            page={safePage}
            onSelectPage={goPage}
            messages={messages}
            milestones={activeMilestones}
            status={activeStatus}
            activeId={activeId}
            peek={peek}
            onSend={onSend}
            menuBarH={menuBarH}
            attachOpen={attachOpen}
            onToggleAttach={() => setAttachOpen((v) => !v)}
          />
        )}
      </div>
    </div>
  )
}

export default NotchHost
