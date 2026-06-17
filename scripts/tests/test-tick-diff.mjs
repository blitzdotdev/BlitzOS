#!/usr/bin/env node
// W2 supervisor TICK -> DIFF -> STEER (plans/blitzos-tick-diff-steer.md): the host-side heartbeat snapshots
// the desktop, diffs it against the prior tick, and emits ONE trigger:'tick' moment ONLY when the diff is
// MATERIAL (content-agnostic transition-shape). Pure core — no Electron; we drive emitTick() DIRECTLY (not
// the unref'd sweepTimer) and mutate what the registered provider returns between calls, so the
// snapshot/diff/baseline progression is fully under the test's control. Run: node scripts/tests/test-tick-diff.mjs
//
// Option A is the contract: BlitzOS only ticks/diffs/emits; the AGENT owns ALL steering judgment; ZERO
// per-task/stuck/threshold heuristics live in the kernel. So we assert CONTENT-AGNOSTIC materiality directly:
//   (1) a MATERIAL change (agent working->{waiting,stopped,error}, *->error, agent added/closed, a terminal
//       exitCode appears, a surface's PROPS change) emits EXACTLY ONE trigger:'tick' moment the supervisor
//       '0' receives; an IMMATERIAL tick (identical snapshot, working->working, ramp-up, pure geometry) emits
//       NOTHING and does NOT advance latestSeq (the `if (!diff.material) return` mirrors `if (!p.hasUser)`).
//   (2) DESIGN: a surface OPEN/CLOSE is NOT a tick delta — the trigger:'canvas' moment already owns ALL
//       structural surface changes (open/close/move/resize) and already routes to '0', so the tick must not
//       also diff presence (that double-woke the supervisor on one open/close and self-reacted to its own ops).
//   (3) the self-reaction guard is TIMING-ROBUST (per-delta absorbTickEcho + baseline reset, NOT a Date.now()
//       time window): absorbTickEcho({surfaces:[X]}) before a tick makes the NEXT tick skip X's delta (a tool
//       op the agent made does not self-wake the supervisor) regardless of WHEN that tick fires; the absorb is
//       ONE-SHOT (a later non-absorbed change to X wakes normally); it is PER-DELTA (a concurrent genuine
//       agent-status edge in the SAME tick still wakes — never over-suppressed); and resetTickBaseline()
//       re-seeds so a BULK change (workspace switch) is never diffed.
//   (4) the EMITTED tick moment is CONTENT-FREE (no url/title/snapshot/props on it): the tick is relay-safe
//       BY CONSTRUCTION (emitTick carries only ids/change-kind/title/status-edges/counts), NOT because some
//       redactor strips it. (redactMoment is currently uncalled repo-wide — see perception-core.mjs TODO.)
//   (5) the /steer path: the steering primitive emits a PRIVATE trigger:'message' moment visible ONLY to the
//       target agent 'N' (NOT the primary '0').
//
// WHY (5) drives emitUserMessage directly: the relay/localhost `steer` tool (os-tools.mjs) calls
// `ops.steer(text, agent)`, which in BOTH transports funnels into the perception-kernel primitive
// emitUserMessage(text, agentId) — Electron via osActions.osUserMessage, the server via backend.mjs.
// `ops.steer`/`osUserMessage` are IPC-/chat.md-bound, so they cannot be imported into a Node ESM test;
// emitUserMessage IS the wake mechanism `steer` depends on (the private-to-target routing under test lives
// entirely in perception-core's visibleTo), so we test THAT primitive — exactly how test-job-model
// reproduces index.ts's boot-task closure against the real underlying functions.
import {
  setTickSource, resetTickBaseline, absorbTickEcho, emitTick,
  emitUserMessage, waitForEvents, latestSeq, setWorkspaceProvider
} from '../../src/main/perception-core.mjs'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

