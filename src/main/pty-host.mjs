// pty-host.mjs — the transport-agnostic PTY primitive, the KEYSTONE of the session model.
//
// A "session" in BlitzOS is a real pseudo-terminal running a command — a shell, `claude`,
// `codex`, `aider`, a build/test runner, anything. This one primitive replaces ghostty
// (interactive shells), hosts coding agents (a `claude`/`codex` process in a real TTY), and
// runs long jobs. It is deliberately content-agnostic: it spawns a process, streams its
// output bytes, accepts input + resize, and reports exit — it makes no decisions about what
// runs (the user / an agent does).
//
// Streaming model (mirrors the proven screencast seam): each session keeps a bounded
// scrollback ring, exactly like `lastFrame` caches the last JPEG, so a renderer that connects
// (or reconnects) repaints immediately instead of seeing a blank terminal. Both transports
// stream these bytes to a terminal surface the same way they stream screencast frames — the
// server over the `/api/os/stream` WS, Electron over IPC — and send keystrokes back. ONE host,
// both modes: this module is a shared core (the parity guard covers it).
import { spawn as ptySpawn } from 'node-pty'

const DEFAULT_SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : 'bash')
// Per-session scrollback cap. Enough to repaint a full screen + recent history on (re)connect;
// the durable transcript lives in the workspace (session-manager), this ring is just for replay.
const SCROLLBACK_BYTES = 256 * 1024

/**
 * Create a PTY host: a registry of live pseudo-terminals keyed by session id.
 * @returns {{
 *   spawn:(id:string,opts?:object)=>object, write:(id:string,data:string)=>boolean,
 *   resize:(id:string,cols:number,rows:number)=>boolean, kill:(id:string,signal?:string)=>boolean,
 *   remove:(id:string)=>void, onData:(id:string,cb:(d:string)=>void,opts?:object)=>()=>void,
 *   onExit:(id:string,cb:(e:{exitCode:number,signal:number|null})=>void)=>()=>void,
 *   has:(id:string)=>boolean, scrollback:(id:string)=>string, info:(id:string)=>object|null,
 *   list:()=>object[], stopAll:()=>void
 * }}
 */
export function createPtyHost() {
  const sessions = new Map() // id -> rec

  const summary = (r) => ({
    id: r.id, pid: r.pid, file: r.file, argv: r.argv, cwd: r.cwd,
    cols: r.cols, rows: r.rows, exited: r.exited, exitCode: r.exitCode, signal: r.signal,
    startedAt: r.startedAt, endedAt: r.endedAt || null
  })

  /** Spawn a PTY for `id`. If one already runs for that id, returns it unchanged (idempotent). */
  function spawn(id, opts = {}) {
    const existing = sessions.get(id)
    if (existing && !existing.exited) return summary(existing)

    let file = opts.command || DEFAULT_SHELL
    let argv = Array.isArray(opts.args) ? opts.args : []
    // A `command` string with spaces and no explicit args is run through the login shell, so a
    // user/agent can pass "claude -p '…' | tee log" verbatim and pipes/quoting work as typed.
    if (!argv.length && typeof file === 'string' && /\s/.test(file)) {
      argv = ['-lc', file]
      file = DEFAULT_SHELL
    }
    const cols = Math.max(1, opts.cols | 0) || 80
    const rows = Math.max(1, opts.rows | 0) || 24
    const cwd = opts.cwd || process.cwd()

    const p = ptySpawn(file, argv, {
      name: 'xterm-256color',
      cols, rows, cwd,
      env: { ...process.env, ...(opts.env || {}), TERM: 'xterm-256color' }
    })

    const rec = {
      id, pty: p, pid: p.pid, file, argv, cwd, cols, rows,
      exited: false, exitCode: null, signal: null, startedAt: Date.now(), endedAt: null,
      scrollback: [], scrollbackBytes: 0, dataListeners: new Set(), exitListeners: new Set()
    }
    p.onData((data) => {
      rec.scrollback.push(data)
      rec.scrollbackBytes += data.length
      while (rec.scrollbackBytes > SCROLLBACK_BYTES && rec.scrollback.length > 1) {
        rec.scrollbackBytes -= rec.scrollback.shift().length
      }
      for (const l of rec.dataListeners) { try { l(data) } catch { /* a bad listener must not kill the stream */ } }
    })
    p.onExit(({ exitCode, signal }) => {
      rec.exited = true
      rec.exitCode = typeof exitCode === 'number' ? exitCode : null
      rec.signal = signal ?? null
      rec.endedAt = Date.now()
      for (const l of rec.exitListeners) { try { l({ exitCode: rec.exitCode, signal: rec.signal }) } catch { /* ignore */ } }
    })
    sessions.set(id, rec)
    return summary(rec)
  }

  function write(id, data) {
    const r = sessions.get(id)
    if (r && !r.exited) { try { r.pty.write(data) } catch { /* pty gone */ } return true }
    return false
  }
  function resize(id, cols, rows) {
    const r = sessions.get(id)
    if (r && !r.exited) {
      const c = Math.max(1, cols | 0), rw = Math.max(1, rows | 0)
      try { r.pty.resize(c, rw); r.cols = c; r.rows = rw } catch { /* pty gone */ }
      return true
    }
    return false
  }
  function kill(id, signal) {
    const r = sessions.get(id)
    if (r && !r.exited) { try { r.pty.kill(signal) } catch { /* already gone */ } return true }
    return false
  }
  function remove(id) { kill(id); sessions.delete(id) }

  /** Subscribe to live output. Replays the scrollback first (so a (re)connecting renderer repaints). */
  function onData(id, cb, { replay = true } = {}) {
    const r = sessions.get(id)
    if (!r) return () => {}
    if (replay && r.scrollback.length) { try { cb(r.scrollback.join('')) } catch { /* ignore */ } }
    r.dataListeners.add(cb)
    return () => r.dataListeners.delete(cb)
  }
  function onExit(id, cb) {
    const r = sessions.get(id)
    if (!r) return () => {}
    if (r.exited) { try { cb({ exitCode: r.exitCode, signal: r.signal }) } catch { /* ignore */ } return () => {} }
    r.exitListeners.add(cb)
    return () => r.exitListeners.delete(cb)
  }

  const has = (id) => sessions.has(id)
  const scrollback = (id) => { const r = sessions.get(id); return r ? r.scrollback.join('') : '' }
  const info = (id) => { const r = sessions.get(id); return r ? summary(r) : null }
  const list = () => [...sessions.values()].map(summary)
  const stopAll = () => { for (const id of sessions.keys()) kill(id) }

  return { spawn, write, resize, kill, remove, onData, onExit, has, scrollback, info, list, stopAll }
}
