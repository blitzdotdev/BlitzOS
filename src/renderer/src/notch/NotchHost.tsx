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

export function NotchHost({ menuBarH }: { menuBarH: number }): JSX.Element {
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
  return (
    <div className="nhost" data-view={safePage === 0 ? 'session' : 'process'}>
      <div className={`nh-chassis${attachOpen ? ' nh-wide' : ''}`} data-view={safePage === 0 ? 'session' : 'process'}>
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
      </div>
    </div>
  )
}

export default NotchHost
