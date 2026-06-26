// test-wf-wake.mjs — the completion-WAKE contract (bugs 2 + 3), with the REAL host + perception kernel.
//
// Locks the fix for the friction-report bug where a finished run pushed NOTHING into the /events wake channel,
// so the agent had to hand-roll a 16-minute result.json poll that raced whichever instant it sampled. The fix
// wires workflow-host's settle seam (next to persistEvents) -> onRunComplete -> emitWorkflowMoment, a
// trigger:'workflow' moment that wakes the launching agent exactly like a chat message. result.json is on disk
// before the wake (the runtime writes it before runWorkflow resolves). No claude, no network (stubbed spawn).
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireWorkflowHost, runWorkflowHosted } from '../../src/main/workflow-host.mjs'
import { _setSpawn, _resetJournal } from '../../src/main/blitzscript/agent.mjs'
import { emitWorkflowMoment, waitForEvents } from '../../src/main/perception-core.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

process.env.BLITZ_CAPTURE_LEAVES = '1'
_setSpawn(async () => JSON.stringify({ result: 'done', session_id: 's', usage: { input_tokens: 1, output_tokens: 1 } }))
_resetJournal()

const ws = mkdtempSync(join(tmpdir(), 'wf-wake-ws-'))
// Mirror index.ts: turn the host's onRunComplete into an agent-private 'workflow' moment.
wireWorkflowHost({
  getWorkspacePath: () => ws,
  broadcast: () => {},
  onRunComplete: ({ runId, agentId, ok: runOk, memDir }) =>
    emitWorkflowMoment(String(runId), String(agentId ?? '0'), { ok: runOk !== false, resultPath: memDir ? join(memDir, 'result.json') : '' }),
})

const wf = join(ws, 'demo.js')
writeFileSync(wf, "export const meta = { name: 'demo', description: 'wake' }\nphase('work')\nconst a = await agent('plain', { label: 'p' })\nreturn { a }")

// 1. A run launched by '0' wakes a '0' waiter with a trigger:'workflow' moment whose resultPath EXISTS.
await runWorkflowHosted({ file: wf, runId: 'wfwake0', agentId: '0' })
const got0 = await waitForEvents(0, 5000, '0')
const m0 = got0.find((m) => m.trigger === 'workflow')
ok(!!m0, "a finished run emits a trigger:'workflow' moment that wakes the launching agent (no poll)")
ok(m0 && m0.workflow && m0.workflow.runId === 'wfwake0', 'the moment carries the runId')
ok(m0 && m0.workflow && existsSync(m0.workflow.resultPath), 'resultPath points at a result.json already ON DISK at wake time (no race)')
const since0 = m0 ? m0.seq : 0

// 2. Agent-PRIVATE: a run launched by '7' wakes ONLY '7', never the primary '0'.
await runWorkflowHosted({ file: wf, runId: 'wfwake7', agentId: '7' })
const got7 = await waitForEvents(since0, 5000, '7')
const m7 = got7.find((m) => m.trigger === 'workflow' && m.workflow && m.workflow.runId === 'wfwake7')
ok(!!m7, "agent '7' is woken for its OWN run")
const leak = (await waitForEvents(since0, 0, '0')).find((m) => m.trigger === 'workflow' && m.workflow && m.workflow.runId === 'wfwake7')
ok(!leak, "the '7' run does NOT wake the primary '0' (agent-private, like a chat message)")

console.log(fail === 0 ? '\nPASS — wf completion wake (pushed on run:done, private, result.json on disk first)' : `\nFAIL — wf wake (${fail})`)
process.exit(fail === 0 ? 0 : 1)
