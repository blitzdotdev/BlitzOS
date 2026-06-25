// tmux-host.mjs — the terminal host, backed by tmux CONTROL MODE. This is the keystone of the
// multi-agent OS: a terminal is a real terminal running a command (a shell, `claude`/`codex` in a
// real TTY, a build/test runner). tmux (not an in-process PTY) is the backend on purpose:
//   • terminals SURVIVE a BlitzOS restart/crash (the tmux server outlives the app; we reattach),
//   • the user can `tmux attach` from their own terminal into the exact terminal BlitzOS shows,
//   • control mode is a plain stdin/stdout protocol — NO native addon / electron-rebuild.
// One tmux server (private socket under <workspace>/.blitzos/tmux), one tmux session, and each
// BlitzOS terminal is a tmux WINDOW multiplexed over ONE `tmux -C` control client. Protocol facts
// here were empirically verified against tmux 3.6 (see project memory), not assumed.
import { spawn as cpSpawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

const SCROLLBACK_BYTES = 256 * 1024
// Unescape tmux control-mode octal escapes in %output (\033=ESC, \015=CR, \012=LF, \010=BS, …).
const unescapeOutput = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
const toHex = (str) => Buffer.from(str, 'utf8').toString('hex').match(/../g)?.join(' ') || ''

/**
 * @param {{ socketPath:string, sessionName?:string, cols?:number, rows?:number, tmuxTmpdir?:string }} cfg
 * @returns a host whose interface matches what terminal-manager expects (spawn/write/resize/kill/onData/onExit/…)
 */
/** Resolve the tmux binary. The BUNDLED portable tmux wins (ships in Resources/bin — the user never
 *  installs anything); env override beats it for power users; then well-known locations and the
 *  login shell as legacy fallbacks. Cached; null = nothing anywhere (effectively impossible now). */
let resolvedTmux
export function resolveTmuxBin() {
  if (resolvedTmux !== undefined) return resolvedTmux
  const here = dirname(fileURLToPath(import.meta.url))
  const cands = [
    process.env.BLITZ_TMUX_BIN,
    typeof process.resourcesPath === 'string' ? join(process.resourcesPath, 'bin', 'tmux') : null, // packaged
    join(here, '..', '..', 'vendor', 'bin', 'tmux'), // dev repo layout (out/main/../../vendor)
    '/opt/homebrew/bin/tmux',
    '/usr/local/bin/tmux',
    '/usr/bin/tmux'
  ].filter(Boolean)
  // Accept a candidate only if it actually RUNS on this platform — `existsSync` alone wrongly picks the
  // vendored Mac-arm64 tmux on a Linux/dev box, whose control client then fails to spawn (the manager
  // can't track live windows → terminals show a phantom "exited"). `-V` is a cheap arch/runnability probe.
  const runnable = (p) => { try { execFileSync(p, ['-V'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 4000 }); return true } catch { return false } }
  resolvedTmux = cands.find((p) => runnable(p)) || null
  if (!resolvedTmux) {
    try {
      const fromShell = execFileSync('/bin/zsh', ['-lc', 'command -v tmux'], { encoding: 'utf8', timeout: 8000 }).trim()
      resolvedTmux = fromShell && runnable(fromShell) ? fromShell : null
    } catch { resolvedTmux = null }
  }
  return resolvedTmux
}

export function createTmuxHost(cfg) {
  const SOCK = cfg.socketPath
  const SESSION = cfg.sessionName || 'blitz'
  const DEF_COLS = cfg.cols || 120
  const DEF_ROWS = cfg.rows || 40
  const ENV = { ...process.env, ...(cfg.tmuxTmpdir ? { TMUX_TMPDIR: cfg.tmuxTmpdir } : {}) }
  // The tmux binary — overridable so the packaged app can point at a BUNDLED tmux (extraResources)
  // instead of relying on one on PATH. Resolution order: cfg/env override → well-known install
  // locations → the user's login-shell PATH (a packaged GUI app gets the bare system PATH, which
  // has no homebrew — the claudeCliPath problem). NULL = tmux not installed: the host DEGRADES
  // (sessions/terminals unavailable) instead of crashing main with an uncaught spawn ENOENT —
  // the VM-boot crash of 2026-06-11.
  const TMUX = cfg.tmuxBin || resolveTmuxBin()
  if (!TMUX) console.error('[tmux-host] tmux not found (brew install tmux) — agent terminals are disabled this run')

  let client = null // the control-client child process
  let lineBuf = ''
  let ready = null
  const terminals = new Map() // blitzId -> { id, window, pane, pid, cols, rows, exited, exitCode, ring:[], ringBytes, dataL:Set, exitL:Set }
  const byPane = new Map() // pane (%N) -> blitzId
  const cmdQueue = [] // FIFO of { resolve, reject } awaiting a %begin..%end block
  let curReply = null // { lines:[], error:false }

  const tmuxSync = (args) => (TMUX ? execFileSync(TMUX, ['-S', SOCK, ...args], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString() : '')

  // Send a control-mode command and resolve with its reply lines (between %begin/%end).
  function command(cmd) {
    return new Promise((resolve, reject) => {
      if (!client) { reject(new Error('no tmux control client')); return } // dead client — don't throw a TypeError
      cmdQueue.push({ resolve, reject })
      client.stdin.write(cmd + '\n')
    })
  }

  function routeOutput(pane, data) {
    const id = byPane.get(pane); if (!id) return
    const rec = terminals.get(id); if (!rec) return
    rec.ring.push(data); rec.ringBytes += data.length
    while (rec.ringBytes > SCROLLBACK_BYTES && rec.ring.length > 1) rec.ringBytes -= rec.ring.shift().length
    for (const l of rec.dataL) { try { l(data) } catch { /* a bad listener must not kill the stream */ } }
  }
  function windowClosed(win) {
    for (const rec of terminals.values()) {
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
    // %window-add / %session-changed / %layout-change — not load-bearing. NB: %exit means the CONTROL
    // CLIENT is detaching, NOT that terminals died — the windows survive in the tmux server, so do NOT
    // mark them exited here (client.on('exit') resets connection state so a later start() reattaches).
  }

  /** Connect the control client (create the session if absent, else attach — idempotent, enables reattach). */
  function start() {
    if (ready) return ready
    if (!TMUX) {
      ready = Promise.resolve() // disabled host: every op below no-ops against a null client
      return ready
    }
    ready = new Promise((resolve) => {
      client = cpSpawn(TMUX, ['-S', SOCK, '-C', 'new-session', '-A', '-s', SESSION, '-x', String(DEF_COLS), '-y', String(DEF_ROWS)], { env: ENV, stdio: ['pipe', 'pipe', 'ignore'] })
      // ENOENT (and any other spawn failure) arrives as an async 'error' event — without this handler
      // it becomes an UNCAUGHT main-process exception (the "JavaScript error in the main process"
      // dialog on a tmux-less machine). Log, drop the client, and let boot continue degraded.
      client.on('error', (e) => {
        console.error('[tmux-host] tmux unavailable:', e?.message || e)
        client = null
        resolve()
      })
      // A UTF-8 StringDecoder (per connection) buffers a multibyte char split across stdout chunks — tmux
      // passes high UTF-8 bytes RAW in %output, so a plain per-chunk d.toString() would corrupt TUI frames.
      const dec = new StringDecoder('utf8')
      client.stdout.on('data', (d) => {
        lineBuf += dec.write(d)
        let i
        while ((i = lineBuf.indexOf('\n')) >= 0) { const ln = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1); onLine(ln) }
      })
      // Reset ALL connection state on exit so a later start() (e.g. adoptExisting) actually re-spawns the
      // control client instead of returning the stale memoized `ready` (which left it permanently dead).
      client.on('exit', () => {
        client = null; ready = null; lineBuf = ''; curReply = null
        while (cmdQueue.length) { const q = cmdQueue.shift(); try { q && q.reject && q.reject(new Error('tmux control client exited')) } catch { /* ignore */ } }
      })
      // NB: do NOT `set -g window-size manual` — verified to crash the tmux 3.6 server on the next
      // new-window. Windows follow the control client's size; resize() adjusts it via refresh-client.
      // The default window (index 0) new-session creates is NOT a BlitzOS terminal — name it so adopt
      // skips it. Target index 0 explicitly (NOT the active window — on reattach that's a real terminal).
      sendRaw(`rename-window -t ${SESSION}:0 __blitzroot__`)
      setTimeout(resolve, 250) // let the session/control handshake settle
    })
    return ready
  }

  /** Spawn a terminal = a tmux window named with the blitz id; returns its info once tmux assigns the pane. */
  async function spawn(id, opts = {}) {
    if (terminals.get(id) && !terminals.get(id).exited) return info(id)
    await start()
    const cols = opts.cols || DEF_COLS, rows = opts.rows || DEF_ROWS
    const args = ['new-window', '-t', SESSION, '-n', id, '-P', '-F', '#{window_id} #{pane_id} #{pane_pid}']
    if (opts.cwd) args.push('-c', opts.cwd)
    for (const [k, v] of Object.entries(opts.env || {})) args.push('-e', `${k}=${v}`)
    if (opts.command) args.push(opts.command) // a shell-command string; tmux runs it via the shell
    // new-window via control command so we capture the assigned ids from the reply. quoteArg THROWS on a
    // control char (the injection guard) and command() REJECTS if the client died — return null either way.
    let reply
    try { reply = await command(args.map(quoteArg).join(' ')) } catch (e) { console.error('[tmux-host] spawn rejected:', e?.message || e); return null }
    const line = (reply.find((l) => /^@\d+\s+%\d+/.test(l)) || '').trim()
    const [window, pane, pid] = line.split(/\s+/)
    // A %error reply (e.g. bad cwd) yields no valid "@N %N" line — DON'T register a zombie that looks alive.
    if (!/^@\d+$/.test(window || '') || !/^%\d+$/.test(pane || '')) { console.error('[tmux-host] new-window failed:', reply.join(' ').slice(0, 140)); return null }
    const rec = { id, window, pane, pid: Number(pid) || null, cols, rows, exited: false, exitCode: null, endedAt: null, startedAt: Date.now(), ring: [], ringBytes: 0, dataL: new Set(), exitL: new Set() }
    terminals.set(id, rec); byPane.set(pane, id)
    if (cols !== DEF_COLS || rows !== DEF_ROWS) resize(id, cols, rows)
    return info(id)
  }

  // Fire-and-forget a control command; its %begin/%end reply is consumed by a no-op queue slot so the FIFO stays aligned.
  function sendRaw(cmd) { if (!client) return false; client.stdin.write(cmd + '\n'); cmdQueue.push({ resolve() {}, reject() {} }); return true }
  function write(id, data) {
    const rec = terminals.get(id); if (!rec || rec.exited || !client) return false
    const hex = toHex(String(data)); if (!hex) return true
    return sendRaw(`send-keys -t ${rec.pane} -H ${hex}`)
  }
  function resize(id, cols, rows) {
    const rec = terminals.get(id); if (!rec || rec.exited || !client) return false
    rec.cols = cols; rec.rows = rows
    // Windows follow the control client's size (per-window manual sizing crashes tmux 3.6); resize the client.
    return sendRaw(`refresh-client -C ${cols | 0}x${rows | 0}`)
  }
  // `tmux kill-window` only SIGHUPs the pane's foreground process GROUP — claude's detached children and the
  // agent's run_in_background jobs (the wait.sh curl loop, node workflow runners) survive, orphaned to launchd
  // as high-CPU zombies. So capture the pane's whole process TREE first, kill the window, then SIGKILL the tree
  // (by pid, valid even after they reparent to pid 1). Bounds the leak that piled up zombies + a 99% CPU spin.
  function paneProcessTree(panePid) {
    if (!panePid || panePid <= 1) return []
    let out = ''
    try { out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 4000 }) } catch { return [panePid] }
    const kids = new Map()
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/); if (!m) continue
      const pid = +m[1], ppid = +m[2]
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(pid)
    }
    const acc = [], stack = [panePid]
    while (stack.length) { const p = stack.pop(); for (const c of kids.get(p) || []) { acc.push(c); stack.push(c) } }
    return [...acc, panePid] // descendants first, root last
  }
  function kill(id) {
    const rec = terminals.get(id); if (!rec) return false
    let tree = []
    try {
      const pp = parseInt(String(tmuxSync(['display-message', '-p', '-t', rec.pane, '#{pane_pid}'])).trim(), 10) || 0
      if (pp) tree = paneProcessTree(pp)
    } catch { /* pane already gone */ }
    try { tmuxSync(['kill-window', '-t', rec.window]) } catch { /* already gone */ }
    for (const pid of tree) { try { process.kill(pid, 'SIGKILL') } catch { /* already dead */ } }
    if (!rec.exited) windowClosed(rec.window)
    return true
  }
  function remove(id) { kill(id); const rec = terminals.get(id); if (rec) byPane.delete(rec.pane); terminals.delete(id) }

  function onData(id, cb, { replay = true } = {}) {
    const rec = terminals.get(id); if (!rec) return () => {}
    if (replay && rec.ring.length) { try { cb(rec.ring.join('')) } catch { /* ignore */ } }
    rec.dataL.add(cb); return () => rec.dataL.delete(cb)
  }
  function onExit(id, cb) {
    const rec = terminals.get(id); if (!rec) return () => {}
    if (rec.exited) { try { cb({ exitCode: rec.exitCode ?? 0, signal: null }) } catch { /* ignore */ } return () => {} }
    rec.exitL.add(cb); return () => rec.exitL.delete(cb)
  }
  const scrollback = (id) => { const r = terminals.get(id); return r ? r.ring.join('') : '' }
  // Current RENDERED pane text (capture-pane -p, no escapes) — the wake watchdog diffs this across a settle
  // window to tell a frozen/idle pane from one actively producing output, without parsing TUI semantics.
  function capture(id) { const r = terminals.get(id); if (!r) return ''; try { return tmuxSync(['capture-pane', '-p', '-t', r.pane]) } catch { return '' } }
  const has = (id) => terminals.has(id)
  const info = (id) => { const r = terminals.get(id); return r ? { id: r.id, pid: r.pid, window: r.window, pane: r.pane, cols: r.cols, rows: r.rows, exited: r.exited, exitCode: r.exitCode, startedAt: r.startedAt, endedAt: r.endedAt || null } : null }
  const list = () => [...terminals.values()].map((r) => info(r.id))

  /** Coordinates for an EXTERNAL terminal app (e.g. Ghostty) to `tmux attach` this terminal's live
   *  window. Returns the unambiguous tmux window-id (@N) as `window` — NEVER a session:name target:
   *  blitz ids are numeric and a numeric tmux target is read as a window INDEX, so `blitz:0` resolves to
   *  whatever sits at index 0 (the __blitzroot__ window), never the agent window NAMED '0' (verified on
   *  tmux 3.5a). null when tmux is unavailable or the terminal isn't a live window (exited/unknown) — the
   *  caller shows a clean "not live" message instead of attaching onto a dead/missing pane. */
  function attachSpec(id) {
    if (!TMUX) return null
    const rec = terminals.get(id)
    if (!rec || rec.exited) return null
    return { bin: TMUX, socket: SOCK, session: SESSION, window: rec.window }
  }

  /** Reattach-on-boot: query the live tmux server for windows (named with blitz ids) and re-register them. */
  async function adoptExisting() {
    await start()
    let out = ''
    try { out = tmuxSync(['list-windows', '-t', SESSION, '-F', '#{window_id} #{pane_id} #{window_name} #{pane_pid} #{pane_dead} #{pane_dead_status}']) } catch { return [] }
    const adopted = []
    for (const ln of out.trim().split('\n').filter(Boolean)) {
      const [window, pane, name, pid, dead, deadStatus] = ln.trim().split(/\s+/)
      if (!name || name === '__blitzroot__' || terminals.has(name)) continue
      const isDead = dead === '1' // a lingering dead pane (remain-on-exit) — adopt as EXITED, not live, so it doesn't stick at "running"
      const rec = { id: name, window, pane, pid: Number(pid) || null, cols: DEF_COLS, rows: DEF_ROWS, exited: isDead, exitCode: isDead ? (Number(deadStatus) || 0) : null, endedAt: isDead ? Date.now() : null, startedAt: Date.now(), ring: [], ringBytes: 0, dataL: new Set(), exitL: new Set() }
      // seed the ring from the survivor's scrollback so a reconnecting renderer repaints
      try { rec.ring.push(tmuxSync(['capture-pane', '-p', '-e', '-t', window])); rec.ringBytes = rec.ring[0].length } catch { /* ignore */ }
      terminals.set(name, rec); byPane.set(pane, name); adopted.push(name)
    }
    return adopted
  }

  function stop() { try { client && client.kill('SIGTERM') } catch { /* ignore */ } } // terminals SURVIVE
  function killServer() { try { tmuxSync(['kill-server']) } catch { /* ignore */ } } // terminals DIE
  function stopAll() { for (const id of [...terminals.keys()]) kill(id) }

  return { start, spawn, write, resize, kill, remove, onData, onExit, scrollback, capture, has, info, list, attachSpec, adoptExisting, stop, killServer, stopAll }
}

// Minimal shell-arg quoting for control-mode command lines (single-quote, escape embedded quotes).
function quoteArg(a) {
  a = String(a)
  // SECURITY: tmux control mode ends a command at a newline REGARDLESS of quoting, so a value with a
  // control char (esp. LF) would break out of the new-window line and inject a second tmux command
  // (run-shell = arbitrary host RCE, kill-server, …). There is no in-band escape — reject it. (Keystroke
  // input never comes through here; write() uses send-keys -H with hex bytes.)
  if (/[\x00-\x1f\x7f]/.test(a)) throw new Error('illegal control character in tmux argument')
  if (a === '' || /[^\w@%./:=,+-]/.test(a)) return "'" + a.replace(/'/g, `'\\''`) + "'"
  return a
}

// Is tmux runnable? Returns its version string (e.g. "tmux 3.6") or null. Used for a startup preflight.
export function tmuxAvailable(bin) {
  try { return execFileSync(bin || resolveTmuxBin() || 'tmux', ['-V'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return null }
}
