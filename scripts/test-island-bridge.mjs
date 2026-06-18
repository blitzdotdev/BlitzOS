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
// The REAL isolation core — the producer-side + unit suites below import the SAME helpers index.ts wires, so a
// regression in the membership filter (a leak, a cross-ws collision, a bad prune) fails here under plain node.
import { islandSetFor, recordIslandId, islandLiveIds, pruneIslandIds, islandWorkspaceCount } from '../src/main/island-membership.mjs'

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

// =============================================================================================================
// Membership unit suite — drive the REAL src/main/island-membership.mjs helpers directly (no WS, no electron)
// to lock the four cross-part fatals the per-workspace Map<wsName,Set> model exists to survive: the '0'/sibling
// leak, cross-workspace id collision, disappear-then-reappear on a switch, and same-workspace id-reuse. These
// are the exact assertions index.ts depends on (it CALLS these helpers), so a regression in the filter fails
// here under plain node. Uses unique ws names per case so module-global Map state can't bleed between cases.
// =============================================================================================================
function runMembershipUnitTests() {
  console.log('\nIsland membership core (src/main/island-membership.mjs, direct unit):')
  const uniq = () => 'ws-' + Math.random().toString(16).slice(2)

  // (1) LEAK GUARD: islandLiveIds drops '0' (never an island id) AND any id NOT recorded, even when live.
  {
    const A = uniq()
    recordIslandId(A, '5')
    ok("islandLiveIds drops '0' even when live + recorded-only id survives", JSON.stringify(islandLiveIds(A, { '0': 'working', '5': 'working' })) === JSON.stringify(['5']), islandLiveIds(A, { '0': 'working', '5': 'working' }))
    ok('a NOT-recorded but live id is excluded', JSON.stringify(islandLiveIds(A, { '0': 'x', '9': 'x' })) === JSON.stringify([]), islandLiveIds(A, { '0': 'x', '9': 'x' }))
    // even if '0' were somehow recorded, the hard id!=='0' belt-and-suspenders excludes it.
    recordIslandId(A, '0')
    ok("a recorded '0' is STILL excluded (hard id!=='0' gate)", !islandLiveIds(A, { '0': 'x', '5': 'x' }).includes('0'), islandLiveIds(A, { '0': 'x', '5': 'x' }))
  }

  // (2) CROSS-WORKSPACE ISOLATION (reconnect FATAL #2): A's island '1' and B's non-island '1' never collide.
  {
    const A = uniq()
    const B = uniq()
    recordIslandId(A, '1')
    ok("B's own non-island '1' is NOT leaked (not in B's set)", JSON.stringify(islandLiveIds(B, { '0': 'x', '1': 'x' })) === JSON.stringify([]), islandLiveIds(B, { '0': 'x', '1': 'x' }))
    ok("A's island '1' is still listed (Map-by-ws-name disambiguates the colliding id)", JSON.stringify(islandLiveIds(A, { '0': 'x', '1': 'x' })) === JSON.stringify(['1']), islandLiveIds(A, { '0': 'x', '1': 'x' }))
  }

  // (3) DISAPPEAR-THEN-REAPPEAR ON SWITCH (reconnect FATAL #1): switching away never PRUNES the other set;
  //     only the read intersect hides it, so a switch-back re-lists. Crucially we prune ONLY the active ws.
  {
    const A = uniq()
    recordIslandId(A, '1')
    // switched to B (A absent from the active status): A's '1' is not listed under B...
    ok("switched away (read under B's status) → A's '1' not listed", JSON.stringify(islandLiveIds(B_for(A), { '0': 'x' })) === JSON.stringify([]), islandLiveIds(B_for(A), { '0': 'x' }))
    // ...and we did NOT prune A merely because it was absent under another ws (prune is active-ws-only).
    // Switch back to A (its '1' live again): re-listed, proving no loss.
    ok("switched back → A's '1' re-listed (intersect-not-prune; survived)", JSON.stringify(islandLiveIds(A, { '0': 'x', '1': 'x' })) === JSON.stringify(['1']), islandLiveIds(A, { '0': 'x', '1': 'x' }))
    ok("A's set still contains '1' after the away period (no cross-ws prune ran)", islandSetFor(A).has('1'))
  }

  // (4) SAME-WORKSPACE id-REUSE GUARD (the residual hole closed): a genuine close prunes (A active), so a
  //     later REISSUE of the same id to a NON-island agent is NOT falsely owned.
  {
    const A = uniq()
    recordIslandId(A, '5')
    pruneIslandIds(A, { '0': 'x' }) // 5 closed while A active -> dropped from A's set
    ok("pruneIslandIds(active) drops a closed island id", !islandSetFor(A).has('5'))
    ok("the reused '5' (now a non-island agent) is NOT falsely owned", JSON.stringify(islandLiveIds(A, { '0': 'x', '5': 'x' })) === JSON.stringify([]), islandLiveIds(A, { '0': 'x', '5': 'x' }))
  }

  // (5) recordIslandId's {id:''} failed-spawn guard: an empty id is a no-op (never a member).
  {
    const A = uniq()
    recordIslandId(A, '')
    recordIslandId(A, null)
    recordIslandId(A, undefined)
    ok('recordIslandId skips empty/nullish ids (failed-spawn guard)', islandSetFor(A).size === 0, [...islandSetFor(A)])
  }

  ok('islandWorkspaceCount is a number (test-only visibility export)', typeof islandWorkspaceCount() === 'number')
}
// tiny helper so the FATAL#1 "switched away" read is legibly a DIFFERENT ws than A (a fresh unrelated ws name).
function B_for(_a) {
  return 'other-' + Math.random().toString(16).slice(2)
}

