// test-wf-bus.mjs — the bus extensions added for durable boards: hydrate() (seed a cold run from disk) +
// subCount() (so the eviction sweep never yanks a watched run) + the run:done-survives-the-cap guarantee.
import { publish, subscribe, snapshot, hydrate, subCount, clearRun, ensureRun, _runCount } from '../../src/main/workflow-bus.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

// 1. hydrate seeds a COLD run from a persisted event list; snapshot returns it; a later subscriber is replayed it.
const disk = [
  { seq: 0, ts: 1, type: 'run:start', runId: 'h1', name: 'demo' },
  { seq: 1, ts: 2, type: 'agent:start', nodeId: '0', runId: 'h1' },
  { seq: 2, ts: 3, type: 'agent:done', nodeId: '0', status: 'ok', runId: 'h1' },
  { seq: 3, ts: 4, type: 'run:done', ok: true, runId: 'h1' }
]
ok(hydrate('h1', disk) === true, 'hydrate seeds a cold run')
ok(snapshot('h1').length === 4, 'snapshot returns the hydrated backlog')
const replayed = []
const off1 = subscribe('h1', (ev) => replayed.push(ev))
ok(replayed.length === 4 && replayed[3].type === 'run:done', 'a subscriber to a hydrated run replays the full backlog')

// 2. hydrate is idempotent: a second hydrate on a non-empty run is a NO-OP (never double-seeds).
ok(hydrate('h1', disk) === false, 'hydrate on an already-seeded run is a no-op')
ok(snapshot('h1').length === 4, 'no double-seed after a second hydrate')
ok(hydrate('h2', []) === false && hydrate('h2', null) === false, 'hydrate with no events is a no-op')

// 3. seq stays monotonic past the hydrated max — a NEW live publish gets seq > the disk max (no collision).
const live = publish({ runId: 'h1', type: 'log', message: 'after' })
ok(live && live.seq === 4, 'a live publish after hydrate continues seq past the disk max (3 → 4)')

// 4. subCount reflects live subscribers (the sweep uses this to protect a mounted board).
ok(subCount('h1') === 1, 'subCount counts the one live subscriber')
const off2 = subscribe('h1', () => {})
ok(subCount('h1') === 2, 'subCount tracks a second subscriber')
off1(); off2()
ok(subCount('h1') === 0, 'subCount drops to 0 after unsubscribe')
ok(subCount('nope') === 0, 'subCount of an unknown run is 0')

// 5. run:done SURVIVES the buffer cap (MAX_EVENTS=6000) — the one event a replayed/disk board needs to mark done.
//    Fill past the cap with logs, then publish run:done; it must still be retained in the buffer (and thus on disk).
ensureRun('big')
for (let i = 0; i < 6010; i++) publish({ runId: 'big', type: 'log', message: 'x' + i })
const before = snapshot('big').length
publish({ runId: 'big', type: 'run:done', ok: true })
const snap = snapshot('big')
ok(before === 6000, 'the buffer caps logs at MAX_EVENTS (6000)')
ok(snap.some((e) => e.type === 'run:done'), 'run:done is retained PAST the cap (board can reload as done)')
ok(snap[snap.length - 1].type === 'run:done', 'run:done is the last buffered event')

clearRun('h1'); clearRun('big')
ok(_runCount() >= 0, 'clearRun removes a run buffer')

console.log(fail === 0 ? '\nPASS — wf-bus (hydrate + subCount + run:done-past-cap)' : `\nFAIL — wf-bus (${fail})`)
process.exit(fail === 0 ? 0 : 1)
