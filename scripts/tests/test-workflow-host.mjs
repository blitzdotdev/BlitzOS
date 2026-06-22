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
const broadcasts = [] // capture the {type:'workflow-run',...} actions the host fans to the renderer
wireWorkflowHost({ getWorkspacePath: () => ws, broadcast: (a) => broadcasts.push(a) })

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

// Producer side of the inline-kanban broadcast (the "second started" path): the host announces started() with
// an EMPTY skeleton immediately (so the board mounts + the real run kicks off with no preflight delay), then the
// parallel dry preflight re-broadcasts started() with the real skeleton, then done(ok). Poll for the preflight
// skeleton (it resolves async). The CONSUMER half — that a late started never un-finishes a done run — is in
// test-wf-run-state.mjs (the shared applyWfRun rule both main + renderer fold through).
const has = (pred) => broadcasts.some((b) => b.type === 'workflow-run' && b.runId === RUN && pred(b))
const deadline = Date.now() + 3000
// wait for BOTH the async preflight skeleton AND the done broadcast (they settle on separate microtask chains).
while (Date.now() < deadline && !(has((b) => b.started && Array.isArray(b.skeleton) && b.skeleton.length > 0) && has((b) => b.done && b.ok === true))) {
  await new Promise((r) => setTimeout(r, 25))
}
const wfb = broadcasts.filter((b) => b.type === 'workflow-run' && b.runId === RUN)
ok(wfb.some((b) => b.started && Array.isArray(b.skeleton) && b.skeleton.length === 0), 'host broadcasts started() immediately with an EMPTY skeleton (no preflight delay)')
ok(wfb.some((b) => b.started && Array.isArray(b.skeleton) && b.skeleton.length > 0), 'host re-broadcasts started() with the preflight skeleton (the TODO cards)')
ok(wfb.some((b) => b.done && b.ok === true), 'host broadcasts done(ok) when the run settles')

// Relative-path resolution: the agent authors workflow files relative to ITS workspace cwd (e.g.
// ".blitzos/blitzscripts/x.js"), but the host runs in the main process whose cwd differs — so a relative `file`
// must be resolved against the workspace, else the runtime's readFileSync ENOENTs BEFORE any event (an empty run
// dir + a board that never fills, the exact bug seen live). A missing file must fail fast, not return ok.
const relRun = await runWorkflowHosted({ file: 'demo.js', runId: 'relpath1' })
ok(relRun.ok === true && relRun.runId === 'relpath1', 'a workspace-relative file resolves + runs (not ENOENT from main cwd)')
const missRun = await runWorkflowHosted({ file: '.blitzos/nope-not-here.js' })
ok(missRun.ok === false && /not found/.test(missRun.error || ''), 'a missing workflow file fails fast with a clear error (not silent ok:true)')

console.log(fail === 0 ? '\nPASS — workflow host + bus' : '\nFAIL — workflow host + bus (' + fail + ')')
process.exit(fail === 0 ? 0 : 1)
