// Wake-watchdog AUTH detection: a Claude Code 401 / "not signed in" only ever appears in the agent's terminal
// (never as a JSONL isApiErrorMessage), so the JSONL status detector is blind to it and the island sits on
// "Working…" forever. The watchdog catches the auth pane and surfaces a sticky "Not signed in" error instead of
// trying to nudge a dead agent back to life. This pins that behavior.
//
//   node scripts/tests/test-wake-auth.mjs
import { createWakeWatchdog } from '../../src/main/agent-wake-watchdog.mjs'

let pass = 0
let fail = 0
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL:', m) } }

// Manual timer queue so check()'s arm/settle timers are deterministic.
let clock = 0
const queue = []
const setTimer = (fn, ms) => { const h = { fn, at: clock + ms, dead: false }; queue.push(h); return h }
const clearTimer = (h) => { if (h) h.dead = true }
async function advance(ms) {
  const target = clock + ms
  for (let guard = 0; guard < 10000; guard++) {
    const due = queue.filter((h) => !h.dead && h.at <= target).sort((a, b) => a.at - b.at)[0]
    if (!due) break
    due.dead = true
    clock = due.at
    await due.fn()
    await Promise.resolve()
  }
  clock = target
}

const AUTH_PANE = 'Please run /login · API Error: 401 Invalid authentication credentials\n> '
const CLEAN_PANE = 'Working on your request…\n> '

function mk(paneRef, opts = {}) {
  const authed = []
  const statuses = []
  const wd = createWakeWatchdog({
    lastPollAt: () => opts.lastPollAt ?? 0, // 0 = dead heartbeat
    sendToTerminal: () => {},
    captureTerminal: () => paneRef.text,
    isLive: () => true,
    setStatus: (_id, _ws, st) => statuses.push(st),
    onAuthError: (id, ws) => authed.push(`${id}:${ws}`),
    log: () => {},
    now: () => clock,
    setTimer,
    clearTimer,
    graceMs: 100,
    settleMs: 50,
    recheckMs: 100,
    heartbeatStaleMs: 60000
  })
  return { wd, authed, statuses }
}

// sweep: surfaces once, dedupes, clears on recovery, re-surfaces — and never arms a recovery/override.
{
  const pane = { text: AUTH_PANE }
  const { wd, authed, statuses } = mk(pane)
  wd.sweep([{ agentId: '0', workspace: 'home' }])
  ok(authed.length === 1 && authed[0] === '0:home', 'sweep surfaces auth once')
  wd.sweep([{ agentId: '0', workspace: 'home' }])
  ok(authed.length === 1, 'second sweep is deduped')
  pane.text = CLEAN_PANE
  wd.sweep([{ agentId: '0', workspace: 'home' }])
  ok(authed.length === 1, 'clean pane does not surface')
  pane.text = AUTH_PANE
  wd.sweep([{ agentId: '0', workspace: 'home' }])
  ok(authed.length === 2, 're-surfaces after recovery')
  ok(!statuses.includes('reconnecting'), 'never set the reconnecting override from sweep')
}

// reactive: an undelivered message to an agent whose pane shows auth surfaces via check(), no nudge ladder.
await (async () => {
  const pane = { text: AUTH_PANE }
  const { wd, authed, statuses } = mk(pane, { lastPollAt: -1e9 })
  wd.onUndelivered({ agentId: '0', workspace: 'home' })
  await advance(500)
  ok(authed.length === 1, 'reactive check surfaces auth')
  ok(!statuses.includes('error'), 'did not escalate to the give-up override-error')
})()

console.log(`${fail === 0 ? 'ok' : 'FAIL'} - wake-auth: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
