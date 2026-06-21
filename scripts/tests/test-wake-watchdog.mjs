// Unit test for the self-healing agent wake watchdog (src/main/agent-wake-watchdog.mjs).
// Pure state machine with injected deps — driven here with real (tiny) timers + mutable fakes.
// Run: node scripts/tests/test-wake-watchdog.mjs
import { createWakeWatchdog } from '../../src/main/agent-wake-watchdog.mjs'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (cond, msg) => { if (!cond) { failed++; console.error('  ✗ ' + msg) } else { console.log('  ✓ ' + msg) } }

// Small timings so the suite runs in well under a second; real timers (no fake-clock indirection).
const T = { graceMs: 30, settleMs: 10, recheckMs: 30, maxTries: 3, maxWatchMs: 100_000 }

// Build a watchdog with controllable deps. `pane` is a function returning the current pane text (so a test can
// make it change = "working"); `poll` returns the agent's last-poll time.
function harness({ pane = () => 'FROZEN', poll = () => 0, isLive = () => true } = {}) {
  const nudges = []
  const statuses = []
  const wd = createWakeWatchdog({
    ...T,
    lastPollAt: (id) => poll(id),
    sendToTerminal: (id, data) => { nudges.push({ id, data }); return true },
    captureTerminal: () => pane(),
    isLive: (id) => isLive(id),
    setStatus: (id, ws, st) => statuses.push({ id, ws, st }),
    log: () => {}
  })
  return { wd, nudges, statuses }
}

async function run() {
  // 1. Dead loop + frozen pane → exactly one nudge + 'reconnecting'.
  {
    console.log('1. dead loop, frozen pane → nudge')
    const h = harness({ pane: () => 'FROZEN', poll: () => 0 })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 25)
    ok(h.nudges.length === 1, `one nudge sent (got ${h.nudges.length})`)
    ok(h.nudges[0]?.id === '21', 'nudge targets agent 21')
    ok(/wait\.sh/.test(h.nudges[0]?.data || ''), 'nudge tells it to relaunch wait.sh')
    ok(/\r$/.test(h.nudges[0]?.data || ''), 'nudge ends with a submit (CR)')
    ok(h.statuses.some((s) => s.st === 'reconnecting'), "island status set to 'reconnecting'")
    h.wd.stop()
  }

  // 2. Healthy: a poll arrived after the message → no nudge.
  {
    console.log('2. heartbeat alive → no nudge')
    const msgAt = Date.now()
    const h = harness({ poll: () => msgAt + 1000 }) // last poll is AFTER the message
    h.wd.onUndelivered({ agentId: '5', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 25)
    ok(h.nudges.length === 0, `no nudge for a live loop (got ${h.nudges.length})`)
    h.wd.stop()
  }

  // 3. Working: the pane changes across the settle window → no nudge (treated as busy, keeps watching).
  {
    console.log('3. pane changing (working) → no nudge')
    let n = 0
    const h = harness({ pane: () => `frame ${n++}`, poll: () => 0 }) // every capture differs
    h.wd.onUndelivered({ agentId: '7', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 25)
    ok(h.nudges.length === 0, `no nudge while the pane is changing (got ${h.nudges.length})`)
    h.wd.stop()
  }

  // 4. Process gone → no nudge (terminal-manager restart owns that).
  {
    console.log('4. pane not live → no nudge')
    const h = harness({ isLive: () => false, poll: () => 0 })
    h.wd.onUndelivered({ agentId: '9', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 25)
    ok(h.nudges.length === 0, `no nudge when the pane is dead (got ${h.nudges.length})`)
    h.wd.stop()
  }

  // 5. Never recovers → nudges up to maxTries, then gives up to 'error'.
  {
    console.log('5. never recovers → backoff cap then error')
    const h = harness({ pane: () => 'FROZEN', poll: () => 0 })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    await delay(T.graceMs + T.maxTries * (T.settleMs + T.recheckMs) + 120)
    ok(h.nudges.length === T.maxTries, `capped at ${T.maxTries} nudges (got ${h.nudges.length})`)
    ok(h.statuses.some((s) => s.st === 'error'), "gave up to 'error' status")
    h.wd.stop()
    const after = h.nudges.length
    await delay(T.recheckMs + 30)
    ok(h.nudges.length === after, 'no further nudges after give-up/stop')
  }

  // 6. Coalesce: a second message while already recovering does not start a second watcher.
  {
    console.log('6. concurrent messages coalesce')
    const h = harness({ pane: () => 'FROZEN', poll: () => 0 })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 25)
    ok(h.nudges.length === 1, `three messages → one nudge (got ${h.nudges.length})`)
    h.wd.stop()
  }

  console.log(failed === 0 ? '\nPASS (all wake-watchdog cases)' : `\nFAIL (${failed} assertion(s))`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
