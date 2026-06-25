// test-wf-events.mjs — the externalization WfEvent schema the runtime emits (Phase A.1).
// Runs a small Claude-shaped workflow in-process with a STUBBED leaf spawner and asserts the event stream
// (run:start -> phase -> group:start -> agent:start*N -> agent:done*N -> group:done -> phase -> ... -> run:done).
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorkflow, setProgressSink } from '../../src/main/blitzscript/runtime.mjs'
import { _setSpawn, _resetJournal } from '../../src/main/blitzscript/agent.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

// Stub the leaf spawner: a claude-shaped JSON stdout (harness.parse reads .result; usage sums the tokens).
_setSpawn(async () => JSON.stringify({ result: 'R', usage: { input_tokens: 3, output_tokens: 5 } }))
_resetJournal()

const dir = mkdtempSync(join(tmpdir(), 'wf-events-'))
const wf = join(dir, 'ev.js')
writeFileSync(wf, [
  "export const meta = { name: 'ev-test', description: 'event schema' }",
  "phase('gather')",
  "const a = await parallel([",
  "  () => agent('one', { label: 'a' }),",
  "  () => agent('two', { label: 'b' }),",
  "])",
  "phase('reduce')",
  "const r = await agent('combine', { label: 'r' })",
  "return { a, r }",
].join('\n'))

const events = []
setProgressSink((ev) => events.push(ev))
const RUN = 'run-123'
const { result } = await runWorkflow(wf, { memDir: join(dir, 'mem'), runId: RUN })
setProgressSink(null)

console.log('events:', JSON.stringify(events.map((e) => e.type)))

ok(events.length > 0, 'events were emitted')
ok(events[0].type === 'run:start', 'first event is run:start')
ok(events[events.length - 1].type === 'run:done', 'last event is run:done')
ok(events.every((e) => e.runId === RUN), 'every event is stamped with the runId')

const starts = events.filter((e) => e.type === 'agent:start')
const dones = events.filter((e) => e.type === 'agent:done')
ok(starts.length === 3, 'three agent:start (got ' + starts.length + ')')
ok(dones.length === 3, 'three agent:done (got ' + dones.length + ')')
ok(new Set(starts.map((e) => e.nodeId)).size === 3, 'three distinct nodeIds')
ok(starts.every((e) => e.harness === 'claude'), 'agent:start carries the harness')
ok(dones.every((e) => e.status === 'ok'), 'all agent:done are ok')
ok(dones.every((e) => typeof e.tokens === 'number'), 'agent:done carries a numeric tokens field')
ok(dones.some((e) => e.tokens > 0), 'at least one agent:done parsed real token usage')
ok(dones.every((e) => typeof e.ms === 'number'), 'agent:done carries a duration')
ok(dones.some((e) => typeof e.preview === 'string' && e.preview.length > 0), 'agent:done carries a preview')

const gstart = events.find((e) => e.type === 'group:start')
const gdone = events.find((e) => e.type === 'group:done')
ok(gstart && gstart.kind === 'parallel' && gstart.size === 2, 'group:start parallel size 2')
ok(gstart && gstart.phaseId === 'gather', 'group:start carries its phase')
ok(gdone && gdone.ok === 2 && gdone.failed === 0, 'group:done ok 2 failed 0')

const phases = events.filter((e) => e.type === 'phase').map((e) => e.title)
ok(phases.length === 2 && phases[0] === 'gather' && phases[1] === 'reduce', 'two phases in order')

const g0starts = starts.filter((e) => e.groupId === gstart.groupId)
ok(g0starts.length === 2, 'two agent:start in the parallel group')
const reduceStart = starts.find((e) => e.phaseId === 'reduce')
ok(reduceStart && reduceStart.groupId == null, 'the reduce agent is ungrouped (groupId null)')

const rd = events.find((e) => e.type === 'run:done')
ok(rd && rd.ok === true, 'run:done ok')
ok(rd && rd.calls === 3, 'run:done reports 3 calls')
ok(result && result.r === 'R', 'workflow returned the leaf result')

// ── error path: a throwing leaf -> agent:done status error + a group failed count ──
_setSpawn(async () => { throw new Error('boom') })
const events2 = []
setProgressSink((ev) => events2.push(ev))
const wf2 = join(dir, 'ev2.js')
writeFileSync(wf2, [
  "export const meta = { name: 'ev2' }",
  "const a = await parallel([() => agent('x', { label: 'x' })])",
  "return a",
].join('\n'))
await runWorkflow(wf2, { memDir: join(dir, 'mem2'), runId: 'run-err' })
setProgressSink(null)
const d2 = events2.find((e) => e.type === 'agent:done')
ok(d2 && d2.status === 'error', 'a throwing leaf emits agent:done status error')
ok(d2 && typeof d2.message === 'string' && d2.message.includes('boom'), 'the error message rides the done event')
const gd2 = events2.find((e) => e.type === 'group:done')
ok(gd2 && gd2.failed === 1, 'group:done counts the failed slot')

console.log(fail === 0 ? '\nPASS — wf events' : '\nFAIL — wf events (' + fail + ' failed)')
process.exit(fail === 0 ? 0 : 1)