// The single mutable host snapshot the registered provider returns; the test rewrites `snap` between ticks.
// Shape mirrors what osActions.ts / backend.mjs feed setTickSource:
//   { agentStatus:{id->status}, terminals:[{id,status,exitCode?}], surfaces:[{id,kind,x,y,w,h,title,props?}], workspace? }
let snap = { agentStatus: {}, terminals: [], surfaces: [], workspace: 'WS' }
setTickSource(() => snap)
setWorkspaceProvider(() => null) // tick stamps its own workspace from snap.workspace; no provider override

// Collect every tick moment the supervisor '0' would receive since a cursor (waitForEvents maxMs:0 is the
// synchronous "what's visible right now" read used across the perception tests).
const ticksSince = async (since) => (await waitForEvents(since, 0, '0')).filter((m) => m.trigger === 'tick')

console.log('W2 supervisor TICK -> DIFF -> STEER (src/main/perception-core.mjs):')

// 1) the FIRST tick after a provider is wired seeds the baseline and emits NOTHING (else the whole world
//    reads as "new"). After this, `snap` IS the diff baseline.
let since = latestSeq()
snap = { agentStatus: { 0: 'working' }, terminals: [{ id: '0', status: 'running', exitCode: null }], surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 1 } }], workspace: 'WS' }
emitTick()
ok('the FIRST tick seeds the baseline and emits nothing (latestSeq unchanged)', latestSeq() === since, { since, after: latestSeq() })

// 2) an immaterial tick (no change at all) emits nothing
since = latestSeq()
emitTick()
ok('an unchanged world emits nothing (latestSeq unchanged)', latestSeq() === since, { since, after: latestSeq() })

// 3) working -> watching is NOT material (quiet); 4) starting -> working (ramp-up) is NOT material
since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'watching' } }
emitTick()
ok('working -> watching is NOT material', latestSeq() === since)

since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'starting' } }
emitTick() // watching->starting (not an edge we flag) — also immaterial
snap = { ...snap, agentStatus: { 0: 'working' } }
since = latestSeq()
emitTick()
ok('starting -> working (ramp-up) is NOT material', latestSeq() === since)

// 5) working -> waiting IS material (the steerable edge) — exactly one tick, full diff/user assertions
since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'waiting' } }
emitTick()
let ticks = await ticksSince(since)
ok('working -> waiting emits one tick', ticks.length === 1, `got ${ticks.length}`)
ok('the tick carries the status edge in diff.agents (0: working -> waiting)', ticks[0]?.diff?.agents?.some((a) => String(a.id) === '0' && a.from === 'working' && a.to === 'waiting'), JSON.stringify(ticks[0]?.diff?.agents))
ok('the tick `user` summary mentions the agent status edge', Array.isArray(ticks[0]?.user) && ticks[0].user.some((u) => /agent 0.*working.*waiting/.test(String(u))), ticks[0]?.user)
ok('the tick surfaceId is desktop (routes to the primary supervisor)', ticks[0]?.surfaceId === 'desktop')
ok('the tick is workspace-stamped', ticks[0]?.workspace === 'WS')

// 6) * -> error is ALWAYS material (even from a non-working status)
since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'error' } } // waiting -> error
emitTick()
ticks = await ticksSince(since)
ok('* -> error is always material', ticks.length === 1 && ticks[0].diff.agents.some((a) => a.to === 'error'), JSON.stringify(ticks[0]?.diff?.agents))

// 7) a NEW agent appearing is material (agent added); a vanished one is material (closed)
since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'error', 1: 'working' } }
emitTick()
ticks = await ticksSince(since)
ok('agent added (the agent SET grew) is material', ticks.length === 1 && ticks[0].diff.agents.some((a) => a.id === '1' && a.from === null), JSON.stringify(ticks[0]?.diff?.agents))
since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'error' } } // agent 1 disappears
emitTick()
ticks = await ticksSince(since)
ok('agent closed (the agent SET shrank) is material', ticks.length === 1 && ticks[0].diff.agents.some((a) => a.id === '1' && a.to === null), JSON.stringify(ticks[0]?.diff?.agents))

