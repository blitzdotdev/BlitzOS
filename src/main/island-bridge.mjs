// BlitzOS half of BlitzIsland.app — the faceless macOS notch-HUD helper (plans/blitzos-dynamic-island.md).
//
// Electron-FREE on purpose (only 'ws' + node 'child_process'/'fs', path/query parsed with the global URL):
// scripts/test-island-bridge.mjs drives this under plain `node` with a stock http.Server. The control
// server owns the http.Server + the per-session bearer token; this module only (a) mounts a /island
// WebSocket on that server and (b) launches/supervises the native bundle. The bundle PATH is resolved by
// the caller in index.ts (which has electron) and passed to launchIslandHelper(appPath) — exactly the same
// electron-free split as os-tools.mjs vs electron-os-tools.ts.
//
// Wire protocol (must match native/island-helper/main.swift — verified):
//   - Message-framed JSON TEXT frames, ONE JSON object per ws.send (NOT newline-delimited).
//   - The island connects to ws://<host>:<port>/island?token=<token> (token read fresh from
//     ~/.blitzos/session.json local.{url,token}); on open it sends {t:'hello',token,pid,bundleId}.
//   - The island answers {t:'ping'} with {t:'pong'}, logs {t:'hello'} acks, and logs+ignores any other
//     frame (P1/P2 will render process.list/process.event). So our connect-time {t:'process.list',...}
//     stub is forward-safe, and our {t:'ping'} elicits a real {t:'pong'}.

import { WebSocketServer } from 'ws'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const log = (...a) => console.log('[island]', ...a)

/** Send a JSON frame iff the socket is OPEN; never throw out of a send (a racing close mid-send must not
 *  crash main). */
function safeSend(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  } catch {
    /* dropped */
  }
}

// Injected by index.ts (which has electron) BEFORE the control server starts. Pure-node default is a no-op
// stub so a connect before wiring (or a test that never injects) degrades to an empty list, never throws.
// SAME electron-free split as os-tools.mjs vs electron-os-tools.ts. The bridge stays vocabulary-free: it
// String()-coerces whatever the deps emit (no status-mapping, no chat parsing) — index.ts owns all of that.
let deps = {
  spawn: () => ({ id: '', title: '' }), // ({prompt, paths, orchestrators}) -> {id, title}
  message: () => {}, // ({id, text, paths})
  setOrchestrators: () => {}, // (id, on)
  listProcesses: () => [], // () -> [{id, title, state}]
  subscribeEvents: () => () => {} // (cb) -> unsubscribe;  cb({id, line:{at,text}}) OR cb({id, upsert:{title?, state?}})
}
/** Replace the injected dependencies (index.ts calls this once, before startControlServer). Shallow-merged
 *  so a partial inject (e.g. a test overriding only `spawn`) keeps the no-op defaults for the rest. */
export function setIslandDeps(next) {
  if (next && typeof next === 'object') deps = { ...deps, ...next }
}

/** Normalize a process-list snapshot to the wire shape — String()-coerce every field, default state 'idle'.
 *  Vocabulary-agnostic: whatever status string the dep emits passes straight through (index.ts maps the host
 *  vocabulary to the island's before it ever reaches here). */
function normalizeList(arr) {
  return (Array.isArray(arr) ? arr : []).map((p) => ({
    id: String(p?.id),
    title: String(p?.title ?? ''),
    state: String(p?.state ?? 'idle')
  }))
}
/** Pick only the present fields of an upsert (title/state), String()-coerced — an absent field is omitted so
 *  the island merges instead of clobbering. */
function pickUpsert(u) {
  const o = {}
  if (u && u.title != null) o.title = String(u.title)
  if (u && u.state != null) o.state = String(u.state)
  return o
}

/** Mount a token-gated /island WebSocketServer on an EXISTING http.Server (the localhost control server).
 *  noServer:true so WE own the upgrade handshake: a non-/island upgrade is left untouched for any future
 *  consumer, and a bad/absent ?token= is 401'd BEFORE any ws handshake completes. The token is the SAME
 *  bearer the control server minted (and wrote to session.json local.token, which the island reads). An
 *  empty/falsy token is TEST-ONLY "no auth required"; the production caller always passes the real token.
 *  Returns the wss (handy for tests/teardown). */
