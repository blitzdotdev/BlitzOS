// tmux-host.mjs — the session host, backed by tmux CONTROL MODE. This is the keystone of the
// multi-agent OS: a session is a real terminal running a command (a shell, `claude`/`codex` in a
// real TTY, a build/test runner). tmux (not an in-process PTY) is the backend on purpose:
//   • sessions SURVIVE a BlitzOS restart/crash (the tmux server outlives the app; we reattach),
//   • the user can `tmux attach` from their own terminal into the exact session BlitzOS shows,
//   • control mode is a plain stdin/stdout protocol — NO native addon / electron-rebuild.
// One tmux server (private socket under <workspace>/.blitzos/tmux), one tmux session, and each
// BlitzOS session is a tmux WINDOW multiplexed over ONE `tmux -C` control client. Protocol facts
// here were empirically verified against tmux 3.6 (see project memory), not assumed.
import { spawn as cpSpawn, execFileSync } from 'node:child_process'

const SCROLLBACK_BYTES = 256 * 1024
// Unescape tmux control-mode octal escapes in %output (\033=ESC, \015=CR, \012=LF, \010=BS, …).
const unescapeOutput = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
const toHex = (str) => Buffer.from(str, 'utf8').toString('hex').match(/../g)?.join(' ') || ''

/**
 * @param {{ socketPath:string, sessionName?:string, cols?:number, rows?:number, tmuxTmpdir?:string }} cfg
 * @returns a host whose interface matches what session-manager expects (spawn/write/resize/kill/onData/onExit/…)
 */
