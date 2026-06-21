// Unit test for the self-healing agent wake watchdog (src/main/agent-wake-watchdog.mjs).
// Pure state machine with injected deps — driven here with real (tiny) timers + mutable fakes.
// Run: node scripts/tests/test-wake-watchdog.mjs
import { createWakeWatchdog } from '../../src/main/agent-wake-watchdog.mjs'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (cond, msg) => { if (!cond) { failed++; console.error('  ✗ ' + msg) } else { console.log('  ✓ ' + msg) } }

// Small timings so the suite runs in well under a second; real timers (no fake-clock indirection).
const T = { graceMs: 30, settleMs: 10, recheckMs: 30, maxTries: 3, maxWatchMs: 100_000, submitDelayMs: 8, rateLimitBackoffMs: 40 }
const RL_PANE = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'

function harness({ pane = () => 'FROZEN', poll = () => 0, isLive = () => true } = {}) {
  const writes = []
  const statuses = []
  const wd = createWakeWatchdog({
    ...T,
    lastPollAt: (id) => poll(id),
    sendToTerminal: (id, data) => { writes.push({ id, data }); return true },
    captureTerminal: () => pane(),
    isLive: (id) => isLive(id),
    setStatus: (id, ws, st) => statuses.push({ id, ws, st }),
    log: () => {}
  })
  // A nudge is now TWO writes: the catch-up text, then a SEPARATE '\r' (Enter). Track them apart.
  const textNudges = () => writes.filter((w) => /wait\.sh/.test(w.data))
  const enters = () => writes.filter((w) => w.data === '\r')
  return { wd, writes, statuses, textNudges, enters }
}

async function run() {
  // 1. Dead loop + frozen pane → one text nudge + a SEPARATE Enter (the submit-fix), + 'reconnecting'.
  {
    console.log('1. dead+frozen → nudge submits as text + separate Enter (not text+\\r)')
    const h = harness({ pane: () => 'FROZEN', poll: () => 0 })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + T.submitDelayMs + 30)
    ok(h.textNudges().length === 1, `one text nudge (got ${h.textNudges().length})`)
    ok(h.textNudges()[0]?.id === '21', 'nudge targets agent 21')
    ok(!/\r/.test(h.textNudges()[0]?.data || ''), 'the text write contains NO carriage return (the old bug)')
    ok(h.enters().length === 1, `Enter sent as a SEPARATE write (got ${h.enters().length})`)
    ok(h.statuses.some((s) => s.st === 'reconnecting'), "island status set to 'reconnecting'")
    h.wd.stop()
  }

  // 2. Healthy: a poll arrived after the message → no nudge.
  {
    console.log('2. heartbeat alive → no nudge')
    const msgAt = Date.now()
    const h = harness({ poll: () => msgAt + 1000 })
    h.wd.onUndelivered({ agentId: '5', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 30)
    ok(h.textNudges().length === 0, `no nudge for a live loop (got ${h.textNudges().length})`)
    h.wd.stop()
  }

  // 3. Working: the pane changes across the settle window → no nudge.
  {
    console.log('3. pane changing (working) → no nudge')
    let n = 0
    const h = harness({ pane: () => `frame ${n++}`, poll: () => 0 })
    h.wd.onUndelivered({ agentId: '7', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 30)
    ok(h.textNudges().length === 0, `no nudge while the pane is changing (got ${h.textNudges().length})`)
    h.wd.stop()
  }

  // 4. Process gone → no nudge.
  {
    console.log('4. pane not live → no nudge')
    const h = harness({ isLive: () => false, poll: () => 0 })
    h.wd.onUndelivered({ agentId: '9', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 30)
    ok(h.textNudges().length === 0, `no nudge when the pane is dead (got ${h.textNudges().length})`)
    h.wd.stop()
  }

  // 5. Never recovers, NOT rate-limited → nudges up to maxTries, then gives up to 'error'.
  {
    console.log('5. never recovers (not rate-limited) → backoff cap then error')
    const h = harness({ pane: () => 'FROZEN', poll: () => 0 })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    await delay(T.graceMs + T.maxTries * (T.settleMs + T.recheckMs) + 160)
    ok(h.textNudges().length === T.maxTries, `capped at ${T.maxTries} text nudges (got ${h.textNudges().length})`)
    ok(h.statuses.some((s) => s.st === 'error'), "gave up to 'error' status")
    h.wd.stop()
  }

  // 6. Concurrent messages coalesce.
  {
    console.log('6. concurrent messages coalesce')
    const h = harness({ pane: () => 'FROZEN', poll: () => 0 })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    h.wd.onUndelivered({ agentId: '21', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + T.submitDelayMs + 30)
    ok(h.textNudges().length === 1, `three messages → one nudge (got ${h.textNudges().length})`)
    h.wd.stop()
  }

  // 7. RATE-LIMITED → holds first (no nudge), probes on a long backoff, and NEVER escalates to 'error'.
  {
    console.log('7. rate-limited → hold first, probe on backoff, never error')
    const h = harness({ pane: () => RL_PANE, poll: () => 0 })
    h.wd.onUndelivered({ agentId: '27', workspace: 'case-file' })
    await delay(T.graceMs + T.settleMs + 20)
    ok(h.textNudges().length === 0, `no nudge on first rate-limit sighting — held (got ${h.textNudges().length})`)
    ok(h.statuses.some((s) => s.st === 'reconnecting'), "held at 'reconnecting'")
    await delay(2 * T.rateLimitBackoffMs + 60) // let a couple of backoffs elapse → probe nudge(s)
    ok(h.textNudges().length >= 1, `probes a nudge after backoff (got ${h.textNudges().length})`)
    ok(!h.statuses.some((s) => s.st === 'error'), "rate-limit NEVER escalates to 'error'")
    h.wd.stop()
  }

  // 8. Rate-limit CLEARS → the next probe wakes it (heartbeat resumes) → watchdog clears the record.
  {
    console.log('8. rate-limit clears → probe wakes it, watchdog clears')
    let limited = true
    const h = harness({
      pane: () => (limited ? RL_PANE : 'FROZEN'),
      poll: () => (limited ? 0 : Date.now()) // once the limit lifts, the agent re-polls (heartbeat advances)
    })
    h.wd.onUndelivered({ agentId: '27', workspace: 'case-file' })
    await delay(T.graceMs + T.rateLimitBackoffMs + 30) // first hold, into the probe cycle
    limited = false                                    // limit lifts
    await delay(T.rateLimitBackoffMs + T.settleMs + 50)
    ok(h.wd._size() === 0, 'watchdog cleared the agent once its heartbeat resumed')
    h.wd.stop()
  }

  console.log(failed === 0 ? '\nPASS (all wake-watchdog cases)' : `\nFAIL (${failed} assertion(s))`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