// 8) a terminal exit (new exitCode) is material — including exitCode:0 (the falsy-0 trap: the differ uses != null)
since = latestSeq()
snap = { ...snap, terminals: [{ id: '0', status: 'exited', exitCode: 1 }] }
emitTick()
ticks = await ticksSince(since)
ok('a terminal exit (exitCode appears) is material', ticks.length === 1 && ticks[0].diff.terminals.some((t) => t.id === '0' && t.exitCode === 1), JSON.stringify(ticks[0]?.diff?.terminals))
since = latestSeq()
snap = { ...snap, terminals: [{ id: '2', status: 'exited', exitCode: 0 }, ...snap.terminals] } // a NEW terminal exiting with code 0
emitTick()
ticks = await ticksSince(since)
ok('exitCode 0 is treated as a real exit (not swallowed as falsy)', ticks.length === 1 && ticks[0].diff.terminals.some((t) => t.id === '2' && t.exitCode === 0), JSON.stringify(ticks[0]?.diff?.terminals))

// 9) DESIGN: a surface OPEN is NOT a tick delta (the trigger:'canvas' moment owns structural surface changes).
since = latestSeq()
snap = { ...snap, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 1 } }, { id: 's2', kind: 'native', title: 'Note', props: {} }] }
emitTick()
ok('a surface OPEN does NOT emit a tick (the canvas moment owns it — no double-wake)', latestSeq() === since, { since, after: latestSeq() })

// 10) a surface PROPS edit IS material (a widget was edited — the user-action half the canvas moment lacks).
since = latestSeq()
snap = { ...snap, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 2 } }, { id: 's2', kind: 'native', title: 'Note', props: {} }] }
emitTick()
ticks = await ticksSince(since)
ok('a surface PROPS edit is material', ticks.length === 1 && ticks[0].diff.surfaces.some((s) => s.id === 's1' && s.change === 'edited'), JSON.stringify(ticks[0]?.diff?.surfaces))

// 11) DESIGN: a surface CLOSE is NOT a tick delta either (again owned by the canvas moment).
since = latestSeq()
snap = { ...snap, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 2 } }] } // s2 closed
emitTick()
ok('a surface CLOSE does NOT emit a tick (the canvas moment owns it — no double-wake)', latestSeq() === since, { since, after: latestSeq() })

// 12) pure GEOMETRY (move/resize) with identical props is NOT material (geometry rides the 'canvas' moment)
since = latestSeq()
snap = { ...snap, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 2 }, x: 500, y: 500, w: 999, h: 999 }] }
emitTick()
ok('a pure geometry move/resize is NOT material', latestSeq() === since)

// 13) deep props equality: an equal-but-new props object must NOT count as an edit
since = latestSeq()
snap = { ...snap, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 2 }, x: 500, y: 500, w: 999, h: 999 }] } // same props {v:2}, fresh object
emitTick()
ok('deep-equal props (new object, same shape) is NOT an edit', latestSeq() === since)

// 14) the TIMING-ROBUST self-reaction guard (replaces the old setTickSuppressed Date.now() window):
//     absorbTickEcho({surfaces:[X]}) before a tick makes the NEXT tick SKIP X's props delta (a tool op the
//     agent made does not self-wake the supervisor). It is consumed by exactly THAT tick — there is NO
//     time-window: the suppression holds no matter WHEN the next tick fires (the old guard only suppressed if
//     the tick happened to fall within CANVAS_BULK_WINDOW of the op, the exact bug). It is ONE-SHOT: a LATER
//     non-absorbed change to X wakes '0' (the plan-edit -> steer signal, e.g. a USER widget edit via the
//     renderer push, which never absorbs). It is PER-DELTA: a concurrent genuine agent-status edge in the
//     SAME absorbed tick still wakes, and the emitted diff carries the edge but NOT the absorbed surface.

// 14a) absorb X, then a props edit to X => NO emit (X's tool-origin delta is suppressed for this one tick)
since = latestSeq()
absorbTickEcho({ surfaces: ['s1'] }) // the agent just edited s1 via update_surface/customize_widget
snap = { ...snap, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 3 }, x: 500, y: 500, w: 999, h: 999 }] } // props v2 -> v3 (the agent's own edit)
emitTick()
ok('an ABSORBED (tool-origin) surface props change does NOT wake the supervisor (regardless of tick timing)', latestSeq() === since, { since, after: latestSeq() })

