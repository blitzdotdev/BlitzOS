import { useCallback, useEffect, useState } from 'react'
import { Surface } from '../types'
import { useDesktop, nextTerminalName } from '../store'

// The Sessions tray — a glanceable list of every session in the active workspace (running + the
// persisted-but-dead ones that survive in the workspace folder). It's the answer to "where do I see
// all my sessions": title, status, command, cwd, plus one-click Open / Resume / Stop. Sessions are
// file-backed under <workspace>/.blitzos/sessions/<id>/, so this list survives a BlitzOS restart.
type SessionMeta = {
  id: string
  kind: string
  title: string
  command: string | null
  cwd: string | null
  status: string
  pid: number | null
  exitCode: number | null
  createdAt: number
  endedAt: number | null
  stage?: number | null
}
type SessionApi = {
  sessionList?: () => Promise<unknown[]>
  sessionStop?: (id: string) => void
  sessionRestart?: (id: string) => void
  sessionSpawn?: (opts: { command?: string; title?: string }) => void
  onAction?: (cb: (a: { type?: string }) => void) => (() => void) | undefined
}
const sapi = (): SessionApi => (window.agentOS as unknown as SessionApi) || {}

function ago(ms: number): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return s + 's ago'
  const m = Math.round(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.round(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.round(h / 24) + 'd ago'
}

function statusColor(s: SessionMeta): string {
  if (s.status === 'running') return 'var(--positive, #3fb950)'
  if (s.status === 'exited' && (s.exitCode ?? 0) === 0) return 'var(--text-tertiary)'
  return 'var(--negative, #e5484d)' // stopped or non-zero exit
}

export function SessionsPanel({ surface }: { surface: Surface }): JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const openSession = useDesktop((s) => s.openSession)
  void surface

  const refresh = useCallback(() => {
    Promise.resolve(sapi().sessionList?.() ?? [])
      .then((list) => {
        if (!Array.isArray(list)) return
        const ss = (list as SessionMeta[]).slice().sort((a, b) => {
          // running first, then most-recently-created
          if (a.status === 'running' && b.status !== 'running') return -1
          if (b.status === 'running' && a.status !== 'running') return 1
          return (b.createdAt || 0) - (a.createdAt || 0)
        })
        setSessions(ss)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2500) // poll: exit/stop transitions can arrive out-of-band
    // Also refresh immediately on any session lifecycle broadcast (spawn/exit/stop) for snappiness.
    const off = sapi().onAction?.((a) => {
      if (a && typeof a.type === 'string' && a.type.indexOf('session-') === 0) refresh()
    })
    return () => {
      clearInterval(t)
      off?.()
    }
  }, [refresh])

  const running = sessions.filter((s) => s.status === 'running').length

  return (
    <div className="sessions-panel" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="sessions-head">
        <span className="sessions-count">
          {sessions.length} session{sessions.length === 1 ? '' : 's'}
          {running > 0 && <span className="sessions-running"> · {running} running</span>}
        </span>
        <button
          className="sessions-new"
          title="Start a new terminal session"
          onClick={() => sapi().sessionSpawn?.({ command: 'bash', title: nextTerminalName() })}
        >
          + New
        </button>
      </div>
      <div className="sessions-list">
        {sessions.length === 0 && (
          <div className="sessions-empty">
            No sessions yet.
            <br />
            Click <strong>+ New</strong> (or “Terminal” in the toolbar) to start one.
          </div>
        )}
        {sessions.map((s) => (
          <div key={s.id} className="sess-row" onDoubleClick={() => openSession(s.id, s.title, s.stage)}>
            <span className="sess-dot" style={{ background: statusColor(s) }} title={s.status} />
            <div className="sess-main">
              <div className="sess-title">{s.title || s.id.slice(0, 8)}</div>
              <div className="sess-meta">
                <span className="sess-kind">{s.kind === 'agent' ? 'agent' : 'shell'}</span>
                {s.command && <span className="sess-cmd"> · {s.command}</span>}
                <span className="sess-status">
                  {' · '}
                  {s.status}
                  {s.status === 'exited' && s.exitCode != null ? ` (${s.exitCode})` : ''}
                </span>
                <span className="sess-time"> · {ago(s.createdAt)}</span>
              </div>
              {s.cwd && <div className="sess-cwd" title={s.cwd}>{s.cwd}</div>}
            </div>
            <div className="sess-actions">
              {s.status === 'running' ? (
                <>
                  <button className="sess-btn" title="Show this session's terminal" onClick={() => openSession(s.id, s.title, s.stage)}>
                    Open
                  </button>
                  <button
                    className="sess-btn danger"
                    title="Stop (kill) this session"
                    onClick={() => {
                      sapi().sessionStop?.(s.id)
                      setTimeout(refresh, 250)
                    }}
                  >
                    Stop
                  </button>
                </>
              ) : (
                <button
                  className="sess-btn"
                  title="Resume — re-run this session from its saved command"
                  onClick={() => {
                    sapi().sessionRestart?.(s.id)
                    setTimeout(refresh, 400)
                  }}
                >
                  Resume
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