export function createTmuxHost(cfg) {
  const SOCK = cfg.socketPath
  const SESSION = cfg.sessionName || 'blitz'
  const DEF_COLS = cfg.cols || 120
  const DEF_ROWS = cfg.rows || 40
  const ENV = { ...process.env, ...(cfg.tmuxTmpdir ? { TMUX_TMPDIR: cfg.tmuxTmpdir } : {}) }

  let client = null // the control-client child process
  let lineBuf = ''
  let ready = null
  const sessions = new Map() // blitzId -> { id, window, pane, pid, cols, rows, exited, exitCode, ring:[], ringBytes, dataL:Set, exitL:Set }
  const byPane = new Map() // pane (%N) -> blitzId
  const cmdQueue = [] // FIFO of { resolve, reject } awaiting a %begin..%end block
  let curReply = null // { lines:[], error:false }

  const tmuxSync = (args) => execFileSync('tmux', ['-S', SOCK, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString()

  // Send a control-mode command and resolve with its reply lines (between %begin/%end).
  function command(cmd) {
    return new Promise((resolve, reject) => {
      cmdQueue.push({ resolve, reject })
      client.stdin.write(cmd + '\n')
    })
  }

  function routeOutput(pane, data) {
    const id = byPane.get(pane); if (!id) return
    const rec = sessions.get(id); if (!rec) return
    rec.ring.push(data); rec.ringBytes += data.length
    while (rec.ringBytes > SCROLLBACK_BYTES && rec.ring.length > 1) rec.ringBytes -= rec.ring.shift().length
    for (const l of rec.dataL) { try { l(data) } catch { /* a bad listener must not kill the stream */ } }
  }
  function windowClosed(win) {
    for (const rec of sessions.values()) {
      if (rec.window === win && !rec.exited) {
        rec.exited = true; rec.endedAt = Date.now()
        for (const l of rec.exitL) { try { l({ exitCode: rec.exitCode ?? 0, signal: null }) } catch { /* ignore */ } }
      }
    }
  }

  function onLine(ln) {
    if (curReply) { // inside a %begin..%end block
      if (ln.startsWith('%end')) { const q = cmdQueue.shift(); q && q.resolve(curReply.lines); curReply = null }
      else if (ln.startsWith('%error')) { const q = cmdQueue.shift(); q && q.resolve(curReply.lines); curReply = null } // tmux puts the error text in the lines
      else curReply.lines.push(ln)
      return
    }
    if (ln.startsWith('%begin')) { curReply = { lines: [] }; return }
    if (ln.startsWith('%output ')) {
      const sp = ln.indexOf(' ', 8) // after "%output %<pane> "
      const pane = ln.slice(8, sp)
      routeOutput(pane, unescapeOutput(ln.slice(sp + 1)))
      return
    }
    if (ln.startsWith('%window-close') || ln.startsWith('%unlinked-window-close')) {
      windowClosed('@' + ln.trim().split('@')[1]); return
    }
    // %window-add / %session-changed / %layout-change / %exit — not load-bearing for the host
    if (ln.startsWith('%exit')) { for (const rec of sessions.values()) if (!rec.exited) windowClosed(rec.window) }
  }

  /** Connect the control client (create the session if absent, else attach — idempotent, enables reattach). */
  function start() {
    if (ready) return ready
    ready = new Promise((resolve) => {
      client = cpSpawn('tmux', ['-S', SOCK, '-C', 'new-session', '-A', '-s', SESSION, '-x', String(DEF_COLS), '-y', String(DEF_ROWS)], { env: ENV, stdio: ['pipe', 'pipe', 'ignore'] })
      client.stdout.on('data', (d) => {
        lineBuf += d.toString()
        let i
        while ((i = lineBuf.indexOf('\n')) >= 0) { const ln = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1); onLine(ln) }
      })
      client.on('exit', () => { client = null }) // sessions survive; a caller re-start()s to reattach
      // NB: do NOT `set -g window-size manual` — verified to crash the tmux 3.6 server on the next
      // new-window. Windows follow the control client's size; resize() adjusts it via refresh-client.
      setTimeout(resolve, 250) // let the session/control handshake settle
    })
    return ready
  }

  /** Spawn a session = a tmux window named with the blitz id; returns its info once tmux assigns the pane. */
  async function spawn(id, opts = {}) {
    if (sessions.get(id) && !sessions.get(id).exited) return info(id)
    await start()
    const cols = opts.cols || DEF_COLS, rows = opts.rows || DEF_ROWS
    const args = ['new-window', '-t', SESSION, '-n', id, '-P', '-F', '#{window_id} #{pane_id} #{pane_pid}']
    if (opts.cwd) args.push('-c', opts.cwd)
    for (const [k, v] of Object.entries(opts.env || {})) args.push('-e', `${k}=${v}`)
    if (opts.command) args.push(opts.command) // a shell-command string; tmux runs it via the shell
    // new-window via control command so we capture the assigned ids from the reply
    const reply = await command(args.map(quoteArg).join(' '))
    const line = (reply.find((l) => /^@?\w*\s+%\d+/.test(l)) || reply[0] || '').trim()
    const [window, pane, pid] = line.split(/\s+/)
    const rec = { id, window, pane, pid: Number(pid) || null, cols, rows, exited: false, exitCode: null, endedAt: null, startedAt: Date.now(), ring: [], ringBytes: 0, dataL: new Set(), exitL: new Set() }
    sessions.set(id, rec); byPane.set(pane, id)
    if (cols !== DEF_COLS || rows !== DEF_ROWS) resize(id, cols, rows)
    return info(id)
  }

  // Fire-and-forget a control command; its %begin/%end reply is consumed by a no-op queue slot so the FIFO stays aligned.
  function sendRaw(cmd) { if (!client) return false; client.stdin.write(cmd + '\n'); cmdQueue.push({ resolve() {}, reject() {} }); return true }
  function write(id, data) {
    const rec = sessions.get(id); if (!rec || rec.exited || !client) return false
    const hex = toHex(String(data)); if (!hex) return true
    return sendRaw(`send-keys -t ${rec.pane} -H ${hex}`)
  }
  function resize(id, cols, rows) {
    const rec = sessions.get(id); if (!rec || rec.exited || !client) return false
    rec.cols = cols; rec.rows = rows
    // Windows follow the control client's size (per-window manual sizing crashes tmux 3.6); resize the client.
    return sendRaw(`refresh-client -C ${cols | 0}x${rows | 0}`)
  }
  function kill(id) {
    const rec = sessions.get(id); if (!rec) return false
    try { tmuxSync(['kill-window', '-t', rec.window]) } catch { /* already gone */ }
    if (!rec.exited) windowClosed(rec.window)
    return true
  }
  function remove(id) { kill(id); const rec = sessions.get(id); if (rec) byPane.delete(rec.pane); sessions.delete(id) }

  function onData(id, cb, { replay = true } = {}) {
    const rec = sessions.get(id); if (!rec) return () => {}
    if (replay && rec.ring.length) { try { cb(rec.ring.join('')) } catch { /* ignore */ } }
    rec.dataL.add(cb); return () => rec.dataL.delete(cb)
  }
  function onExit(id, cb) {
    const rec = sessions.get(id); if (!rec) return () => {}
    if (rec.exited) { try { cb({ exitCode: rec.exitCode ?? 0, signal: null }) } catch { /* ignore */ } return () => {} }
    rec.exitL.add(cb); return () => rec.exitL.delete(cb)
  }
  const scrollback = (id) => { const r = sessions.get(id); return r ? r.ring.join('') : '' }
  const has = (id) => sessions.has(id)
  const info = (id) => { const r = sessions.get(id); return r ? { id: r.id, pid: r.pid, window: r.window, pane: r.pane, cols: r.cols, rows: r.rows, exited: r.exited, exitCode: r.exitCode, startedAt: r.startedAt, endedAt: r.endedAt || null } : null }
  const list = () => [...sessions.values()].map((r) => info(r.id))

  /** Reattach-on-boot: query the live tmux server for windows (named with blitz ids) and re-register them. */
  async function adoptExisting() {
    await start()
    let out = ''
    try { out = tmuxSync(['list-windows', '-t', SESSION, '-F', '#{window_id} #{pane_id} #{window_name} #{pane_pid}']) } catch { return [] }
    const adopted = []
    for (const ln of out.trim().split('\n').filter(Boolean)) {
      const [window, pane, name, pid] = ln.trim().split(/\s+/)
      if (!name || sessions.has(name)) continue
      const rec = { id: name, window, pane, pid: Number(pid) || null, cols: DEF_COLS, rows: DEF_ROWS, exited: false, exitCode: null, endedAt: null, startedAt: Date.now(), ring: [], ringBytes: 0, dataL: new Set(), exitL: new Set() }
      // seed the ring from the survivor's scrollback so a reconnecting renderer repaints
      try { rec.ring.push(tmuxSync(['capture-pane', '-p', '-e', '-t', window])); rec.ringBytes = rec.ring[0].length } catch { /* ignore */ }
      sessions.set(name, rec); byPane.set(pane, name); adopted.push(name)
    }
    return adopted
  }

  function stop() { try { client && client.kill('SIGTERM') } catch { /* ignore */ } } // sessions SURVIVE
  function killServer() { try { tmuxSync(['kill-server']) } catch { /* ignore */ } } // sessions DIE
  function stopAll() { for (const id of [...sessions.keys()]) kill(id) }

  return { start, spawn, write, resize, kill, remove, onData, onExit, scrollback, has, info, list, adoptExisting, stop, killServer, stopAll }
}

// Minimal shell-arg quoting for control-mode command lines (single-quote, escape embedded quotes).
function quoteArg(a) {
  a = String(a)
  if (a === '' || /[^\w@%./:=,+-]/.test(a)) return "'" + a.replace(/'/g, `'\\''`) + "'"
  return a
}
