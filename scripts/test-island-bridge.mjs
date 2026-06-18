// test-island-bridge.mjs — prove the Electron-FREE island WS bridge (src/main/island-bridge.mjs) does the
// load-bearing thing: it mounts a token-gated /island WebSocket on a plain http.Server and speaks the exact
// wire protocol BlitzIsland.app expects (native/island-helper/main.swift). Pure node — no electron, no GUI:
// attachIslandWebSocket is the half that runs under `node`, so we drive it with a stock http server and a `ws`
// client. The launch/supervise half (launchIslandHelper) is macOS+`open`-dependent and is NOT executed here
// (no .app in CI); its contract is covered by inspection + the no-throw/no-op guards, and Part B audits the
// electron-bound WIRING off disk so a regression that can't run under node still fails. Run with
// `node scripts/test-island-bridge.mjs`.
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachIslandWebSocket, setIslandDeps } from '../src/main/island-bridge.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

// Hang guard: if a connect-time ping/process.list frame regresses (never arrives), FAIL via timeout rather
// than blocking CI forever (mirrors test-launcher.mjs's deterministic exit). unref so it never holds node open
// once the run finishes cleanly.
const hang = setTimeout(() => {
  console.log('\nTIMEOUT — a frame never arrived; the bridge contract regressed')
  process.exit(1)
}, 8000)
hang.unref?.()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function runWsTests() {
  console.log('Island WS bridge (src/main/island-bridge.mjs):')

  const TOKEN = 'test-token-' + Math.random().toString(16).slice(2)
  const server = createServer((_q, r) => {
    r.writeHead(404)
    r.end()
  })
  attachIslandWebSocket(server, TOKEN)
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port

  // Open a client to a given query path; resolve { ws, frames, result, errored, closed, statusCode }. `result`
  // settles to 'open' / 'rejected' (error or unexpected-response) / 'timeout'. Frames are parsed JSON objects.
  const connect = (pathAndQuery, settleMs = 3000) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`)
    const state = { ws, frames: [], result: null, errored: false, closed: false, statusCode: 0 }
    return new Promise((resolve) => {
      const settle = (r) => {
        if (!state.result) state.result = r
      }
      const to = setTimeout(() => {
        settle('timeout')
        resolve(state)
      }, settleMs)
      ws.on('open', () => {
        settle('open')
        clearTimeout(to)
        resolve(state)
      })
      // ws surfaces a server 401 (our raw socket write) as 'unexpected-response' (res.statusCode) AND/OR
      // 'error', never 'open'. Listen for BOTH (a regression that only fires one must still register rejected).
      ws.on('unexpected-response', (_req, res) => {
        state.statusCode = res.statusCode
        settle('rejected')
        clearTimeout(to)
        resolve(state)
      })
      ws.on('error', () => {
        state.errored = true
        settle('rejected')
        clearTimeout(to)
        resolve(state)
      })
      ws.on('close', () => {
        state.closed = true
      })
      ws.on('message', (raw) => {
        try {
          state.frames.push(JSON.parse(raw.toString()))
        } catch {
          /* ignore non-JSON */
        }
      })
    })
  }

  // (1) WRONG TOKEN IS REJECTED — no upgrade, 401, never 'open' (and no snapshot leaks onto the socket).
  {
    const c = await connect('/island?token=WRONG')
    ok('wrong token is rejected (no WS upgrade, 401)', c.result === 'rejected' && c.result !== 'open', {
      result: c.result,
      statusCode: c.statusCode
    })
    ok('a rejected socket receives NO {t:process.list} snapshot', c.frames.length === 0, c.frames)
    try {
      c.ws.terminate()
    } catch {
      /* gone */
    }
  }

  // (1b) WRONG PATH IS REJECTED — a non-/island upgrade is left untouched (the 404 http server has no other
  // upgrade handler, so the handshake never completes → the client errors/never opens). Guards the pathname
  // check (and that we do NOT swallow foreign upgrades by 401'ing them).
  {
    const c = await connect(`/nope?token=${TOKEN}`)
    ok('a non-/island path is not upgraded (never opens)', c.result !== 'open', { result: c.result })
    try {
      c.ws.terminate()
    } catch {
      /* gone */
    }
  }

  // (2) CORRECT TOKEN CONNECTS — the upgrade succeeds.
  {
    const c = await connect(`/island?token=${TOKEN}`)
    ok('correct token upgrades and connects', c.result === 'open', { result: c.result })
    try {
      c.ws.terminate()
    } catch {
      /* gone */
    }
  }

  // (3)+(4)+(5) Use ONE long-lived connection to assert the connect-time snapshot + ping, then the pong/hello/
  // non-JSON inbound handling, observing that the socket survives each (the server consumes them cleanly).
  {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/island?token=${TOKEN}`)
    const frames = []
    let errored = false
    let closed = false
    ws.on('error', () => {
      errored = true
    })
    ws.on('close', () => {
      closed = true
    })
    ws.on('message', (raw) => {
      try {
        frames.push(JSON.parse(raw.toString()))
      } catch {
        /* ignore */
      }
    })
    await new Promise((res, rej) => {
      ws.on('open', res)
      ws.on('error', rej)
    })

    // (3) SNAPSHOT ON CONNECT — within a beat the client has a {t:'process.list'} frame with an (empty) array.
    await wait(150)
    const snap = frames.find((f) => f && f.t === 'process.list')
    ok(
      'server sends a {t:process.list} snapshot on connect',
      !!snap && Array.isArray(snap.processes) && snap.processes.length === 0,
      snap
    )

    // (4) PING → the client receives {t:'ping'}; it replies {t:'pong'}; the server accepts it (socket stays
    // OPEN, no error/close) — the observable contract of "mark alive" for a pure-node test.
    const ping = frames.find((f) => f && f.t === 'ping')
    ok('server sends {t:ping} after connect', !!ping && ping.t === 'ping', ping)
    ws.send(JSON.stringify({ t: 'pong' }))
    await wait(250)
    ok(
      'server accepts the client {t:pong} (socket stays open, no error)',
      ws.readyState === WebSocket.OPEN && !errored && !closed,
      { readyState: ws.readyState, errored, closed }
    )

    // (5) HELLO from the client — the island's exact hello frame (main.swift:309) — is handled without error.
    ws.send(JSON.stringify({ t: 'hello', token: TOKEN, pid: process.pid, bundleId: 'dev.blitz.os.island' }))
    await wait(150)
    ok(
      'a client {t:hello} is handled without error (socket stays open)',
      ws.readyState === WebSocket.OPEN && !errored && !closed,
      { readyState: ws.readyState, errored, closed }
    )

    // A deliberately malformed / non-JSON frame must be ignored, not fatal (locks in the JSON.parse try/catch).
    ws.send('not json{')
    await wait(150)
    ok(
      'a non-JSON frame is ignored, not fatal (socket survives)',
      ws.readyState === WebSocket.OPEN && !errored && !closed,
      { readyState: ws.readyState, errored, closed }
    )

    try {
      ws.terminate()
    } catch {
      /* gone */
    }
  }

  // Teardown: stop accepting, then proceed. We do NOT await server.close()'s graceful callback — it waits on
  // any lingering client socket (a rejected/timed-out connect can leave a half-open one), which would hang the
  // run; process.exit at the very end hard-closes everything. (The unref'd hang-guard means an accidental hang
  // would still surface as a TIMEOUT failure rather than a silent block.)
  try {
    server.close()
  } catch {
    /* gone */
  }
}

