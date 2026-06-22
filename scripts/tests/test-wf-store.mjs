// test-wf-store.mjs — the durable, event-sourced storage for the in-chat workflow kanban boards.
// Pins: index read/write/merge + cap, events.jsonl round-trip (the replay source) + corrupt-line tolerance,
// skeleton round-trip, and listAgentRuns (filter by agent, most-recent-first, skeleton-loaded, LIST_CAP).
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  workflowsDirOf, readIndex, writeIndexEntry, writeEventsLog, readEventsLog, writeSkeleton, readSkeleton, listAgentRuns, reconcileOrphanRuns
} from '../../src/main/wf-store.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const root = mkdtempSync(join(tmpdir(), 'wfstore-'))
const wfDir = join(root, '.blitzos', 'workflows') // the workflows dir (sibling of every <runId>/ + index.json)
const memOf = (id) => join(wfDir, id)

// 1. workflowsDirOf: a run memDir's parent IS the workflows dir (where index.json lives).
ok(workflowsDirOf(memOf('wf_a')) === wfDir, 'workflowsDirOf(memDir) === the workflows dir')
ok(workflowsDirOf(null) === null, 'workflowsDirOf(null) === null')

// 2. Missing index → {} (degrade, never throw).
ok(eq(readIndex(wfDir), {}), 'missing index.json reads as {}')

// 3. writeIndexEntry round-trip + MERGE (started then done updates the SAME entry, not a duplicate).
writeIndexEntry(wfDir, 'wf_a', { agentId: '2', file: '/w/a.js', startedAt: 100, done: false, ok: false, memDir: memOf('wf_a') })
let idx = readIndex(wfDir)
ok(idx.wf_a && idx.wf_a.agentId === '2' && idx.wf_a.done === false, 'started entry persisted')
writeIndexEntry(wfDir, 'wf_a', { done: true, ok: true }) // the `done` transition patches the same row
idx = readIndex(wfDir)
ok(Object.keys(idx).length === 1, 'done MERGES the same entry (no duplicate row)')
ok(idx.wf_a.done === true && idx.wf_a.ok === true && idx.wf_a.startedAt === 100 && idx.wf_a.agentId === '2', 'done preserves started fields + flips done/ok')

// 4. Corrupt index.json → {} (degrade), and a subsequent write recovers it.
writeFileSync(join(wfDir, 'index.json'), '{ this is not json')
ok(eq(readIndex(wfDir), {}), 'corrupt index.json reads as {} (no throw)')
writeIndexEntry(wfDir, 'wf_a', { agentId: '2', file: '/w/a.js', startedAt: 100, done: true, ok: true, memDir: memOf('wf_a') })
ok(readIndex(wfDir).wf_a?.done === true, 'a write after corruption recovers the index')

// 5. events.jsonl round-trip — THE board replay source. Must come back byte-identical (so the pure reducer
//    yields an identical frozen board), with stamped seq/ts preserved.
const events = [
  { seq: 0, ts: 1, type: 'run:start', runId: 'wf_a', name: 'demo' },
  { seq: 1, ts: 2, type: 'phase', phaseId: 'Scan' },
  { seq: 2, ts: 3, type: 'agent:start', nodeId: '0', label: 'reader', phaseId: 'Scan' },
  { seq: 3, ts: 4, type: 'agent:done', nodeId: '0', status: 'ok', ms: 50, tokens: 10, preview: 'hi' },
  { seq: 4, ts: 5, type: 'run:done', ok: true, ms: 60, calls: 1, tokens: 10, preview: 'done' }
]
writeEventsLog(memOf('wf_a'), events)
ok(eq(readEventsLog(memOf('wf_a')), events), 'events.jsonl round-trips byte-identical (seq/ts preserved)')

// 6. events.jsonl tolerates a torn/partial line (e.g. a crash mid-write) — skips it, keeps the rest.
const p = join(memOf('wf_a'), 'events.jsonl')
writeFileSync(p, readFileSync(p, 'utf8') + '{ "seq": 5, "type": "phase"\n') // append a broken line
ok(readEventsLog(memOf('wf_a')).length === events.length, 'a corrupt trailing line is skipped, the rest survive')
ok(eq(readEventsLog(null), []), 'readEventsLog(null) === []')
ok(eq(readEventsLog(memOf('nope')), []), 'missing events.jsonl === []')

// 7. skeleton round-trip.
const skel = [{ type: 'agent:start', nodeId: '0' }, { type: 'agent:start', nodeId: '1' }]
writeSkeleton(memOf('wf_a'), skel)
ok(eq(readSkeleton(memOf('wf_a')), skel), 'skeleton.json round-trips')
ok(eq(readSkeleton(memOf('nope')), []), 'missing skeleton === []')

