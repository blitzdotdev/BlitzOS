// terminal-ops.mjs — the SHARED binding that gives both transports the terminal tools' ops
// (spawn/list/send/read/stop). The terminal lifecycle is workspace-keyed and lives here ONCE, so it
// can't diverge: each workspace gets its own tmux server (socket under <workspace>/.blitzos/tmux) and
// its own terminal manager (terminalsDir under <workspace>/.blitzos/terminals) — terminals live inside the
// workspace folder (the only datasource) and survive a restart. The only per-transport difference is
// the seam: getWorkspacePath (server: wsHost.activePath; Electron: osWorkspaceContext().workspace_path)
// and emit (server: SSE broadcast; Electron: webContents.send 'os:action'). Same makeOsTools(ops) pattern.
import { createTmuxHost, tmuxAvailable } from './tmux-host.mjs'
import { createTerminalManager } from './terminal-manager.mjs'
import { prepareAgentLaunch } from './agent-runtime.mjs'
import { markWrite as defaultMarkWrite } from './workspace.mjs'
import { join, resolve } from 'node:path'
import { mkdirSync, existsSync, renameSync } from 'node:fs'

/**
 * @param {{ getWorkspacePath: () => (string|null|undefined), emit?: (ev:object)=>void, markWrite?: (p:string)=>void,
 *           getUrl?: () => (string|null|undefined) }} deps
 *   getUrl: the current agent-socket relay url — used to REBUILD an agent's command (fresh url + --resume)
 *   when its dead terminal is re-spawned (manual Resume or a true restart). Absent ⇒ shells only.
 * @returns the terminal ops (+ stopHosts for shutdown), to spread into a transport's ops object.
 */
