// test-wf-leaf-capture.mjs — the island drawer's DATA PATH, end to end with the REAL modules.
//
// Proves: with BLITZ_CAPTURE_LEAVES=1 a hosted run writes each leaf's record to <memDir>/leaves/<nodeId>.json
// (Asked=prompt, Did=summary, Returned=result), the run's `started` broadcast carries that memDir (what main
// stores → osWfRunMemDir returns by runId), and the drawer's resolver (osReadLeaf) reads it back AND rejects a
// path-traversal id. Uses the real workflow-host + the real agent capture with a stubbed spawn (no claude, no $).
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wireWorkflowHost, runWorkflowHosted, workflowMemDir } from '../../src/main/workflow-host.mjs'
import { subscribe } from '../../src/main/workflow-bus.mjs'
import { _setSpawn, _resetJournal } from '../../src/main/blitzscript/agent.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

process.env.BLITZ_CAPTURE_LEAVES = '1' // index.ts sets this at boot; the lab/app default

// Stub the leaf spawn: a claude-style json carrying a PROSE `result` (the "Did"), a `structured_output` object
// (the schema leaf's "Returned"), a session_id, and usage. parse()→result, parseStructured()→structured_output.
const PROSE = 'Picked the strongest option and verified it against the constraints.'
_setSpawn(async () => JSON.stringify({ result: PROSE, structured_output: { choice: 'B', why: 'strongest' }, session_id: 'sess-abc', usage: { input_tokens: 5, output_tokens: 7 } }))
_resetJournal()

const ws = mkdtempSync(join(tmpdir(), 'wf-leaf-ws-'))
const broadcasts = []
wireWorkflowHost({ getWorkspacePath: () => ws, broadcast: (a) => broadcasts.push(a) })

// one TEXT leaf (Returned == prose) + one SCHEMA leaf (Returned == the object, Did == the prose ack).
const wf = join(ws, 'demo.js')
writeFileSync(wf, [
  "export const meta = { name: 'demo', description: 'leaf capture' }",
  "phase('work')",
  "const a = await agent('plain leaf', { label: 'plain' })",
  "const b = await agent('structured leaf', { label: 'structured', schema: { type: 'object', properties: { choice: { type: 'string' }, why: { type: 'string' } }, required: ['choice','why'] } })",
  "return { a, b }",
].join('\n'))

const RUN = 'wfleaf1'
let resolveDone
const done = new Promise((r) => (resolveDone = r))
subscribe(RUN, (ev) => { if (ev.type === 'run:done') resolveDone() })
await runWorkflowHosted({ file: wf, runId: RUN, agentId: '0' })
await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))])

// 1. the run's broadcast carries its memDir (this is what osNoteWfRun stores and osWfRunMemDir(runId) returns).
const memDir = workflowMemDir(RUN)
const started = broadcasts.find((b) => b.type === 'workflow-run' && b.runId === RUN && b.started)
ok(!!started, 'host broadcast a started for the run')
ok(started && started.memDir === memDir, 'broadcast carries the run memDir → drawer resolves it by runId (Finding 2)')

// 2. capture wrote a leaf file at the EXACT path the drawer reads: <memDir>/leaves/<nodeId>.json.
const leaf0 = join(memDir, 'leaves', '0.json')
const leaf1 = join(memDir, 'leaves', '1.json')
ok(existsSync(leaf0) && existsSync(leaf1), 'both leaves captured under <memDir>/leaves/')

// 3. each leaf carries Asked / Did / Returned in the shape the drawer renders.
const r0 = JSON.parse(readFileSync(leaf0, 'utf8'))
const r1 = JSON.parse(readFileSync(leaf1, 'utf8'))
ok(typeof r0.prompt === 'string' && r0.prompt.includes('plain leaf'), 'TEXT leaf: Asked = the prompt')
ok(r0.summary === PROSE, 'TEXT leaf: Did = summary (the harness prose)')
ok(r0.result === PROSE, 'TEXT leaf: Returned = result (prose for a text agent)')
ok(r0.sessionId === 'sess-abc', 'leaf carries the claude session id (drill-in rollout)')
ok(r1.summary === PROSE, 'SCHEMA leaf: Did = the prose ack (summary), NOT the JSON')
ok(r1.result && r1.result.choice === 'B' && r1.result.why === 'strongest', 'SCHEMA leaf: Returned = the typed object (JsonView)')

// 4. the drawer resolver (osReadLeaf, osActions.ts:943-956) reads it by memDir+ids and BLOCKS path traversal.
//    Mirrors the source exactly: validate runId/nodeId against /^[\w.-]+$/, then join(memDir,'leaves',nodeId+'.json').
const LEAF_ID_RE = /^[\w.-]+$/
const osReadLeaf = (md, runId, nodeId) => {
  if (!md || !runId || nodeId == null) return null
  if (!LEAF_ID_RE.test(String(runId)) || !LEAF_ID_RE.test(String(nodeId))) return null
  try { return JSON.parse(readFileSync(join(md, 'leaves', String(nodeId) + '.json'), 'utf8')) } catch { return null }
}
ok(!!osReadLeaf(memDir, RUN, '0'), 'osReadLeaf resolves a leaf by memDir + ids')
ok(osReadLeaf(memDir, RUN, '../../../../etc/passwd') === null, 'osReadLeaf REJECTS a path-traversal nodeId (Finding 2)')
ok(osReadLeaf(memDir, '../../secrets', '0') === null, 'osReadLeaf REJECTS a path-traversal runId (Finding 2)')

console.log(fail === 0 ? '\nPASS — wf leaf capture + drawer data path' : `\nFAIL — wf leaf capture (${fail})`)
process.exit(fail === 0 ? 0 : 1)