// 14b) the absorb is ONE-SHOT: the very next, non-absorbed props change to the SAME surface DOES wake '0'
//      (proves the absorb is not sticky — a USER edit after the agent's own edit still steers the supervisor)
since = latestSeq()
snap = { ...snap, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 4 }, x: 500, y: 500, w: 999, h: 999 }] } // a fresh (non-absorbed) edit v3 -> v4
emitTick()
ticks = await ticksSince(since)
ok('the absorb is ONE-SHOT: a later non-absorbed edit to the same surface DOES wake the supervisor', ticks.length === 1 && ticks[0].diff.surfaces.some((s) => s.id === 's1' && s.change === 'edited'), JSON.stringify(ticks[0]?.diff?.surfaces))

// 14c) PER-DELTA: a tick where surface X is absorbed BUT a genuine agent status edge (working -> stopped) ALSO
//      changed => EMITS (the agent edge wakes), and the emitted diff carries the agent edge but NOT the
//      absorbed surface. (First settle 0 -> working so the next edge is a material working -> stopped.)
snap = { ...snap, agentStatus: { 0: 'working' } } // error/whatever -> working: not a material edge, just re-settle the baseline
emitTick()
since = latestSeq()
absorbTickEcho({ surfaces: ['s1'] }) // the agent edits s1 in the SAME tick a real status edge lands
snap = { ...snap, agentStatus: { 0: 'stopped' }, surfaces: [{ id: 's1', kind: 'srcdoc', title: 'Plan', props: { v: 5 }, x: 500, y: 500, w: 999, h: 999 }] } // working->stopped AND s1 v4->v5
emitTick()
ticks = await ticksSince(since)
ok('PER-DELTA: a concurrent genuine agent-status edge in an absorbed tick STILL wakes', ticks.length === 1, `got ${ticks.length}`)
ok('…the emitted diff carries the agent status edge (0: working -> stopped)', ticks[0]?.diff?.agents?.some((a) => String(a.id) === '0' && a.from === 'working' && a.to === 'stopped'), JSON.stringify(ticks[0]?.diff?.agents))
ok('…but the absorbed surface s1 is NOT in the diff (no over-suppression of the OTHER delta, no leak of the absorbed one)', !(ticks[0]?.diff?.surfaces || []).some((s) => s.id === 's1'), JSON.stringify(ticks[0]?.diff?.surfaces))

// 14d) resetTickBaseline() (a BULK transaction — workspace switch) makes the next tick RE-SEED, so even a
//      MASSIVE snapshot change emits nothing (the whole world would otherwise read as new user/agent signals).
resetTickBaseline()
since = latestSeq()
snap = { agentStatus: { 0: 'waiting', 7: 'working' }, terminals: [{ id: '9', status: 'exited', exitCode: 1 }], surfaces: [{ id: 'sX', kind: 'native', title: 'Brand New', props: { a: 1 } }], workspace: 'WS2' } // a wholly different world
emitTick()
ok('resetTickBaseline() re-seeds: a workspace-switch-like mass change emits NOTHING', latestSeq() === since, { since, after: latestSeq() })
// and the tick AFTER the re-seed diffs against the new baseline normally (a real edge on it wakes)
since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'error', 7: 'working' } } // waiting -> error on agent 0
emitTick()
ticks = await ticksSince(since)
ok('the tick after a re-seed diffs the NEW baseline normally (a real edge wakes)', ticks.length === 1 && ticks[0].diff.agents.some((a) => String(a.id) === '0' && a.to === 'error'), JSON.stringify(ticks[0]?.diff?.agents))

