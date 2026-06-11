// session-ops.mjs — the SHARED binding that gives both transports the session tools' ops
// (spawn/list/send/read/stop). The session lifecycle is workspace-keyed and lives here ONCE, so it
// can't diverge: each workspace gets its own tmux server (socket under <workspace>/.blitzos/tmux) and
// its own session manager (sessionsDir under <workspace>/.blitzos/sessions) — sessions live inside the
// workspace folder (the only datasource) and survive a restart. The only per-transport difference is
// the seam: getWorkspacePath (server: wsHost.activePath; Electron: osWorkspaceContext().workspace_path)
// and emit (server: SSE broadcast; Electron: webContents.send 'os:action'). Same makeOsTools(ops) pattern.
import { createTmuxHost, tmuxAvailable } from './tmux-host.mjs'
import { createSessionManager } from './session-manager.mjs'
import { prepareAgentLaunch } from './agent-session.mjs'
import { markWrite as defaultMarkWrite } from './workspace.mjs'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * @param {{ getWorkspacePath: () => (string|null|undefined), emit?: (ev:object)=>void, markWrite?: (p:string)=>void,
 *           getUrl?: () => (string|null|undefined) }} deps
 *   getUrl: the current agent-socket relay url — used to REBUILD an agent's command (fresh url + --resume)
 *   when its dead terminal is re-spawned (manual Resume or a true restart). Absent ⇒ shells only.
 * @returns the session ops (+ stopHosts for shutdown), to spread into a transport's ops object.
 */
export function makeSessionOps({ getWorkspacePath, emit = () => {}, markWrite = defaultMarkWrite, getUrl, agentCmd = 'claude' } = {}) {
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
      const sessionsDir = join(wsPath, '.blitzos', 'sessions')
      const mgr = createSessionManager({
        host,
        sessionsDir,
        emit,
        markWrite: (p) => { try { markWrite(resolve(p)) } catch { /* ignore */ } },
        // Rebuild a dead AGENT session's command on re-exec: fresh relay url + --resume of its persisted
        // claude session id (created vs resume decided by claudeEstablished inside prepareAgentLaunch).
        rebuildAgentCommand: (meta) => {
          const url = typeof getUrl === 'function' ? getUrl() : null
          if (!url) return null
          try { return prepareAgentLaunch({ sessionsDir, id: meta.id, url, cmd: agentCmd }).command } catch { return null }
        }
      })
      entry = { host, mgr, restorePromise: null }
      mgrs.set(wsPath, entry)
      entry.restorePromise = mgr.restore().catch(() => []) // adopt sessions that survived a restart (cached so boot-resume can await it)
    }
    return entry.mgr
  }
  /** Resolves once the ACTIVE workspace's survivors have been re-adopted — so boot resume can tell a live
   *  survivor from a dead session without racing restore(). Returns the (cached) restore promise. */
  function whenRestored() {
    mgrFor() // ensure the manager + its restore are kicked off
    const wsPath = typeof getWorkspacePath === 'function' ? getWorkspacePath() : null
    const e = wsPath ? mgrs.get(wsPath) : null
    return e ? e.restorePromise : Promise.resolve([])
  }

  return {
    spawnSession: (opts) => { const m = mgrFor(); return m ? m.spawnSession(opts) : Promise.resolve(null) },
    listSessions: () => { const m = mgrFor(); return m ? m.listSessions() : [] },
    /** A session's current record (live or persisted), or null — used to tell a reattached survivor from a
     *  dead session during boot resume (status 'running' ⇒ tmux kept it alive, don't re-exec). */
    getSession: (id) => { const m = mgrFor(); return m ? m.getSession(id) : null },
    /** Whether a session is actually wired to a live tmux window THIS run (a reattached survivor or a fresh
     *  spawn) — boot resume re-execs everything NOT live, so a died-while-down agent isn't skipped. */
    isSessionLive: (id) => { const m = mgrFor(); return m ? m.isLive(id) : false },
    /** Awaits adoption of survivors for the active workspace (so boot resume doesn't race restore()). */
    whenRestored,
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
