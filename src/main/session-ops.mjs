// session-ops.mjs — the SHARED binding that gives both transports the session tools' ops
// (spawn/list/send/read/stop). The session lifecycle is workspace-keyed and lives here ONCE, so it
// can't diverge: each workspace gets its own tmux server (socket under <workspace>/.blitzos/tmux) and
// its own session manager (sessionsDir under <workspace>/.blitzos/sessions) — sessions live inside the
// workspace folder (the only datasource) and survive a restart. The only per-transport difference is
// the seam: getWorkspacePath (server: wsHost.activePath; Electron: osWorkspaceContext().workspace_path)
// and emit (server: SSE broadcast; Electron: webContents.send 'os:action'). Same makeOsTools(ops) pattern.
import { createTmuxHost } from './tmux-host.mjs'
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

  function mgrFor() {
    const wsPath = typeof getWorkspacePath === 'function' ? getWorkspacePath() : null
    if (!wsPath) return null
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
    readSession: (id) => { const m = mgrFor(); return m ? m.scrollback(id) : '' },
    stopSession: (id) => { const m = mgrFor(); return m ? m.stopSession(id) : false },
    /** Close every control client on shutdown (sessions SURVIVE in their tmux servers). */
    stopHosts: () => { for (const { host } of mgrs.values()) { try { host.stop() } catch { /* ignore */ } } }
  }
}
