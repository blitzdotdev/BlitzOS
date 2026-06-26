// test-wf-run-state.mjs — the shared `workflow-run` upsert rule (applyWfRun), the ONE place main (osNoteWfRun)
// and the renderer (NotchHost) agree on. Pins the regression behind the "second started" bug: a fast workflow
// broadcasts started([]), done, then started(skeleton) (the parallel dry preflight resolving last). The late,
// skeleton-bearing `started` must UPSERT the skeleton WITHOUT un-finishing the already-done run.
import { applyWfRun } from '../../src/main/wf-run-state.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

// 1. `started` for a NEW run → created, not finished.
const a = applyWfRun(undefined, { type: 'workflow-run', runId: 'r1', agentId: '2', file: '/w/x.js', started: true, skeleton: [], memDir: '/m/r1' }, 1000)
ok(a && a.runId === 'r1' && a.agentId === '2', 'started (new) creates the run with id + agent')
ok(a.done === false && a.ok === false, 'started (new) is not done')
ok(a.startedAt === 1000 && a.memDir === '/m/r1' && a.file === '/w/x.js', 'started (new) carries startedAt/memDir/file')
ok(Array.isArray(a.skeleton) && a.skeleton.length === 0, 'started (new) with empty skeleton → []')
ok(a.stats === null, 'started (new) initializes stats to null')

// 2. `done` marks the run finished + carries the final stats (so a COLLAPSED pill shows them, no board mount).
const b = applyWfRun(a, { type: 'workflow-run', runId: 'r1', done: true, ok: true, stats: { ms: 1200, calls: 4, tokens: 800 } }, 2000)
ok(b.done === true && b.ok === true, 'done marks done + ok')
ok(b.startedAt === 1000, 'done preserves startedAt')
ok(b.stats && b.stats.ms === 1200 && b.stats.calls === 4 && b.stats.tokens === 800, 'done carries the final stats onto the record')

// 3. THE REGRESSION — a late `started` carrying the real skeleton arrives AFTER done (fast-run order):
//    it must adopt the skeleton but leave the run FINISHED (never flip done back to false) AND keep the stats.
const skel = [{ type: 'agent:start', nodeId: 0 }, { type: 'agent:start', nodeId: 1 }]
const c = applyWfRun(b, { type: 'workflow-run', runId: 'r1', started: true, skeleton: skel, memDir: '/m/r1' }, 3000)
ok(c.done === true, 'late started after done does NOT un-finish the run (the core regression)')
ok(c.ok === true, 'late started preserves ok')
ok(c.skeleton.length === 2, 'late started UPSERTS the real skeleton (board gets its TODO cards)')
ok(c.startedAt === 1000, 'late started preserves the original startedAt')
ok(c.stats && c.stats.calls === 4, 'late started preserves the stats set on done')

// 4. Common slow-run order — started([]) then started(skeleton) while still running: skeleton updates, stays running.
const d0 = applyWfRun(undefined, { type: 'workflow-run', runId: 'r2', started: true, skeleton: [] }, 1000)
const d1 = applyWfRun(d0, { type: 'workflow-run', runId: 'r2', started: true, skeleton: skel }, 1100)
ok(d1.done === false && d1.skeleton.length === 2, 'second started while running adopts the skeleton, stays running')

// 5. An empty skeleton on a later `started` must NOT clobber an already-present non-empty skeleton.
const e = applyWfRun(d1, { type: 'workflow-run', runId: 'r2', started: true, skeleton: [] }, 1200)
ok(e.skeleton.length === 2, 'empty skeleton does not clobber a non-empty one')

// 6. Irrelevant / id-less actions are no-ops.
ok(applyWfRun(undefined, { type: 'workflow-run' }) === null, 'no runId → null')
ok(applyWfRun(undefined, { type: 'workflow-run', runId: 'r3', done: true }) === null, 'done with no prior run → null (no phantom run)')
ok(applyWfRun(b, { type: 'workflow-run', runId: 'r1' }) === b, 'neither started nor done → previous record unchanged')

console.log(fail === 0 ? '\nPASS — wf-run-state (applyWfRun upsert rule)' : `\nFAIL — wf-run-state (${fail})`)
process.exit(fail === 0 ? 0 : 1)