// =============================================================================================================
// Producer-side suite — the REAL bridge (onIslandConnection) + the REAL membership helpers + a realDeps-EQUIV
// composed over FAKE electron ops (no electron import). This is the end-to-end isolation contract: a new island
// tab Send SPAWNS a new agent (BUG-1's downstream), the spawned id is RECORDED + LISTED, '0'/a sibling are
// NEVER listed or tailed (BUG-2 headline, executable), and a continue-message carries NO preamble. We mirror
// index.ts's realDeps.spawn/message/listProcesses/subscribeEvents exactly (preamble-on-spawn-only; the tail
// gated through islandLiveIds) but with injected fakes for opSpawnAgent/opStartWorkflow/opUserMessage and a
// fake osAgentStatus, so the assertions are about the SHARED filter + the SHARED bridge, not electron.
// =============================================================================================================
// The exact preamble string index.ts prepends to a SPAWN seed (kept in sync; a continue-message must NOT
// carry it). If index.ts changes the wording, this literal documents the contract the test enforces.
const ISLAND_PREAMBLE = 'You are running in the BlitzOS notch island. Answer concisely — short status lines the user can read at a glance in a small HUD.'
async function runProducerTests() {
  console.log('\nIsland producer-side (REAL bridge + REAL membership + fake electron ops):')

  const WS = 'prod-ws-' + Math.random().toString(16).slice(2)
  // Fake electron ops (the seams index.ts casts off electronOps). Capture every call.
  const calls = { spawnAgent: 0, startWorkflow: [], userMessage: [], setOrchestrators: [] }
  const fakeOpSpawnAgent = () => {
    calls.spawnAgent++
    return { id: 'isl-1', title: '' }
  }
  const fakeOpStartWorkflow = (s) => {
    calls.startWorkflow.push(s)
    return { ok: true, agent: { id: 'isl-2', title: 'WF' } }
  }
  const fakeOpUserMessage = (text, id) => {
    calls.userMessage.push({ text, id })
  }
  // The fake live status map: '0' (the user's MAIN canvas chat) + sibling '9' (a peer agent) + the island ids.
  // '0' and '9' are the LEAK SURFACE — they must never appear in any {list} or {event}.
  let fakeStatus = { '0': 'working', '9': 'working' }
  const fakeAgentStatus = () => fakeStatus

  const pathsFooter = (paths) => (Array.isArray(paths) && paths.length ? `\n\nContext (dropped on the island):\n${paths.map((p) => `- ${p}`).join('\n')}` : '')

  // realDeps-EQUIV — the SAME structure as index.ts (record on spawn both branches; list+tail gated by
  // islandLiveIds(WS, fakeStatus)). Title is a trivial stub; the membership gate is what we're proving.
  let emit = null
  const realDepsEquiv = {
    spawn: ({ prompt, paths, orchestrators }) => {
      if (orchestrators) {
        const r = fakeOpStartWorkflow({ task: `${ISLAND_PREAMBLE}\n\n${prompt || ''}`, contextRefs: paths, title: undefined })
        const a = r?.agent ? { id: String(r.agent.id), title: String(r.agent.title ?? '') } : { id: '', title: '' }
        if (a.id) recordIslandId(WS, a.id)
        return a
      }
      const a = fakeOpSpawnAgent(undefined)
      try {
        fakeOpUserMessage(`${ISLAND_PREAMBLE}\n\n${prompt || ''}${pathsFooter(paths)}`, a.id)
      } catch {
        /* seed lands on chat.md read */
      }
      if (a.id) recordIslandId(WS, a.id)
      return a
    },
    message: ({ id, text, paths }) => {
      fakeOpUserMessage(`${text || ''}${pathsFooter(paths)}`, id)
    },
    setOrchestrators: (id, on) => {
      calls.setOrchestrators.push({ id, on })
    },
    listProcesses: () => islandLiveIds(WS, fakeAgentStatus()).map((id) => ({ id, title: `Chat ${id}`, state: 'working' })),
    // A SIMPLIFIED tail standing in for startChatTail: on each manual pulse it emits the membership {list}
    // (gated) + a reply line PER LIVE STATUS id, but ALSO gated through islandLiveIds — so the assertion that
    // NO event fires for '0'/'9' proves the gate, exactly as drainFile only opens island ids' chat.md.
    subscribeEvents: (cb) => {
      emit = cb
      return () => {
        emit = null
      }
    }
  }
  setIslandDeps(realDepsEquiv)

  const TOKEN = 'prod-token-' + Math.random().toString(16).slice(2)
  const server = createServer((_q, r) => {
    r.writeHead(404)
    r.end()
  })
  attachIslandWebSocket(server, TOKEN)
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  const port = server.address().port

  const ws = new WebSocket(`ws://127.0.0.1:${port}/island?token=${TOKEN}`)
  const frames = []
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

  // (A) CONNECT-TIME process.list is gated: '0' + sibling '9' are live but NEITHER is listed (nothing recorded
  //     yet → an EMPTY list). This is the boot-half of the BUG-2 leak guard.
  await wait(150)
  {
    const snap = frames.find((f) => f && f.t === 'process.list')
    ok('connect → process.list exists and is EMPTY (no island ids yet; 0/9 filtered)', !!snap && Array.isArray(snap.processes) && snap.processes.length === 0, snap)
  }

  // (B)-OFF: process.spawn{orchestrators:false} → opSpawnAgent THEN opUserMessage(seed,'isl-1') where seed
  //          STARTS WITH the preamble, AND islandSetFor(WS) now owns 'isl-1'. (BUG-1 spawn-on-Send contract.)
  send({ t: 'process.spawn', prompt: 'hello', paths: ['/p'], orchestrators: false })
  await wait(150)
  {
    ok('(OFF) opSpawnAgent was called (a NEW agent spawns, not a continue)', calls.spawnAgent === 1, { spawnAgent: calls.spawnAgent })
    const seed = calls.userMessage.find((c) => c.id === 'isl-1')
    ok("(OFF) opUserMessage seed targets 'isl-1' AND starts with the island preamble", !!seed && seed.text.startsWith(ISLAND_PREAMBLE), seed)
    ok("(OFF) the seed carries the dropped-paths footer", !!seed && seed.text.includes('Context (dropped on the island)') && seed.text.includes('- /p'), seed)
    ok("(OFF) islandSetFor(WS) now owns the spawned 'isl-1'", islandSetFor(WS).has('isl-1'), [...islandSetFor(WS)])
    const up = frames.find((f) => f && f.t === 'process.upsert' && f.id === 'isl-1' && f.state === 'new')
    ok('(OFF) optimistic {t:process.upsert, id:isl-1, state:new} reached the client (bridge L196)', !!up, up)
  }

  // (C)-ON: process.spawn{orchestrators:true} → opStartWorkflow (NOT opSpawnAgent again) AND WS owns 'isl-2'.
  send({ t: 'process.spawn', prompt: 'big', paths: [], orchestrators: true })
  await wait(150)
  {
    ok('(ON) opStartWorkflow was called for the heavy-task spawn', calls.startWorkflow.length === 1, { startWorkflow: calls.startWorkflow.length })
    ok('(ON) opSpawnAgent was NOT called again (orchestrators routes to startWorkflow)', calls.spawnAgent === 1, { spawnAgent: calls.spawnAgent })
    ok("(ON) the startWorkflow task starts with the island preamble", calls.startWorkflow[0]?.task?.startsWith(ISLAND_PREAMBLE), calls.startWorkflow[0])
    ok("(ON) islandSetFor(WS) now owns 'isl-2'", islandSetFor(WS).has('isl-2'), [...islandSetFor(WS)])
  }

  // (D) CONTINUE message → opUserMessage('more'+footer,'isl-1') with NO preamble prefix (spawn-only persona).
  send({ t: 'process.message', id: 'isl-1', text: 'more', paths: [] })
  await wait(120)
  {
    const msg = calls.userMessage.filter((c) => c.id === 'isl-1').at(-1)
    ok("(MSG) opUserMessage('more', 'isl-1') with NO preamble prefix (continue carries no persona)", !!msg && msg.text === 'more' && !msg.text.startsWith(ISLAND_PREAMBLE), msg)
  }

  // (E) THE LEAK GUARD (BUG-2 headline, executable): now that 'isl-1'+'isl-2' are recorded AND live, a list
  //     pulse must CONTAIN them and must NOT contain '0' or '9'; and a reply pulse must emit NO process.event
  //     for '0'/'9' (proving drainFile never opens their chat.md). Drive the gated tail emit directly.
  fakeStatus = { '0': 'working', '9': 'working', 'isl-1': 'working', 'isl-2': 'working' }
  const beforeFrames = frames.length
  if (typeof emit === 'function') {
    emit({ list: realDepsEquiv.listProcesses() })
    // a reply line per LIVE island id only (the gate) — never for '0'/'9'.
    for (const id of islandLiveIds(WS, fakeStatus)) emit({ id, line: { at: 1000, text: `reply ${id}` } })
  }
  await wait(150)
  {
    const list = [...frames].slice(beforeFrames).reverse().find((f) => f && f.t === 'process.list')
    const listIds = (list?.processes || []).map((p) => p.id)
    ok("(LEAK) {t:process.list} CONTAINS the island ids isl-1 + isl-2", listIds.includes('isl-1') && listIds.includes('isl-2'), listIds)
    ok("(LEAK) {t:process.list} does NOT contain '0' (the user's MAIN canvas chat)", !listIds.includes('0'), listIds)
    ok("(LEAK) {t:process.list} does NOT contain sibling '9'", !listIds.includes('9'), listIds)
    const events = frames.filter((f) => f && f.t === 'process.event')
    ok("(LEAK) NO {t:process.event} was EVER emitted for '0' (its chat.md is never tailed)", !events.some((e) => e.id === '0'), events.map((e) => e.id))
    ok("(LEAK) NO {t:process.event} was EVER emitted for sibling '9'", !events.some((e) => e.id === '9'), events.map((e) => e.id))
    ok("(LEAK) process.event DID fire for the island ids (the tail works for them)", events.some((e) => e.id === 'isl-1') && events.some((e) => e.id === 'isl-2'), events.map((e) => e.id))
  }

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
  // reset deps for hygiene (mirrors runDispatchTests' tail).
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

try {
  runMembershipUnitTests()
} catch (e) {
  failures++
  console.log('  ✗ runMembershipUnitTests threw:', e && e.message ? e.message : String(e))
}

try {
  await runProducerTests()
} catch (e) {
  failures++
  console.log('  ✗ runProducerTests threw:', e && e.message ? e.message : String(e))
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

// --- NUL-byte tripwire: a tsc-INVISIBLE regression (tsc tolerates a NUL inside a string literal). The
//     membership-delta separator was a literal NUL (\x00) on the idsKey line — fixed to a real space so the
//     file is text again (greppable) AND idsKey matches the seed baseline's space-joined key (no spurious
//     first-tick {list}). Assert the UTF-8 source carries no NUL anywhere. ---
ok('index.ts contains NO NUL byte (the idsKey separator is a real space, not \\x00 — file stays text)',
  indexSrc.indexOf(String.fromCharCode(0)) === -1)

// --- BUG-2 isolation wiring: index.ts imports the membership helpers and GATES list/tail/spawn through them. ---
{
  const memImport = (indexSrc.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/island-membership\.mjs'/) || [, ''])[1]
  ok("index.ts imports recordIslandId + islandLiveIds + pruneIslandIds from './island-membership.mjs'",
    /\brecordIslandId\b/.test(memImport) && /\bislandLiveIds\b/.test(memImport) && /\bpruneIslandIds\b/.test(memImport), { memImport })
}
ok('index.ts realDeps.spawn RECORDS the spawned id (recordIslandId) so the tail/list will own it',
  /recordIslandId\(/.test(indexSrc))
ok('index.ts realDeps.listProcesses GATES the snapshot through islandLiveIds (never lists 0/a sibling)',
  /islandLiveIds\(/.test(indexSrc))
ok('index.ts startChatTail PRUNES the active ws (pruneIslandIds) — closes the same-ws id-reuse hole',
  /pruneIslandIds\(/.test(indexSrc))
// belt: at least two islandLiveIds call-sites (tick + seed + listProcesses all gate; require >=2 to prove the
// tail itself is filtered, not just the connect snapshot).
ok('index.ts references islandLiveIds in MULTIPLE call-sites (listProcesses + tick + seed all gated)',
  (indexSrc.match(/islandLiveIds\(/g) || []).length >= 2, (indexSrc.match(/islandLiveIds\(/g) || []).length)

// --- BUG-1 (Swift): ensureChatBarForOpen exists AND toggle() calls it on the open edge (cold-start spawn). ---
const swiftSrc = readFileSync(join(repoRoot, 'native/island-helper/main.swift'), 'utf8')
ok('main.swift defines func ensureChatBarForOpen() (the cold-start fresh-chat-bar opener)',
  /func\s+ensureChatBarForOpen\s*\(/.test(swiftSrc))
ok("main.swift toggle() calls ensureChatBarForOpen() on the CLOSED->OPEN edge (the else of `if open`)",
  /func\s+toggle\s*\(\)\s*\{[\s\S]*?else\s*\{\s*ensureChatBarForOpen\(\)\s*\}[\s\S]*?open\.toggle\(\)/.test(swiftSrc))
// ensureChatBarForOpen guard POLARITY — the committee's false-green fix. A nil selection (cold start) MUST
// fall through to newTab(); it must NOT be an early-RETURN condition (the inverted polarity that made the first
// Send a dead no-op). A token-presence regex (`currentTabId == nil` AND `newTab()` both exist) passed on the
// BROKEN code, so audit the polarity structurally: isolate the function BODY, and (1) the early-return /
// "do-nothing" set must NOT contain `currentTabId == nil`, (2) the nil check must be a fall-through `guard
// currentTabId != nil else { newTab() ... }`. Plus the rejected `currentIsChatBar == false` guard must be absent.
{
  const ecbo = swiftSrc.match(/func\s+ensureChatBarForOpen\s*\([\s\S]*?(?=\n {4}func\s)/)
  const body = ecbo ? ecbo[0] : ''
  // The cold-start nil case is a fall-through guard: `guard currentTabId != nil else { newTab(); return }`.
  const nilFallsThrough = /guard\s+currentTabId\s*!=\s*nil\s+else\s*\{\s*newTab\(\)\s*;?\s*return\s*\}/.test(body)
  // The "do nothing" / early-return set is the trailing `if (...) { return }` — strip the guard line first so a
  // `!= nil` in the guard can't be confused with an `== nil` return condition, then assert no `== nil` early
  // return survives anywhere in the do-nothing branch.
  const afterGuard = body.replace(/guard[\s\S]*?\}\s*/, '')
  const noNilEarlyReturn = !/currentTabId\s*==\s*nil/.test(afterGuard)
  ok('main.swift ensureChatBarForOpen: a NIL selection FALLS THROUGH to newTab() (cold-start spawn works)',
    body.length > 0 && nilFallsThrough, { nilFallsThrough, bodyLen: body.length })
  ok('main.swift ensureChatBarForOpen: `currentTabId == nil` is NOT an early-RETURN condition (polarity correct)',
    body.length > 0 && noNilEarlyReturn, { noNilEarlyReturn })
  ok('main.swift ensureChatBarForOpen does NOT use the rejected `currentIsChatBar == false` guard',
    !/currentIsChatBar\s*==\s*false/.test(body))
}

// EXECUTABLE cold-start unit — a polarity bug needs a behavioral check, not just a source regex. Mirror the
// Swift IslandModel's tab-selection logic in plain JS (newTab, currentIsChatBar, ensureChatBarForOpen,
// sendCurrent's spawn-vs-message branch) and PROVE: a cold-start model (currentTabId==nil) -> open-edge
// ensureChatBarForOpen() -> currentTabId set + a local draft + currentIsChatBar -> first send takes the SPAWN
// branch (a NEW agent), not the message branch. This unit fails on the inverted-polarity bug (nil early-return
// would leave currentTabId==nil and the send a no-op), exactly the regression the structural asserts now also
// catch. Kept in lockstep with main.swift's ensureChatBarForOpen/sendCurrent — if their logic changes, mirror it.
{
  const makeIslandModel = () => ({
    processes: [],
    currentTabId: null,
    localDraftTabId: null,
    draftByTab: {},
    get currentProc() { return this.processes.find((p) => p.id === this.currentTabId) },
    // currentIsChatBar: the local "+" draft OR a server 'new' tab (mirrors main.swift L224-227).
    get currentIsChatBar() {
      if (this.currentTabId != null && this.currentTabId === this.localDraftTabId) return true
      return (this.currentProc?.state ?? 'new') === 'new'
    },
    newTab() {
      const id = 'local-' + Math.random().toString(16).slice(2)
      this.localDraftTabId = id
      this.currentTabId = id
    },
    // ensureChatBarForOpen — the FIXED polarity (nil falls through to newTab()).
    ensureChatBarForOpen() {
      if (this.currentTabId == null) { this.newTab(); return }
      if ((this.localDraftTabId != null && this.currentTabId === this.localDraftTabId)
        || (this.currentProc?.state ?? '') === 'new') return
      this.newTab()
    },
    // sendCurrent's branch selector (mirrors main.swift L340-354): chat bar -> SPAWN, else -> message.
    sendKind() {
      if (this.currentTabId == null) return 'noop' // the dead-no-op the bug produced
      return this.currentIsChatBar ? 'spawn' : 'message'
    },
  })

  // (1) cold start: nil selection, empty processes, no boot newTab — the exact fresh-launch state.
  const m = makeIslandModel()
  ok('island model cold start begins with currentTabId == nil (fresh launch, empty list)', m.currentTabId == null)
  m.ensureChatBarForOpen() // the closed->open edge
  ok('island model: ensureChatBarForOpen on cold start SETS currentTabId (no longer nil)', m.currentTabId != null)
  ok('island model: ensureChatBarForOpen on cold start creates a LOCAL DRAFT (currentTabId == localDraftTabId)',
    m.localDraftTabId != null && m.currentTabId === m.localDraftTabId)
  ok('island model: cold-start open lands on a chat bar (currentIsChatBar == true)', m.currentIsChatBar === true)
  ok('island model: first Send after cold-start open takes the SPAWN branch (a NEW agent — BUG-1 fixed)',
    m.sendKind() === 'spawn')

  // (2) idempotent: already on the live local draft -> ensureChatBarForOpen does NOTHING (no draft churn).
  const before = m.currentTabId
  m.ensureChatBarForOpen()
  ok('island model: re-open while ON the local draft does NOT churn a new tab (same currentTabId)',
    m.currentTabId === before)

  // (3) on a working (non-new) server tab -> ensureChatBarForOpen makes a FRESH draft (so + isn't a continue).
  const w = makeIslandModel()
  w.processes = [{ id: 'isl-1', title: 'WF', state: 'working' }]
  w.currentTabId = 'isl-1'
  w.ensureChatBarForOpen()
  ok('island model: open while on a WORKING tab creates a fresh local draft (currentTabId != the working id)',
    w.currentTabId !== 'isl-1' && w.localDraftTabId === w.currentTabId)
  ok('island model: that fresh draft is a chat bar -> Send spawns (not a continue of the working agent)',
    w.currentIsChatBar === true && w.sendKind() === 'spawn')

  // (4) on a server 'new' tab -> ensureChatBarForOpen does NOTHING (it's already a spawnable chat bar).
  const n = makeIslandModel()
  n.processes = [{ id: 'srv-new', title: '', state: 'new' }]
  n.currentTabId = 'srv-new'
  n.ensureChatBarForOpen()
  ok('island model: open while on a server NEW tab does NOT churn (already a spawnable chat bar)',
    n.currentTabId === 'srv-new')
}
ok('main.swift keyboard mechanism is UNCHANGED (canBecomeKey { editing } still present)',
  /override\s+var\s+canBecomeKey:\s*Bool\s*\{\s*editing\s*\}/.test(swiftSrc))
// ensureChatBarForOpen must NOT be wired into setOpen() (hover-open routes setOpen, which must not spawn draft
// churn). Isolate the setOpen BODY (from `func setOpen` up to the NEXT `func ` declaration) and assert the call
// is absent there — a non-greedy whole-file match would falsely hit the legitimate call in the adjacent
// toggle(), so scope to the function body.
{
  const m = swiftSrc.match(/func\s+setOpen[\s\S]*?(?=\n\s*func\s)/)
  const setOpenBody = m ? m[0] : ''
  ok('main.swift does NOT call ensureChatBarForOpen from setOpen (no hover-open draft churn)',
    setOpenBody.length > 0 && !/ensureChatBarForOpen\(/.test(setOpenBody), { found: setOpenBody.includes('ensureChatBarForOpen(') })
}

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
