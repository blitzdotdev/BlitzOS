import { useCallback, useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop, nextTerminalName } from '../store'
import { IconChat, IconCode } from './Icons'

// The Runtime tray ("Terminals & Agents") — a glanceable list of everything running in the active
// workspace (live + the persisted-but-dead ones that survive in the workspace folder). It's the answer
// to "where do I see all my terminals and agents": title, status, command, cwd, plus one-click
// Open / Resume / Stop (and Delete for an agent). Terminals are file-backed under
// <workspace>/.blitzos/terminals/<id>/, so this list survives a BlitzOS restart. An Agent is a managed
// agent terminal plus its chat widget; a plain Terminal is a shell/program.
type TerminalMeta = {
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
type TerminalApi = {
  terminalList?: () => Promise<unknown[]>
  terminalStop?: (id: string) => void
  terminalRemove?: (id: string) => void
  terminalRestart?: (id: string) => void
  terminalSpawn?: (opts: { command?: string; title?: string }) => void
  spawnAgent?: (title?: string) => void
  onAction?: (cb: (a: { type?: string }) => void) => (() => void) | undefined
}
const tapi = (): TerminalApi => (window.agentOS as unknown as TerminalApi) || {}

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

function statusColor(s: TerminalMeta): string {
  if (s.status === 'running') return 'var(--positive, #3fb950)'
  if (s.status === 'exited' && (s.exitCode ?? 0) === 0) return 'var(--text-tertiary)'
  return 'var(--negative, #e5484d)' // stopped or non-zero exit
}

export function RuntimePanel({ surface }: { surface: Surface }): JSX.Element {
  const [terminals, setTerminals] = useState<TerminalMeta[]>([])
  const [editing, setEditing] = useState<string | null>(null) // id whose title is being renamed inline
  const skipBlur = useRef(false) // set on Enter/Escape so the input's onBlur doesn't double-commit or commit-after-cancel
  const openTerminal = useDesktop((s) => s.openTerminal)
  const closeAgent = useDesktop((s) => s.closeAgent)
  const renameAgent = useDesktop((s) => s.renameAgent)
  const goToStage = useDesktop((s) => s.goToStage)
  void surface

  const refresh = useCallback(() => {
    Promise.resolve(tapi().terminalList?.() ?? [])
      .then((list) => {
        if (!Array.isArray(list)) return
        const ss = (list as TerminalMeta[]).slice().sort((a, b) => {
          // running first, then most-recently-created
          if (a.status === 'running' && b.status !== 'running') return -1
          if (b.status === 'running' && a.status !== 'running') return 1
          return (b.createdAt || 0) - (a.createdAt || 0)
        })
        setTerminals(ss)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2500) // poll: exit/stop transitions can arrive out-of-band
    // Also refresh immediately on any terminal/agent lifecycle broadcast for snappiness.
    const off = tapi().onAction?.((a) => {
      if (a && typeof a.type === 'string' && (a.type.indexOf('terminal-') === 0 || a.type.indexOf('agent-') === 0)) refresh()
    })
    return () => {
      clearInterval(t)
      off?.()
    }
  }, [refresh])

  const agents = terminals.filter((s) => s.kind === 'agent')
  const shells = terminals.filter((s) => s.kind !== 'agent')

  // One row, shared by both groups. Agents can be stopped/resumed; spawned agents also get
  // Delete (full teardown). The primary '0' is never deletable, but it can be stopped.
  function row(s: TerminalMeta): JSX.Element {
    const isAgent = s.kind === 'agent'
    const isPrimary = isAgent && s.id === '0'
    return (
      <div key={s.id} className="run-row" onDoubleClick={() => openTerminal(s.id, s.title, s.stage)}>
        <span className="run-dot" style={{ background: statusColor(s) }} title={s.status} />
        <span className="run-ico" title={isAgent ? 'Agent' : 'Terminal'}>
          {isAgent ? <IconChat size={13} /> : <IconCode size={13} />}
        </span>
        <div className="run-main">
          {editing === s.id ? (
            <input
              className="run-title-edit"
              defaultValue={s.title || ''}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') { skipBlur.current = true; const v = (e.target as HTMLInputElement).value.trim(); if (v && v !== s.title) renameAgent(s.id, v); setEditing(null); setTimeout(refresh, 200) }
                else if (e.key === 'Escape') { skipBlur.current = true; setEditing(null) } // cancel — do NOT commit
              }}
              onBlur={(e) => { if (skipBlur.current) { skipBlur.current = false; return } const v = e.target.value.trim(); if (v && v !== s.title) renameAgent(s.id, v); setEditing(null); setTimeout(refresh, 200) }}
            />
          ) : (
            <div className="run-title" title="Double-click to rename" onDoubleClick={(e) => { e.stopPropagation(); setEditing(s.id) }}>
              {s.title || s.id.slice(0, 8)}
            </div>
          )}
          <div className="run-meta">
            <span className="run-kind">{isPrimary ? 'Agent · primary' : isAgent ? 'Agent' : 'Terminal'}</span>
            {Number.isInteger(s.stage) && (
              <button className="run-stage" title={`Go to stage ${s.stage}`} onClick={(e) => { e.stopPropagation(); goToStage(s.stage as number) }}> · Stage {s.stage}</button>
            )}
            <span className="run-status">
              {' · '}
              {s.status}
              {s.status === 'exited' && s.exitCode != null ? ` (${s.exitCode})` : ''}
            </span>
            <span className="run-time"> · {ago(s.createdAt)}</span>
          </div>
          {s.cwd && <div className="run-cwd" title={s.cwd}>{s.cwd}</div>}
        </div>
        <div className="run-actions">
          {s.status === 'running' ? (
            <>
              <button className="run-btn" title={isAgent ? "Show this agent's terminal" : "Show this terminal"} onClick={() => openTerminal(s.id, s.title, s.stage)}>
                Open
              </button>
              <button
                className="run-btn danger"
                title={isPrimary ? 'Stop the resident agent (resumable)' : isAgent ? 'Stop this agent (kill its program; resumable)' : 'Stop (kill) this terminal'}
                onClick={() => {
                  tapi().terminalStop?.(s.id)
                  setTimeout(refresh, 250)
                }}
              >
                Stop
              </button>
            </>
          ) : (
            <>
              <button
                className="run-btn"
                title="Resume — re-run this from its saved command"
                onClick={() => {
                  tapi().terminalRestart?.(s.id)
                  setTimeout(refresh, 400)
                }}
              >
                Resume
              </button>
              {/* Remove = prune a dead terminal from the tray (delete its saved record). Terminals only; agents use Delete agent. */}
              {!isAgent && (
                <button
                  className="run-btn danger"
                  title="Remove this terminal from the tray (delete its saved record)"
                  onClick={() => { tapi().terminalRemove?.(s.id); setTimeout(refresh, 300) }}
                >
                  Remove
                </button>
              )}
            </>
          )}
          {/* Delete agent = full teardown (stop + delete its chat + files/area). Never the primary. */}
          {isAgent && !isPrimary && (
            <button
              className="run-btn danger"
              title="Delete this agent and its chat + files"
              onClick={() => { closeAgent(s.id); setTimeout(refresh, 400) }}
            >
              Delete agent
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="runtime-panel" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="runtime-head">
        <span className="runtime-title">Terminals &amp; Agents</span>
        <span className="runtime-count">
          {agents.length} agent{agents.length === 1 ? '' : 's'} · {shells.length} terminal{shells.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="runtime-group">
        <div className="runtime-group-head">
          <span className="runtime-group-title">Agents</span>
          <button
            className="runtime-add"
            title="Spawn a new agent with its own chat widget"
            onClick={() => tapi().spawnAgent?.()}
          >
            +
          </button>
        </div>
        <div className="runtime-list">
          {agents.length === 0 ? (
            <div className="runtime-empty">No agents yet. Click <strong>+</strong> (or “+ Agent” in the toolbar) to start one.</div>
          ) : (
            agents.map(row)
          )}
        </div>
      </div>

      <div className="runtime-group">
        <div className="runtime-group-head">
          <span className="runtime-group-title">Terminals</span>
          <button
            className="runtime-add"
            title="Start a new terminal (a shell)"
            onClick={() => tapi().terminalSpawn?.({ command: 'bash', title: nextTerminalName() })}
          >
            +
          </button>
        </div>
        <div className="runtime-list">
          {shells.length === 0 ? (
            <div className="runtime-empty">No terminals yet. Click <strong>+</strong> (or “+ Terminal” in the toolbar) to start one.</div>
          ) : (
            shells.map(row)
          )}
        </div>
      </div>
    </div>
  )
}
