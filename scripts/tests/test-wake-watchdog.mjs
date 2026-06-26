// Unit test for the self-healing agent wake watchdog (src/main/agent-wake-watchdog.mjs).
// Pure state machine with injected deps — driven here with real (tiny) timers + mutable fakes.
// Run: node scripts/tests/test-wake-watchdog.mjs
import { createWakeWatchdog, parseResetAt, SESSION_LIMIT_RE, API_ERROR_RE } from '../../src/main/agent-wake-watchdog.mjs'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (cond, msg) => { if (!cond) { failed++; console.error('  ✗ ' + msg) } else { console.log('  ✓ ' + msg) } }

// Small timings so the suite runs in well under a second; real timers (no fake-clock indirection).
const T = { graceMs: 30, settleMs: 10, recheckMs: 30, maxTries: 3, maxWatchMs: 100_000, submitDelayMs: 8, rateLimitBackoffMs: 40, resumeBufferMs: 10, resumeCooldownMs: 4_000 }
const RL_PANE = 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited'

// A usage/session-limit pane whose reset time is the CURRENT minute, so parseResetAt returns ~now and the
// scheduled resume fires almost immediately (delay collapses to resumeBufferMs) — keeps the suite sub-second.
function sessionPane(d = new Date()) {
  let h = d.getHours(); const m = d.getMinutes(); const ap = h >= 12 ? 'pm' : 'am'
  h = h % 12; if (h === 0) h = 12
  return `You've hit your session limit · resets ${h}:${String(m).padStart(2, '0')}${ap} (America/Los_Angeles)\n/usage-credits to finish what you're working on.`
}

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
  // A nudge is now TWO writes: the directive text, then a SEPARATE '\r' (Enter). Track them apart. The deaf-loop
  // nudge mentions wait.sh; the usage-limit resume says "usage limit has reset".
  const textNudges = () => writes.filter((w) => /wait\.sh/.test(w.data) && !/usage limit has reset/i.test(w.data))
  const resumeNudges = () => writes.filter((w) => /usage limit has reset/i.test(w.data))
  const enters = () => writes.filter((w) => w.data === '\r')
  return { wd, writes, statuses, textNudges, resumeNudges, enters }
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

  // 9. parseResetAt: future time, just-passed (resume now), after-midnight wrap, and no-match.
  {
    console.log('9. parseResetAt — local wall-clock, closest occurrence')
    const at = (s) => new Date(s).getTime()
    ok(parseResetAt("resets 6:40pm (America/Los_Angeles)", at('2026-06-21T16:35:00')) === at('2026-06-21T18:40:00'), 'future reset → today 6:40pm')
    ok(parseResetAt('resets 6:40pm', at('2026-06-21T18:50:00')) === at('2026-06-21T18:40:00'), 'just-passed reset → in the past (fires now), not tomorrow')
    ok(parseResetAt('limit · resets 12:30am', at('2026-06-21T23:50:00')) === at('2026-06-22T00:30:00'), 'after-midnight → tomorrow 12:30am')
    ok(parseResetAt('no limit here', Date.now()) === null, 'no reset time → null')
    ok(SESSION_LIMIT_RE.test("You've hit your session limit · resets 6:40pm") && !SESSION_LIMIT_RE.test('just a normal pane'), 'SESSION_LIMIT_RE matches a session-limit pane only')
  }

  // 10. SESSION LIMIT (undelivered message path) → schedules a resume that fires at the reset, submits the RESUME
  //     directive as text + a SEPARATE Enter, sets 'reconnecting', and NEVER escalates to 'error'.
  {
    console.log('10. session limit → scheduled resume submits at reset, never errors')
    const h = harness({ pane: () => sessionPane(), poll: () => 0 })
    h.wd.onUndelivered({ agentId: '31', workspace: 'Home' })
    await delay(T.graceMs + T.settleMs + T.resumeBufferMs + T.submitDelayMs + 60)
    ok(h.resumeNudges().length === 1, `one resume directive submitted (got ${h.resumeNudges().length})`)
    ok(h.resumeNudges()[0]?.id === '31', 'resume targets agent 31')
    ok(!/\r/.test(h.resumeNudges()[0]?.data || ''), 'resume text carries NO carriage return')
    ok(h.enters().length === 1, 'Enter sent as a SEPARATE write')
    ok(h.textNudges().length === 0, 'no blind deaf-loop nudge for a usage limit')
    ok(h.statuses.some((s) => s.st === 'reconnecting') && !h.statuses.some((s) => s.st === 'error'), "'reconnecting', never 'error'")
    h.wd.stop()
  }

  // 11. SWEEP arms a usage-limited IDLE agent with NO undelivered message (the proactive gap fix); a healthy
  //     idle agent (no limit on its pane) is left alone.
  {
    console.log('11. sweep arms a self-limited idle agent; ignores a healthy one')
    const h = harness({ pane: () => sessionPane(), poll: () => 0 })
    h.wd.sweep([{ agentId: '31', workspace: 'Home' }])
    await delay(T.settleMs + T.settleMs + T.resumeBufferMs + T.submitDelayMs + 60)
    ok(h.resumeNudges().length === 1, `sweep alone (no message) triggered the resume (got ${h.resumeNudges().length})`)
    h.wd.stop()

    const h2 = harness({ pane: () => 'idle, waiting for the user', poll: () => 0 })
    h2.wd.sweep([{ agentId: '7', workspace: 'Home' }])
    await delay(T.settleMs + T.settleMs + T.resumeBufferMs + 40)
    ok(h2.resumeNudges().length === 0 && h2.wd._size() === 0, 'a healthy idle agent is NOT armed by the sweep')
    h2.wd.stop()
  }

  // 12. Cooldown: after a resume fires, an immediate re-sweep does not re-arm the same agent (no resume storm).
  {
    console.log('12. post-resume cooldown blocks an immediate re-sweep')
    const h = harness({ pane: () => sessionPane(), poll: () => 0 })
    h.wd.sweep([{ agentId: '31', workspace: 'Home' }])
    await delay(T.settleMs + T.settleMs + T.resumeBufferMs + T.submitDelayMs + 60)
    ok(h.resumeNudges().length === 1, 'first resume fired')
    h.wd.sweep([{ agentId: '31', workspace: 'Home' }]) // still limited pane, but within cooldown
    await delay(T.settleMs + T.settleMs + T.resumeBufferMs + 40)
    ok(h.resumeNudges().length === 1, 'cooldown blocked a second resume (still 1)')
    h.wd.stop()
  }

  // 13. A usage-limit line in a WORKING pane (changing across the settle window) → no schedule (don't resume a
  //     busy agent off a stale scrollback line).
  {
    console.log('13. limit line but pane is changing (working) → no resume')
    let n = 0
    const h = harness({ pane: () => `${sessionPane()}\nframe ${n++}`, poll: () => 0 })
    h.wd.sweep([{ agentId: '31', workspace: 'Home' }])
    await delay(T.settleMs + T.settleMs + T.resumeBufferMs + 40)
    ok(h.resumeNudges().length === 0, 'no resume while the pane is changing')
    h.wd.stop()
  }

  // 14. API_ERROR_RE classifies a transient 5xx / connection-drop pane, but NOT a 529/overloaded (that is the
  //     rate-limit's job) and not a normal pane.
  {
    console.log('14. API_ERROR_RE matches a crashed-turn 5xx, leaves 529/overloaded to the rate-limit path')
    ok(API_ERROR_RE.test('API Error: 500 Internal server error.'), 'matches API Error: 500')
    ok(API_ERROR_RE.test('API Error: 503 Service Unavailable'), 'matches API Error: 503')
    ok(API_ERROR_RE.test('API Error: Connection error.'), 'matches a dropped connection')
    ok(!API_ERROR_RE.test('API Error: 529 overloaded'), '529/overloaded is NOT an api-error (rate-limit owns it)')
    ok(!API_ERROR_RE.test('idle, waiting for the user'), 'a healthy idle pane is not an api-error')
  }

  // 15. SWEEP recovers a CRASHED-TURN agent: an API-error pane + a DEAD heartbeat (no recent poll) is armed and
  //     probed immediately (unlike a 429 which holds first), and never escalates to 'error'. The exact agent-3 bug:
  //     the message was delivered+consumed, the turn died on a 500, the loop never relaunched — silent forever.
  {
    console.log('15. sweep recovers a crashed-turn (API error + dead heartbeat) → immediate probe, never error')
    const API_PANE = 'API Error: 500 Internal server error. This is a server-side issue, usually temporary.'
    const h = harness({ pane: () => API_PANE, poll: () => 0 }) // poll:0 ⇒ heartbeat is ancient (dead loop)
    h.wd.sweep([{ agentId: '42', workspace: 'case-file' }])
    await delay(T.settleMs + T.settleMs + T.submitDelayMs + 40)
    ok(h.textNudges().length >= 1, `crashed-turn agent gets a recovery nudge (got ${h.textNudges().length})`)
    ok(h.textNudges()[0]?.id === '42', 'nudge targets the crashed agent')
    ok(h.enters().length >= 1, 'Enter sent as a separate write (submit-fix)')
    ok(h.statuses.some((s) => s.st === 'reconnecting'), "status set to 'reconnecting' while recovering")
    await delay(2 * T.rateLimitBackoffMs + 40)
    ok(!h.statuses.some((s) => s.st === 'error'), 'a transient API error NEVER escalates to error')
    h.wd.stop()
  }

  // 16. SWEEP does NOT arm a crashed-turn pane whose heartbeat is still ALIVE (the loop is up and will re-deliver on
  //     its own) — the dead-heartbeat gate is what prevents stealing recovery from a healthy wait.sh.
  {
    console.log('16. sweep ignores an API-error pane with a LIVE heartbeat (loop self-recovers)')
    const h = harness({ pane: () => 'API Error: 500 Internal server error.', poll: () => Date.now() }) // fresh poll
    h.wd.sweep([{ agentId: '43', workspace: 'case-file' }])
    await delay(T.settleMs + T.settleMs + T.submitDelayMs + 40)
    ok(h.textNudges().length === 0 && h.wd._size() === 0, 'live-heartbeat agent left alone (no nudge, not armed)')
    h.wd.stop()
  }

  // 17. The crashed-turn agent RECOVERS: once its heartbeat resumes (wait.sh relaunched), the next probe clears the
  //     record AND drops the 'reconnecting' status override.
  {
    console.log('17. crashed-turn recovery → heartbeat resumes → record cleared + status restored')
    let down = true
    const h = harness({
      pane: () => (down ? 'API Error: 500 Internal server error.' : 'FROZEN'),
      poll: () => (down ? 0 : Date.now()) // when the API recovers, the agent relaunches wait.sh → heartbeat advances
    })
    h.wd.sweep([{ agentId: '44', workspace: 'case-file' }])
    await delay(T.settleMs + T.settleMs + T.submitDelayMs + 30)
    ok(h.statuses.some((s) => s.st === 'reconnecting'), 'reconnecting while down')
    down = false // API recovers, loop relaunches
    await delay(T.rateLimitBackoffMs + T.settleMs + 60)
    ok(h.wd._size() === 0, 'watchdog cleared the agent once its heartbeat resumed')
    ok(h.statuses.some((s) => s.st === null), "'reconnecting' override cleared on recovery")
    h.wd.stop()
  }

  console.log(failed === 0 ? '\nPASS (all wake-watchdog cases)' : `\nFAIL (${failed} assertion(s))`)
  process.exit(failed === 0 ? 0 : 1)
}
run()