export function makeTerminalOps({ getWorkspacePath, emit = () => {}, markWrite = defaultMarkWrite, getUrl, agentCmd = 'claude', agentRuntime = 'claude', getAgentRuntime } = {}) {
  const mgrs = new Map() // workspacePath -> { host, mgr }
  let preflighted = false

  function mgrFor() {
    const wsPath = typeof getWorkspacePath === 'function' ? getWorkspacePath() : null
    if (!wsPath) return null
    // Preflight tmux once — terminals are a hard tmux dependency (no fallback). A clear message beats a
    // silent ENOENT when tmux isn't installed / bundled.
    if (!preflighted) {
      preflighted = true
      const v = tmuxAvailable()
      if (v) console.log('[terminal-ops] terminals backed by', v)
      else console.error('[terminal-ops] tmux NOT found — terminals need tmux. Install (apk add tmux / brew install tmux) or set BLITZ_TMUX_BIN to a bundled binary.')
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
      const terminalsDir = join(wsPath, '.blitzos', 'terminals')
      // MIGRATION (one-time, per workspace, BEFORE the manager reads/restores): the durable terminal
      // records used to live under .blitzos/sessions. If the new dir is absent but the legacy one exists,
      // rename it in place (same volume ⇒ atomic). Live tmux windows are unaffected (they key off ids).
      try {
        const legacyDir = join(wsPath, '.blitzos', 'sessions')
        if (!existsSync(terminalsDir) && existsSync(legacyDir)) renameSync(legacyDir, terminalsDir)
      } catch { /* best-effort; the manager creates terminalsDir on first write if this didn't run */ }
      const host = createTmuxHost({ socketPath: join(tmuxDir, 'server.sock') })
      const mgr = createTerminalManager({
        host,
        terminalsDir,
        emit,
        markWrite: (p) => { try { markWrite(resolve(p)) } catch { /* ignore */ } },
        // Rebuild a dead managed AGENT terminal on re-exec: fresh relay url + backend-specific metadata,
        // decided inside prepareAgentLaunch. Meta and the actual command must never diverge.
        rebuildAgentCommand: (meta) => {
          const url = typeof getUrl === 'function' ? getUrl() : null
          if (!url) return null
          const spec = typeof getAgentRuntime === 'function' ? getAgentRuntime(meta) || {} : {}
          try {
            return prepareAgentLaunch({
              sessionsDir: terminalsDir,
              id: meta.id,
              url,
              cmd: spec.cmd || agentCmd,
              runtime: spec.runtime || meta.agentRuntime || (meta.claudeSessionId ? 'claude' : agentRuntime)
            })
          } catch { return null }
        }
      })
      entry = { host, mgr, restorePromise: null }
      mgrs.set(wsPath, entry)
      entry.restorePromise = mgr.restore().catch(() => []) // adopt terminals that survived a restart (cached so boot-resume can await it)
    }
    return entry.mgr
  }
  /** Resolves once the ACTIVE workspace's survivors have been re-adopted — so boot resume can tell a live
   *  survivor from a dead terminal without racing restore(). Returns the (cached) restore promise. */
  function whenRestored() {
    mgrFor() // ensure the manager + its restore are kicked off
    const wsPath = typeof getWorkspacePath === 'function' ? getWorkspacePath() : null
    const e = wsPath ? mgrs.get(wsPath) : null
    return e ? e.restorePromise : Promise.resolve([])
  }
  /** The active workspace's { host, mgr } entry, or null — for the few ops that need the tmux host
   *  directly (attachSpec) rather than the manager. mgrFor() first so the entry exists + stale ones evict. */
  function activeEntry() {
    mgrFor()
    const wsPath = typeof getWorkspacePath === 'function' ? getWorkspacePath() : null
    return wsPath ? mgrs.get(wsPath) || null : null
  }

  return {
    spawnTerminal: (opts) => { const m = mgrFor(); return m ? m.spawnTerminal(opts) : Promise.resolve(null) },
    listTerminals: () => { const m = mgrFor(); return m ? m.listTerminals() : [] },
    /** A terminal's current record (live or persisted), or null — used to tell a reattached survivor from a
     *  dead terminal during boot resume (status 'running' ⇒ tmux kept it alive, don't re-exec). */
    getTerminal: (id) => { const m = mgrFor(); return m ? m.getTerminal(id) : null },
    /** Whether a terminal is actually wired to a live tmux window THIS run (a reattached survivor or a fresh
     *  spawn) — boot resume re-execs everything NOT live, so a died-while-down agent isn't skipped. */
    isTerminalLive: (id) => { const m = mgrFor(); return m ? m.isLive(id) : false },
    /** Awaits adoption of survivors for the active workspace (so boot resume doesn't race restore()). */
    whenRestored,
    sendToTerminal: (id, data) => { const m = mgrFor(); return m ? m.sendToTerminal(id, data) : false },
    resizeTerminal: (id, cols, rows) => { const m = mgrFor(); return m ? m.resizeTerminal(id, cols, rows) : false },
    readTerminal: (id) => { const m = mgrFor(); return m ? m.scrollback(id) : '' },
    /** Current RENDERED pane text (capture-pane -p) — the wake watchdog diffs it across a settle window to
     *  tell a frozen/idle pane from one actively producing output. '' when no manager/terminal. */
    captureTerminal: (id) => { const m = mgrFor(); return m ? m.capturePane(id) : '' },
    /** External-terminal handoff: the `tmux attach` coordinates ({bin,socket,session,window}) for this
     *  terminal's LIVE window, so it can be opened in a real terminal app (Ghostty) instead of the
     *  read-only embedded pane. `window` is the unambiguous tmux window-id (@N). null when no live window.
     *  Uses the SAME tmux binary + socket the host runs, so the external client's protocol version always
     *  matches the server. */
    attachSpec: (id) => { const e = activeEntry(); return e ? e.host.attachSpec(String(id)) : null },
    stopTerminal: (id) => { const m = mgrFor(); return m ? m.stopTerminal(id) : false },
    /** Permanently remove a terminal (kill if live + delete its persisted record) so it leaves the tray. Never '0'. */
    removeTerminal: (id) => { const m = mgrFor(); return m ? m.removeTerminal(id) : false },
    /** Re-spawn a dead terminal from its persisted meta (one-click resume of an exited/stopped terminal). */
    restartTerminal: (id) => { const m = mgrFor(); return m ? m.restartTerminal(id) : Promise.resolve(null) },
    /** Clear an agent's claude context on demand (rotate its session id + restart → empty conversation). Uniform for any agent. */
    clearAgentContext: (id) => { const m = mgrFor(); return m ? m.clearAgentContext(id) : Promise.resolve(false) },
    /** Flush transcripts + close every control client on shutdown (terminals SURVIVE in their tmux servers). */
    stopHosts: () => { for (const { host, mgr } of mgrs.values()) { try { mgr.flushAll(); host.stop() } catch { /* ignore */ } } }
  }
}