// =============================================================================================================
// Dispatch suite — inject a STUB via setIslandDeps and drive the WS as a client, proving inbound process.*
// frames dispatch to the matching dep and outbound process.event/upsert/list reach the client. setIslandDeps
// is module-global, so this MUST run AFTER runWsTests() (which asserts the EMPTY default snapshot with no
// injection — the default deps.listProcesses returns []). Resets deps at the end for hygiene.
// =============================================================================================================
async function runDispatchTests() {
  console.log('\nIsland WS dispatch (stub-injected deps):')

  let emit = null // captured subscribeEvents callback
  const calls = { spawn: [], message: [], setOrchestrators: [], listProcesses: 0 }
  const stubDeps = {
    spawn: (a) => {
      calls.spawn.push(a)
      return { id: 's1', title: 'stub-title' }
    },
    message: (a) => {
      calls.message.push(a)
    },
    setOrchestrators: (id, on) => {
      calls.setOrchestrators.push({ id, on })
    },
    listProcesses: () => {
      calls.listProcesses++
      return [
        { id: '0', title: 'Main', state: 'idle' },
        { id: '1', title: 'Worker', state: 'working' }
      ]
    },
    subscribeEvents: (cb) => {
      emit = cb
      return () => {
        emit = null
      }
    }
  }
  setIslandDeps(stubDeps)

  const TOKEN = 'disp-token-' + Math.random().toString(16).slice(2)
  const server = createServer((_q, r) => {
    r.writeHead(404)
    r.end()
  })
  attachIslandWebSocket(server, TOKEN)
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port

  // One long-lived client. Collect every parsed frame; flag error/close so robustness asserts can read them.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/island?token=${TOKEN}`)
  const frames = []
  let errored = false
  let closed = false
  ws.on('error', () => {
    errored = true
  })
  ws.on('close', () => {
    closed = true
  })
  ws.on('message', (raw) => {
    try {
      frames.push(JSON.parse(raw.toString()))
    } catch {
      /* ignore */
    }
  })
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  const send = (obj) => ws.send(JSON.stringify(obj))

  // (1) connect → process.list FROM THE STUB (deep-equal the stub's two entries), and listProcesses was hit.
  await wait(150)
  {
    const snap = frames.find((f) => f && f.t === 'process.list')
    const expected = [
      { id: '0', title: 'Main', state: 'idle' },
      { id: '1', title: 'Worker', state: 'working' }
    ]
    ok(
      'connect → process.list from stub.listProcesses (deep-equal entries)',
      !!snap && JSON.stringify(snap.processes) === JSON.stringify(expected),
      snap
    )
    ok('stub.listProcesses was called on connect', calls.listProcesses >= 1, { listProcesses: calls.listProcesses })
  }

  // (2) process.spawn{orchestrators:true} → stub.spawn called with orchestrators true + an optimistic upsert.
  send({ t: 'process.spawn', prompt: 'hi', paths: ['/a'], orchestrators: true })
  await wait(150)
  {
    const last = calls.spawn.at(-1)
    ok(
      'process.spawn{orchestrators:true} → stub.spawn(orchestrators true, prompt, paths)',
      !!last && last.orchestrators === true && last.prompt === 'hi' && JSON.stringify(last.paths) === JSON.stringify(['/a']),
      last
    )
    const up = frames.find((f) => f && f.t === 'process.upsert' && f.id === 's1' && f.state === 'new')
    ok('process.spawn → optimistic {t:process.upsert, id:s1, state:new} reaches the client', !!up, up)
  }

  // (3) process.spawn{orchestrators:false} AND with the key OMITTED → both coerce to orchestrators false.
  send({ t: 'process.spawn', prompt: 'b', paths: [], orchestrators: false })
  await wait(120)
  ok('process.spawn{orchestrators:false} → stub.spawn(orchestrators false)', calls.spawn.at(-1)?.orchestrators === false, calls.spawn.at(-1))
  send({ t: 'process.spawn', prompt: 'c', paths: [] }) // orchestrators key OMITTED
  await wait(120)
  ok('process.spawn with no orchestrators key → coerces to false (default-OFF conversational)', calls.spawn.at(-1)?.orchestrators === false, calls.spawn.at(-1))

  // (4) process.message → stub.message with {id,text,paths}.
  send({ t: 'process.message', id: '1', text: 'go', paths: [] })
  await wait(120)
  ok(
    'process.message → stub.message({id,text,paths})',
    JSON.stringify(calls.message.at(-1)) === JSON.stringify({ id: '1', text: 'go', paths: [] }),
    calls.message.at(-1)
  )

  // (5) process.orchestrators → stub.setOrchestrators, both edges.
  send({ t: 'process.orchestrators', id: '1', on: true })
  await wait(100)
  send({ t: 'process.orchestrators', id: '1', on: false })
  await wait(120)
  ok(
    'process.orchestrators{on:true} then {on:false} → stub.setOrchestrators recorded both edges',
    JSON.stringify(calls.setOrchestrators.slice(-2)) === JSON.stringify([{ id: '1', on: true }, { id: '1', on: false }]),
    calls.setOrchestrators.slice(-2)
  )

  // (6) subscribeEvents → process.event reaches the client (the cb was captured on connect).
  ok('subscribeEvents callback was captured on connect', typeof emit === 'function')
  if (typeof emit === 'function') emit({ id: '1', line: { at: 1234, text: 'reply line' } })
  await wait(120)
  {
    const ev = frames.find((f) => f && f.t === 'process.event' && f.id === '1')
    ok(
      'subscribeEvents line → {t:process.event, id:1, line:{at:1234, text:"reply line"}} reaches the client',
      !!ev && ev.line && ev.line.at === 1234 && ev.line.text === 'reply line',
      ev
    )
  }

  // (7) subscribeEvents upsert → process.upsert (locks the auto-name/status edge channel).
  if (typeof emit === 'function') emit({ id: '1', upsert: { title: 'Renamed', state: 'working' } })
  await wait(120)
  {
    const up = frames.find((f) => f && f.t === 'process.upsert' && f.id === '1' && f.title === 'Renamed' && f.state === 'working')
    ok('subscribeEvents upsert → {t:process.upsert, id:1, title:Renamed, state:working} reaches the client', !!up, up)
  }

  // (8) robustness: a THROWING dep must not kill the socket (proves the A3 try/catch).
  setIslandDeps({ spawn: () => { throw new Error('boom') } })
  send({ t: 'process.spawn', prompt: 'x', paths: [], orchestrators: false })
  await wait(150)
  ok('a throwing dep does NOT kill the socket (stays OPEN, no error/close)', ws.readyState === WebSocket.OPEN && !errored && !closed, {
    readyState: ws.readyState,
    errored,
    closed
  })
  setIslandDeps(stubDeps) // restore for any later use

  try {
    ws.terminate()
  } catch {
    /* gone */
  }
  try {
    server.close()
  } catch {
    /* gone */
  }
  // Reset deps to a benign default so suite order can't leak the stub into anything after (the structural
  // audit reads source off disk, so it's independent, but reset for hygiene).
  setIslandDeps({ spawn: () => ({ id: '', title: '' }), message: () => {}, setOrchestrators: () => {}, listProcesses: () => [], subscribeEvents: () => () => {} })
}

