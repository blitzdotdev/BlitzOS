// session-ops.mjs — the SHARED binding that gives both transports the session tools' ops
// (spawn/list/send/read/stop). The session lifecycle is workspace-keyed and lives here ONCE, so it
// can't diverge: each workspace gets its own tmux server (socket under <workspace>/.blitzos/tmux) and
// its own session manager (sessionsDir under <workspace>/.blitzos/sessions) — sessions live inside the
// workspace folder (the only datasource) and survive a restart. The only per-transport difference is
// the seam: getWorkspacePath (server: wsHost.activePath; Electron: osWorkspaceContext().workspace_path)
// and emit (server: SSE broadcast; Electron: webContents.send 'os:action'). Same makeOsTools(ops) pattern.
import { createTmuxHost, tmuxAvailable } from './tmux-host.mjs'
import { createSessionManager } from './session-manager.mjs'
import { markWrite as defaultMarkWrite } from './workspace.mjs'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * @param {{ getWorkspacePath: () => (string|null|undefined), emit?: (ev:object)=>void, markWrite?: (p:string)=>void }} deps
 * @returns the 5 session ops (+ stopHosts for shutdown), to spread into a transport's ops object.
 */
export function makeSessionOps({ getWorkspacePath, emit = () => {}, markWrite = defaultMarkWrite } = {}) {
  const mgrs = new Map() // workspacePath -> { host, mgr }
  let preflighted = false

  function mgrFor() {
    const wsPath = typeof getWorkspacePath === 'function' ? getWorkspacePath() : null
    if (!wsPath) return null
    // Preflight tmux once — sessions are a hard tmux dependency (no fallback). A clear message beats a
    // silent ENOENT when tmux isn't installed / bundled.
    if (!preflighted) {
      preflighted = true
      const v = tmuxAvailable()
      if (v) console.log('[session-ops] sessions backed by', v)
      else console.error('[session-ops] tmux NOT found — sessions need tmux. Install (apk add tmux / brew install tmux) or set BLITZ_TMUX_BIN to a bundled binary.')
    }
    // Keep ONLY the active workspace's manager live — evict the rest (their tmux sessions survive in
    // their own servers; restore() re-adopts them if that workspace is re-activated). Bounds the leak
    // to one control client instead of one per workspace ever switched to.
    for (const [p, e] of mgrs) {
      if (p === wsPath) continue
      try { e.mgr.flushAll(); e.host.stop() } catch { /* ignore */ }
      mgrs.delete(p)
    }
    let entry = mgrs.get(wsPath)
    if (!entry) {
      const tmuxDir = join(wsPath, '.blitzos', 'tmux')
      try { mkdirSync(tmuxDir, { recursive: true }) } catch { /* exists */ }
      const host = createTmuxHost({ socketPath: join(tmuxDir, 'server.sock') })
      const mgr = createSessionManager({
        host,
        sessionsDir: join(wsPath, '.blitzos', 'sessions'),
        emit,
        markWrite: (p) => { try { markWrite(resolve(p)) } catch { /* ignore */ } }
      })
      entry = { host, mgr }
      mgrs.set(wsPath, entry)
      mgr.restore().catch(() => { /* nothing to reattach */ }) // adopt sessions that survived a restart
    }
    return entry.mgr
  }

  return {
    spawnSession: (opts) => { const m = mgrFor(); return m ? m.spawnSession(opts) : Promise.resolve(null) },
    listSessions: () => { const m = mgrFor(); return m ? m.listSessions() : [] },
    sendToSession: (id, data) => { const m = mgrFor(); return m ? m.sendToSession(id, data) : false },
    resizeSession: (id, cols, rows) => { const m = mgrFor(); return m ? m.resizeSession(id, cols, rows) : false },
    readSession: (id) => { const m = mgrFor(); return m ? m.scrollback(id) : '' },
    stopSession: (id) => { const m = mgrFor(); return m ? m.stopSession(id) : false },
    /** Re-spawn a dead session from its persisted meta (one-click resume of an exited/stopped session). */
    restartSession: (id) => { const m = mgrFor(); return m ? m.restartSession(id) : Promise.resolve(null) },
    /** Flush transcripts + close every control client on shutdown (sessions SURVIVE in their tmux servers). */
    stopHosts: () => { for (const { host, mgr } of mgrs.values()) { try { mgr.flushAll(); host.stop() } catch { /* ignore */ } } }
  }
}