// 8. listAgentRuns — filter by agent, most-recent-first, skeleton loaded per row.
writeIndexEntry(wfDir, 'wf_b', { agentId: '2', file: '/w/b.js', startedAt: 200, done: true, ok: true, memDir: memOf('wf_b'), stats: { ms: 1200, calls: 4, tokens: 800 } })
writeIndexEntry(wfDir, 'wf_c', { agentId: '9', file: '/w/c.js', startedAt: 300, done: true, ok: true, memDir: memOf('wf_c') })
writeSkeleton(memOf('wf_b'), skel)
const a2 = listAgentRuns(wfDir, '2')
ok(a2.length === 2, 'listAgentRuns filters by agentId (2 runs for agent 2, the agent-9 run excluded)')
ok(a2[0].runId === 'wf_b' && a2[1].runId === 'wf_a', 'listAgentRuns is most-recent-first (startedAt desc)')
ok(eq(a2[0].skeleton, skel), 'listAgentRuns loads each row’s skeleton.json')
ok(a2.find((r) => r.runId === 'wf_a').done === true, 'listAgentRuns carries done/ok')
ok(eq(a2[0].stats, { ms: 1200, calls: 4, tokens: 800 }), 'listAgentRuns round-trips the stored stats (collapsed pill, no mount)')
ok(a2[1].stats === null, 'a run with no stored stats → stats null')

// 9. LIST_CAP — an agent with >30 runs returns only the 30 most-recent (older stay on disk).
const big = mkdtempSync(join(tmpdir(), 'wfstore-cap-'))
const bigDir = join(big, 'workflows')
for (let i = 0; i < 35; i++) writeIndexEntry(bigDir, 'r' + i, { agentId: '0', file: '/w/x.js', startedAt: i, done: true, ok: true, memDir: join(bigDir, 'r' + i) })
const capped = listAgentRuns(bigDir, '0')
ok(capped.length === 30, 'listAgentRuns caps at 30 most-recent')
ok(capped[0].runId === 'r34' && capped[29].runId === 'r5', 'the cap keeps the newest 30 (r34..r5)')

// 10. INDEX_CAP — index.json itself is pruned to the 200 most-recent so it can't grow unbounded.
const cap2 = mkdtempSync(join(tmpdir(), 'wfstore-idxcap-'))
const cap2Dir = join(cap2, 'workflows')
for (let i = 0; i < 210; i++) writeIndexEntry(cap2Dir, 'r' + i, { agentId: '0', file: '/w/x.js', startedAt: i, done: true, ok: true, memDir: join(cap2Dir, 'r' + i) })
const idxKeys = Object.keys(readIndex(cap2Dir))
ok(idxKeys.length === 200, 'index.json prunes to 200 entries (no unbounded growth)')
ok(!idxKeys.includes('r0') && idxKeys.includes('r209'), 'the prune drops the oldest, keeps the newest')

// 11. reconcileOrphanRuns — heal phantom 'running' boards (a crash/clean-quit left a done:false entry forever).
const rec = mkdtempSync(join(tmpdir(), 'wfstore-rec-'))
const recDir = join(rec, 'workflows')
writeIndexEntry(recDir, 'orphan', { agentId: '0', file: '/w/a.js', startedAt: 1, done: false, ok: false, memDir: join(recDir, 'orphan') }) // never got `done`
writeIndexEntry(recDir, 'live', { agentId: '0', file: '/w/b.js', startedAt: 2, done: false, ok: false, memDir: join(recDir, 'live') }) // running THIS session
writeIndexEntry(recDir, 'finished', { agentId: '0', file: '/w/c.js', startedAt: 3, done: true, ok: true, memDir: join(recDir, 'finished') })
// 'settled' actually completed (events.jsonl has run:done ok:true) but its index done-write never landed (app died
// in the persist→broadcast window) — reconcile must RECOVER ok:true from the event stream, not force-fail it.
writeIndexEntry(recDir, 'settled', { agentId: '0', file: '/w/d.js', startedAt: 4, done: false, ok: false, memDir: join(recDir, 'settled') })
writeEventsLog(join(recDir, 'settled'), [{ seq: 0, ts: 1, type: 'run:start', runId: 'settled' }, { seq: 1, ts: 2, type: 'run:done', ok: true }])
const healed = reconcileOrphanRuns(recDir, (id) => id === 'live') // shield the one live run
ok(healed === 2, 'reconcile heals the orphan + the settled-but-unflagged run (2), shields the live run')
const ri = readIndex(recDir)
ok(ri.orphan.done === true && ri.orphan.ok === false, 'a genuine orphan (no events.jsonl) → done:true, ok:false ("workflow failed")')
ok(ri.settled.done === true && ri.settled.ok === true, 'a settled run (events.jsonl run:done ok:true) RECOVERS done:true, ok:true (not mislabeled failed)')
ok(ri.live.done === false, 'a live (shielded) run is NOT force-failed')
ok(ri.finished.done === true && ri.finished.ok === true, 'an already-finished run is untouched (ok stays true)')
ok(reconcileOrphanRuns(recDir, (id) => id === 'live') === 0, 'reconcile is idempotent — a second pass (same shield) heals nothing')
ok(reconcileOrphanRuns(null) === 0, 'reconcile(null dir) === 0 (no throw)')

// 12. Atomic writes leave no .tmp- litter behind (tmp+rename, not a bare write).
const litter = readdirSync(recDir).filter((f) => f.includes('.tmp-'))
ok(litter.length === 0, 'atomic writes leave no .tmp- files behind')

console.log(fail === 0 ? '\nPASS — wf-store (durable event-sourced board storage)' : `\nFAIL — wf-store (${fail})`)
process.exit(fail === 0 ? 0 : 1)