try {
  await runWsTests()
} catch (e) {
  failures++
  console.log('  ✗ runWsTests threw:', e && e.message ? e.message : String(e))
}

try {
  await runDispatchTests()
} catch (e) {
  failures++
  console.log('  ✗ runDispatchTests threw:', e && e.message ? e.message : String(e))
}

// =============================================================================================================
// Part B — structural audit of the electron-bound wiring (the parts that can't execute under node): the WS
// mount on the control server, the launch call after startControlServer, and the Electron-free guarantee.
// Read the ACTUAL source off disk so a future rewire that breaks the contract fails here.
// =============================================================================================================
console.log('\nIsland wiring (structural — source audit of the electron-bound parts):')

const bridgeSrc = readFileSync(join(repoRoot, 'src/main/island-bridge.mjs'), 'utf8')
const controlSrc = readFileSync(join(repoRoot, 'src/main/control-server.ts'), 'utf8')
const indexSrc = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8')

// The Electron-free guarantee: island-bridge.mjs must never import electron (the entire architectural point —
// testability under node + the os-tools.mjs/stage-core.mjs split). Scan import statements, not comment prose.
{
  const importLines = bridgeSrc.split('\n').filter((l) => /^\s*import\b/.test(l))
  const touchesElectron = importLines.some((l) => /['"]electron['"]/.test(l))
  ok('island-bridge.mjs does NOT import electron (stays pure-node)', !touchesElectron, importLines.filter((l) => /electron/.test(l)))
}
ok('island-bridge.mjs uses noServer:true (we own the upgrade — not new WebSocketServer({ server }))',
  /new WebSocketServer\(\{\s*noServer:\s*true\s*\}\)/.test(bridgeSrc) && !/new WebSocketServer\(\{\s*server\b/.test(bridgeSrc))
ok('island-bridge.mjs gates on path /island and rejects a bad token with a raw 401 + socket.destroy',
  /pathname\s*!==\s*'\/island'/.test(bridgeSrc) && /401 Unauthorized/.test(bridgeSrc) && /socket\.destroy\(\)/.test(bridgeSrc))
ok('island-bridge.mjs sends the {t:process.list} snapshot THEN {t:ping} on connect',
  /t:\s*'process\.list'/.test(bridgeSrc) && /t:\s*'ping'/.test(bridgeSrc))
ok('island-bridge.mjs launches via `open` WITHOUT -n and dup-guards with pgrep -x BlitzIsland',
  /'\/usr\/bin\/pgrep'[\s\S]*?'-x'[\s\S]*?'BlitzIsland'/.test(bridgeSrc) && /'\/usr\/bin\/open'/.test(bridgeSrc) && !/\/usr\/bin\/open'\s*,\s*\[\s*'-n'/.test(bridgeSrc))

// control-server.ts mounts the WS with the SAME server + bearer token, before listen.
ok("control-server.ts imports attachIslandWebSocket from './island-bridge.mjs'",
  /import\s*\{\s*attachIslandWebSocket\s*\}\s*from\s*'\.\/island-bridge\.mjs'/.test(controlSrc))
ok('control-server.ts calls attachIslandWebSocket(server, token) (same server + bearer token)',
  /attachIslandWebSocket\(\s*server\s*,\s*token\s*\)/.test(controlSrc))

// index.ts resolves the bundle path + launches the helper AFTER startControlServer, and stops it on quit.
// The import now pulls BOTH launchIslandHelper (Part 0b) AND setIslandDeps (Part B) from island-bridge.mjs;
// assert each name is in the import braces (order-independent, tolerant of other names in the same import).
{
  const islandImport = (indexSrc.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/island-bridge\.mjs'/) || [, ''])[1]
  ok("index.ts imports launchIslandHelper + setIslandDeps from './island-bridge.mjs'",
    /\blaunchIslandHelper\b/.test(islandImport) && /\bsetIslandDeps\b/.test(islandImport), { islandImport })
}
ok('index.ts calls launchIslandHelper(...) AFTER startControlServer()',
  /startControlServer\(\)[\s\S]*?launchIslandHelper\(/.test(indexSrc))
ok('index.ts resolves the bundle path with a BLITZ_ISLAND_APP override + the dev/prod candidate list',
  /BLITZ_ISLAND_APP/.test(indexSrc) && /BlitzIsland\.app/.test(indexSrc) && /island-helper/.test(indexSrc))
ok('index.ts stops the island supervisor on before-quit (islandHelper?.stop())',
  /islandHelper\?\.stop\(\)/.test(indexSrc))
// Part B contract: setIslandDeps(realDeps) MUST run BEFORE startControlServer() (attachIslandWebSocket reads
// the injected deps lazily at connect time, so they have to be in place first). Compare CALL-site indices —
// match the actual invocation at statement position (start of a trimmed line), not a `startControlServer()`
// mention inside a comment, so the ordering check is on the real call.
{
  const depsAt = indexSrc.indexOf('setIslandDeps(realDeps')
  const serverCall = indexSrc.match(/^[ \t]*startControlServer\(\)/m)
  const serverAt = serverCall ? (serverCall.index ?? -1) : -1
  ok('index.ts calls setIslandDeps(realDeps) BEFORE startControlServer()',
    depsAt !== -1 && serverAt !== -1 && depsAt < serverAt, { depsAt, serverAt })
}
// Part B: realDeps wires the VERIFIED seams (userMessage NOT emitUserMessage; the chat.md tail uses chatFileName,
// not the wrong .blitzos/terminals/<id>/chat.md path; agentStatus authority via osAgentStatus, not osGetState().agentStatus).
ok('index.ts realDeps uses electronOps.userMessage (NOT emitUserMessage — writes chat.md AND wakes)',
  /electronOps\.userMessage\b/.test(indexSrc) && !/electronOps\.emitUserMessage\b/.test(indexSrc) && !/opUserMessage = electronOps\.emitUserMessage/.test(indexSrc))
ok('index.ts tails the WORKSPACE-ROOT chat file via chatFileName(id) (not .blitzos/terminals/<id>/chat.md)',
  /chatFileName\(/.test(indexSrc) && /join\(\s*wsPath\s*,\s*chatFileName\(/.test(indexSrc) && !/terminals['"\s,)]+[\s\S]{0,40}chat\.md/.test(indexSrc))
ok('index.ts derives the process list from osAgentStatus() (the authoritative live map, not osGetState().agentStatus)',
  /osAgentStatus\(\)/.test(indexSrc) && !/osGetState\(\)\.agentStatus/.test(indexSrc))

// =============================================================================================================
// Part C — PACKAGING audit (the prod/bundled path). The runtime resolves the packaged bundle at
// process.resourcesPath/BlitzIsland.app (index.ts), but that file only EXISTS if (1) electron-builder.yml
// copies it via extraResources AND (2) scripts/dist-mac.sh actually BUILDS+SIGNS it before packaging — exactly
// how the CU helper is wired. Both gaps are silent (existsSync just fails → the no-op handle → the HUD never
// starts in prod), so guard them here off disk. Mirror the CU helper's two lines so neither can rot alone.
// =============================================================================================================
console.log('\nIsland packaging (prod/bundled path — extraResources + dist build):')

const builderSrc = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8')
const distSrc = readFileSync(join(repoRoot, 'scripts/dist-mac.sh'), 'utf8')

// (C1) electron-builder.yml copies the island bundle into Contents/Resources (so resourcesPath resolves).
//      Assert BOTH the source path under native/island-helper/build AND the to: BlitzIsland.app target — the
//      same string index.ts joins onto process.resourcesPath.
ok('electron-builder.yml extraResources copies native/island-helper/build/BlitzIsland.app',
  /from:\s*native\/island-helper\/build\/BlitzIsland\.app/.test(builderSrc))
ok('electron-builder.yml maps it to BlitzIsland.app (matches index.ts process.resourcesPath candidate)',
  /to:\s*BlitzIsland\.app/.test(builderSrc))

// (C2) dist-mac.sh builds+signs the island bundle BEFORE `npm run build` (so a fresh signed bundle is on disk
//      for extraResources to copy), passing the Developer-ID identity through, fail-soft — exactly the CU line.
ok('dist-mac.sh invokes native/island-helper/build.sh (so the bundle exists to copy)',
  /bash\s+native\/island-helper\/build\.sh/.test(distSrc))
ok('dist-mac.sh passes the Developer-ID identity to the island build (BLITZ_ISLAND_SIGN_IDENTITY=...)',
  /BLITZ_ISLAND_SIGN_IDENTITY="?\$\{?APPLE_SIGNING_IDENTITY[\s\S]*?bash\s+native\/island-helper\/build\.sh/.test(distSrc))
ok('the island build runs BEFORE npm run build (a fresh signed bundle is on disk before packaging)',
  distSrc.indexOf('native/island-helper/build.sh') !== -1 &&
    distSrc.indexOf('native/island-helper/build.sh') < distSrc.indexOf('npm run build'))

clearTimeout(hang)
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