export function attachIslandWebSocket(server, token) {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1') // base only to parse pathname + query
      if (u.pathname !== '/island') {
        // Not ours: do NOTHING (do not destroy) — leave the socket for any other upgrade listener. There is
        // no other upgrade consumer on the control server today; a future one must also early-return on a
        // non-matching path.
        return
      }
      const got = u.searchParams.get('token')
      if (!token || got !== token) {
        // Reject BEFORE handleUpgrade so no WebSocket object is ever created for a bad token. Raw socket
        // write (the upgrade has no res object) — note the trailing CRLFCRLF. ws surfaces this to the client
        // as an 'unexpected-response' (statusCode 401) and/or 'error', never 'open'.
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => onIslandConnection(ws))
    } catch {
      // A malformed upgrade must never crash main.
      try {
        socket.destroy()
      } catch {
        /* gone */
      }
    }
  })

  return wss
}

/** Per-connection lifecycle. On connect: send the process.list snapshot (from deps.listProcesses — the
 *  injected runtime; the pure-node default is an empty array) THEN a ping (the island answers pong). Live:
 *  deps.subscribeEvents fans reply LINES (process.event) + status/auto-name UPSERTS (process.upsert) to THIS
 *  socket; the subscription is PER-CONNECTION and MUST be unsubscribed on close AND error (else a dropped
 *  island leaks a subscriber per connect, and safeSend keeps firing on a dead ws each event). Inbound:
 *  process.spawn/message/orchestrators dispatch to the matching dep (each wrapped in try/catch so a throwing
 *  dep never crashes main / the socket); hello (log) / pong (mark alive) unchanged. */
export function onIslandConnection(ws) {
  log('island connected')
  ws._islandAlive = true

  // (1) Initial snapshot + a ping. Order matters: process.list THEN ping (the test + native both depend on
  // this order). Inside handleUpgrade the socket is OPEN, but safeSend guards a racing close anyway. A
  // throwing dep degrades to an empty list — never crash a fresh connection.
  let initial = []
  try {
    initial = deps.listProcesses() || []
  } catch {
    initial = []
  }
  safeSend(ws, { t: 'process.list', processes: normalizeList(initial) })
  safeSend(ws, { t: 'ping' })

  // (2) Live events: forward reply lines + status/auto-name upserts to THIS socket. subscribeEvents is
  // process-global; subscribe per-connection so teardown is local (no module-level Set to reap). The cb
  // carries one of three shapes — {id,line} (a reply line), {id,upsert} (status/auto-name), or {list} (a
  // full re-snapshot, optional). The runtime stamps `line.at` (time lives in index.ts, not this pure module).
  let unsub = () => {}
  try {
    unsub =
      deps.subscribeEvents((ev) => {
        if (!ev || ev.id == null) {
          // a list-only re-snapshot has no id; handle it before the id guard rejects it
          if (ev && ev.list) safeSend(ws, { t: 'process.list', processes: normalizeList(ev.list) })
          return
        }
        if (ev.line) {
          safeSend(ws, {
            t: 'process.event',
            id: String(ev.id),
            line: { at: Number(ev.line.at) || Date.now(), text: String(ev.line.text ?? '') }
          })
        } else if (ev.upsert) {
          safeSend(ws, { t: 'process.upsert', id: String(ev.id), ...pickUpsert(ev.upsert) })
        } else if (ev.list) {
          safeSend(ws, { t: 'process.list', processes: normalizeList(ev.list) })
        }
      }) || (() => {})
  } catch {
    unsub = () => {}
  }

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString()) // ws hands a Buffer; coerce to string first
    } catch {
      return // ignore non-JSON frames (symmetric with the island's own tolerance)
    }
    const t = msg && typeof msg === 'object' ? msg.t : undefined
    switch (t) {
      case 'hello':
        // The token in the hello frame is informational — the upgrade ?token= already authenticated; do NOT
        // re-reject here.
        log('hello from island', msg.pid != null ? `pid=${msg.pid}` : '', msg.bundleId || '')
        break
      case 'pong':
        ws._islandAlive = true
        log('pong (alive)')
        break
      case 'process.spawn': {
        // chat-bar Send. orchestrators = the tab toggle (default false → conversational spawn-OFF path in
        // index.ts). The real id/title come back synchronously; status/auto-name converge later via the tail.
        let r = null
        try {
          r = deps.spawn({
            prompt: String(msg.prompt ?? ''),
            paths: Array.isArray(msg.paths) ? msg.paths : [],
            orchestrators: !!msg.orchestrators
          })
        } catch (e) {
          log('spawn failed', e?.message)
        }
        // Optimistic upsert so the HUD shows the new tab the instant Send returns (state 'new' until the
        // first reply line / status flips it). Benign-additive to the test contract.
        if (r && r.id != null) safeSend(ws, { t: 'process.upsert', id: String(r.id), title: String(r.title ?? ''), state: 'new' })
        break
      }
      case 'process.message': {
        if (msg.id != null) {
          try {
            deps.message({ id: String(msg.id), text: String(msg.text ?? ''), paths: Array.isArray(msg.paths) ? msg.paths : [] })
          } catch (e) {
            log('message failed', e?.message)
          }
        }
        break
      }
      case 'process.orchestrators': {
        if (msg.id != null) {
          try {
            deps.setOrchestrators(String(msg.id), !!msg.on)
          } catch (e) {
            log('setOrchestrators failed', e?.message)
          }
        }
        break
      }
      default:
        // Forward path for any future process.* frames FROM the island; never throw.
        if (t) log('frame:', t)
        break
    }
  })

  // TODO (keepalive): a future setInterval that pings every N s and ws.terminate()s a socket that missed the
  // prior pong would reap a silently-dead island (a crash with no close frame). If added, it MUST be
  // clearInterval'd in BOTH 'close' and 'error' and .unref()'d so node can exit / the test never hangs.
  ws.on('error', () => {
    // swallow — never crash main on a guest socket error — but stop forwarding (the subscriber must not leak).
    try {
      unsub()
    } catch {
      /* gone */
    }
  })
  ws.on('close', () => {
    try {
      unsub()
    } catch {
      /* gone */
    }
    log('island closed')
  })
}