// 15) the EMITTED tick moment is CONTENT-FREE: the tick is relay-safe BY CONSTRUCTION — emitTick puts only
//     ids/change-kind/title/status-edges/counts on the moment, never the scraped CONTENT of a surface (no
//     url/title/snapshot, and the diff carries no `props`). We assert the moment AS EMITTED, not via any
//     redactor (redactMoment is uncalled repo-wide — see perception-core.mjs TODO).
{
  const t = ticks[0] // the agent-edge tick from case 14d
  ok('the emitted tick moment carries NO scraped page content (no url/title/snapshot)',
    !('url' in t) && !('title' in t) && !('snapshot' in t), Object.keys(t))
  ok('the tick diff.surfaces entries are metadata-only (id/change/kind/title — NO props leak)',
    Array.isArray(t.diff?.surfaces) && t.diff.surfaces.every((s) => !('props' in s)), t.diff?.surfaces)
  const allowed = new Set(['seq', 'ts', 'surfaceId', 'trigger', 'windowMs', 'signals', 'user', 'diff', 'workspace'])
  ok('the emitted tick exposes ONLY content-free metadata keys',
    Object.keys(t).every((k) => allowed.has(k)), Object.keys(t))
}

// 16) the /steer path: emitUserMessage('…','N') is PRIVATE to agent N (NOT the primary '0'). The steering
//     primitive (ops.steer -> osUserMessage/emitUserMessage) lands a trigger:'message' moment routed ONLY to
//     its target agent via visibleTo, so a supervisor can nudge a SPECIFIC running Job without waking the
//     whole desktop watcher.
{
  const cursor = latestSeq()
  emitUserMessage('course-correct: the user just edited the plan, re-read surf-plan-1', '1')
  const toTarget = await waitForEvents(cursor, 0, '1') // agent '1' is the steered target
  ok('steer (emitUserMessage to N) wakes the TARGET agent N with exactly one moment', toTarget.length === 1, toTarget.length)
  ok('the steered moment is a trigger:message addressed to agent 1', toTarget[0]?.trigger === 'message' && String(toTarget[0]?.agentId) === '1', toTarget[0] && { trigger: toTarget[0].trigger, agentId: toTarget[0].agentId })
  ok('the steered directive text rides the moment', /re-read surf-plan-1/.test(String(toTarget[0]?.message || '')), toTarget[0]?.message)
  const toPrimary = await waitForEvents(cursor, 0, '0') // the primary must NOT see a steer aimed at 1
  ok('the steer is PRIVATE: the primary supervisor 0 does NOT receive a message aimed at agent 1', !toPrimary.some((m) => m.trigger === 'message' && String(m.agentId) === '1'), toPrimary.length)
  // Symmetry guard: a steer aimed at '0' DOES reach '0' (so the routing isn't just "never show 0 messages").
  const c2 = latestSeq()
  emitUserMessage('primary: rebalance the stage', '0')
  const toPrimary2 = await waitForEvents(c2, 0, '0')
  ok('a steer aimed at the primary 0 DOES reach 0 (routing is by target id, not a 0-blocklist)', toPrimary2.some((m) => m.trigger === 'message' && String(m.agentId) === '0'), toPrimary2.length)
  const toOther2 = await waitForEvents(c2, 0, '1')
  ok('…and that 0-targeted steer does NOT leak to agent 1', !toOther2.some((m) => m.trigger === 'message' && String(m.agentId) === '0'), toOther2.length)
}

// 17) only the primary supervisor '0' sees tick moments (a tick carries no agentId → default visibleTo branch)
snap = { ...snap, agentStatus: { 0: 'working' } } // first re-settle 0 to 'working' (error->working: not material)
emitTick()
since = latestSeq()
snap = { ...snap, agentStatus: { 0: 'waiting' } } // working -> waiting: material again
emitTick()
const seenByOther = await waitForEvents(since, 0, '1')
ok('a trigger:tick moment is NOT delivered to a non-primary agent (1) — tick is primary-only', !seenByOther.some((m) => m.trigger === 'tick'), seenByOther.length)
const seenByPrimary = await waitForEvents(since, 0, '0')
ok('…but the SAME tick IS delivered to the primary supervisor 0', seenByPrimary.some((m) => m.trigger === 'tick'), seenByPrimary.length)

console.log(failures ? `\n${failures} FAILURES` : '\nall green')
process.exit(failures ? 1 : 0)
