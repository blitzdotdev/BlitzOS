// test-workflow-host.mjs — Phase A.2: the in-process host + the per-run event bus.
// Stubs the leaf spawner, runs a workflow via runWorkflowHosted, and asserts WfEvents stream through the bus
// to a subscriber, the run writes result.json, and a LATE subscriber is replayed the full backlog.
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireWorkflowHost, runWorkflowHosted } from '../../src/main/workflow-host.mjs'
import { subscribe } from '../../src/main/workflow-bus.mjs'
import { _setSpawn, _resetJournal } from '../../src/main/blitzscript/agent.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

_setSpawn(async () => JSON.stringify({ result: 'R', usage: { input_tokens: 2, output_tokens: 3 } }))
_resetJournal()

const ws = mkdtempSync(join(tmpdir(), 'wf-host-ws-'))
wireWorkflowHost({ getWorkspacePath: () => ws })

const wf = join(ws, 'demo.js')
writeFileSync(wf, [
  "export const meta = { name: 'demo', description: 'host test' }",
  "phase('work')",
  "const r = await parallel([() => agent('a', { label: 'a' }), () => agent('b', { label: 'b' })])",
  "return { n: r.length }",
].join('\n'))

const RUN = 'hosttest1'
const events = []
let resolveDone
const done = new Promise((res) => { resolveDone = res })
// subscribe BEFORE the run starts — proves live streaming (not just replay).
subscribe(RUN, (ev) => { events.push(ev); if (ev.type === 'run:done') resolveDone() })

const start = await runWorkflowHosted({ file: wf, runId: RUN, surfaceId: 'srf1', view: 'graph', agentId: '0' })
ok(start.ok === true, 'runWorkflowHosted returns ok immediately (does not block on the run)')
ok(start.runId === RUN, 'returns the runId')
ok(start.surfaceId === 'srf1', 'passes the surfaceId through')

await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))])

console.log('events:', JSON.stringify(events.map((e) => e.type)))
ok(events.length > 0, 'events streamed through the bus to the subscriber')
ok(events.every((e) => e.runId === RUN), 'every bus event carries the runId')
ok(events.every((e) => typeof e.seq === 'number' && typeof e.ts === 'number'), 'bus stamped seq + ts on every event')
ok(events.some((e) => e.type === 'run:start'), 'run:start streamed')
ok(events.filter((e) => e.type === 'agent:start').length === 2, 'two agent:start streamed')
ok(events.some((e) => e.type === 'run:done' && e.ok === true), 'run:done ok streamed')
let inc = true; for (let i = 1; i < events.length; i++) if (events[i].seq <= events[i - 1].seq) inc = false
ok(inc, 'bus seq strictly increasing (ordered)')

const resultPath = join(ws, '.blitzos', 'workflows', RUN, 'result.json')
ok(existsSync(resultPath), 'result.json written to the run memDir')
if (existsSync(resultPath)) { const j = JSON.parse(readFileSync(resultPath, 'utf8')); ok(j.result && j.result.n === 2, 'result.json holds the workflow return value') }

const replay = []
subscribe(RUN, (ev) => replay.push(ev))
ok(replay.length === events.length, 'a LATE subscriber is replayed the full backlog (event-sourced)')

console.log(fail === 0 ? '\nPASS — workflow host + bus' : '\nFAIL — workflow host + bus (' + fail + ')')
process.exit(fail === 0 ? 0 : 1)