/** Launch + supervise BlitzIsland.app at a RESOLVED path (resolution is the caller's job so this stays
 *  electron-free). macOS only (a no-op handle elsewhere so the index.ts wiring is unconditional). Single-
 *  instance: a `pgrep -x BlitzIsland` probe SKIPS the launch when one is already running — the island is a
 *  singleton LSUIElement and `requestSingleInstanceLock` only guards a second BlitzOS, NOT an orphaned helper
 *  from a prior run. So `open` is used WITHOUT `-n` (unlike the CU helper, which forces a fresh instance):
 *  `-n` would stack duplicate notch HUDs. NO --connect/--port/--token args either — the island self-discovers
 *  url+token fresh from session.json on every backoff attempt, which is the whole point of port-change
 *  survival. Supervision is a POLL (open detaches the helper to LaunchServices, so there is no child-exit
 *  event to hook — execFile's callback fires when `open` returns, not when BlitzIsland exits): a periodic
 *  pgrep relaunches a missing instance after a debounce (prevents a tight respawn loop if it crash-loops). */
export function launchIslandHelper(appPath, opts = {}) {
  if (process.platform !== 'darwin') return { stop() {} }
  if (!appPath || !existsSync(appPath)) {
    // A missing bundle in dev (before native/island-helper/build.sh runs) must NOT crash BlitzOS — degrade
    // silently with a no-op handle (mirrors computer-use-helper.ts returning {ok:false} instead of throwing).
    console.error('[island] BlitzIsland.app not found at', appPath)
    return { stop() {} }
  }

  const debounceMs = opts.debounceMs ?? 800 // matches the CU helper's respawn delay
  // Injectable command runners (for a future launch test); default to the real pgrep/open. launch is NOT
  // exercised by scripts/test-island-bridge.mjs (no .app in CI, macOS+open-dependent) — only the WS half is.
  const pgrep =
    opts.pgrep ??
    ((cb) => execFile('/usr/bin/pgrep', ['-x', 'BlitzIsland'], (err, stdout) => cb(!err && String(stdout).trim().length > 0)))
  const open =
    opts.open ??
    ((p) =>
      execFile('/usr/bin/open', [p], (err) => {
        if (err) log('open failed:', err.message)
        else log('launched', p)
      }))

  let stopped = false
  let restartTimer = null

  const spawn = () => {
    if (stopped) return
    pgrep((running) => {
      if (stopped) return
      if (running) {
        log('BlitzIsland already running — reusing')
        return
      }
      open(appPath)
    })
  }

  // Supervise = debounced relaunch on exit, but via a pgrep POLL (no child handle to listen on). Cheap (one
  // pgrep / 4s). unref so the timer never keeps node alive (clean quit + test safety).
  const poll = setInterval(() => {
    if (stopped) return
    pgrep((running) => {
      if (running || stopped || restartTimer) return
      restartTimer = setTimeout(() => {
        restartTimer = null
        spawn()
      }, debounceMs)
    })
  }, 4000)
  poll.unref?.()

  spawn() // initial launch

  return {
    // Non-destructive by default: stop OUR supervision only; leave the running island alive so a `npm run dev`
    // reload doesn't kill the HUD the user is watching (the island survives a BlitzOS restart by re-reading
    // session.json on its backoff). A deliberate kill-on-quit would be `execFile('/usr/bin/pkill',['-x',
    // 'BlitzIsland'])` — intentionally NOT done unless the product decides the HUD should vanish with BlitzOS.
    stop() {
      stopped = true
      clearInterval(poll)
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = null
      }
    }
  }
}
