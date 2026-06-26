// test-wf-leaf-failure.mjs — the leaf FAILURE contract (bugs 1 + 6), with the REAL runtime + a stubbed spawn.
//
// Locks the fix for the friction-report bug where a schema leaf on an inaccessible model (a 404 / non-zero
// claude exit) was laundered into status:'null'/result:null — indistinguishable from a model that RAN but
// could not emit schema-valid JSON. The fix (agent.mjs exec) rethrows a spawn/infra failure (no .schemaErrors)
// while still soft-nulling a genuine schema MISS, and the runtime always writes a typed result.json even when
// the body throws. Also covers the self-describing `resultKind` discriminator (bug 6).
//
// No claude, no network — _setSpawn injects the child stdout (or a reject) so each terminal state is forced.
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorkflow } from '../../src/main/blitzscript/runtime.mjs'
import { _setSpawn, _resetJournal } from '../../src/main/blitzscript/agent.mjs'

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m) } else { fail++; console.log('  ✗ ' + m) } }

process.env.BLITZ_CAPTURE_LEAVES = '1'

const tmp = mkdtempSync(join(tmpdir(), 'wf-leaf-fail-'))
const writeWf = (name, src) => { const p = join(tmp, name + '.js'); writeFileSync(p, src); return p }
const leafOf = (memDir, n) => JSON.parse(readFileSync(join(memDir, 'leaves', n + '.json'), 'utf8'))
const resultOf = (memDir) => JSON.parse(readFileSync(join(memDir, 'result.json'), 'utf8'))

const SCHEMA = "{ type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] }"

// ── A. INFRA FAILURE (a non-zero claude exit / 404) on a STANDALONE schema leaf -> FAIL LOUD ──────────
//    The spawn REJECTS (like _defaultSpawn on a non-zero exit). agent() must rethrow (no .schemaErrors), the
//    body throws, and the runtime must STILL leave a typed crash result.json. Was: status:'null', silent success.
{
  _resetJournal()
  _setSpawn(async () => { throw new Error('blitz agent: claude exited 1\n{"is_error":true,"api_error_status":404,"result":"model not available"}') })
  const memDir = join(tmp, 'A');
  const wf = writeWf('A', `export const meta = { name: 'A', description: 'infra fail' }\nconst out = await agent('x', { label: 'infra', schema: ${SCHEMA} })\nreturn { out }`)
  let threw = false
  try { await runWorkflow(wf, { memDir }) } catch { threw = true }
  ok(threw, 'A: a standalone schema leaf on an infra failure THROWS the run (loud, not a silent null)')
  const l0 = existsSync(join(memDir, 'leaves', '0.json')) ? leafOf(memDir, 0) : null
  ok(l0 && l0.status === 'error', 'A: leaf captured status:"error" (was the swallowed "null")')
  ok(l0 && l0.resultKind === 'error', 'A: leaf resultKind:"error"')
  ok(l0 && typeof l0.error === 'string' && l0.error.includes('404'), 'A: the real 404 reason is on the leaf, not discarded')
  const rj = existsSync(join(memDir, 'result.json')) ? resultOf(memDir) : null
  ok(rj && rj.ok === false && rj.resultKind === 'error', 'A: the runtime STILL wrote a typed crash result.json {ok:false,resultKind:"error"}')
  ok(rj && rj.result === null && typeof rj.error === 'string', 'A: crash result.json carries result:null + the error (no dangling/empty artifact)')
}

// ── B. SCHEMA MISS (a VALID model that ran but emitted schema-invalid JSON) -> SOFT-NULL PRESERVED ────
//    The spawn RETURNS well-formed claude json whose structured_output FAILS the author schema. This is the
//    by-design soft-null and MUST be kept (gated on lastErr.schemaErrors). tokens>0 marks "it ran".
{
  _resetJournal()
  _setSpawn(async () => JSON.stringify({
    result: 'here is my answer',
    structured_output: { meta: { human_summary: 'tried' }, output: { notChoice: 'oops' } }, // missing required `choice`
    session_id: 'sess-b', usage: { input_tokens: 9, output_tokens: 7 }
  }))
  const memDir = join(tmp, 'B')
  const wf = writeWf('B', `export const meta = { name: 'B', description: 'schema miss' }\nconst out = await agent('x', { label: 'miss', schema: ${SCHEMA} })\nreturn { out }`)
  let res, threw = false
  try { res = await runWorkflow(wf, { memDir }) } catch { threw = true }
  ok(!threw, 'B: a genuine schema MISS does NOT throw (the soft-null contract is preserved)')
  ok(res && res.result && res.result.out === null, 'B: agent() returned null for the stubborn-but-valid model')
  const l0 = leafOf(memDir, 0)
  ok(l0.status === 'null' && l0.resultKind === 'null', 'B: leaf status:"null", resultKind:"null" (a MISS, not an error)')
  ok(l0.tokens > 0, 'B: tokens>0 marks the leaf actually RAN (the tell vs an infra non-run)')
}

// ── C. TEXT leaf that emits a JSON STRING -> resultKind:"text" + a pre-parsed resultJson sidecar (bug 6) ──
{
  _resetJournal()
  _setSpawn(async () => JSON.stringify({ result: '{"a":1,"b":2}', session_id: 'sess-c', usage: { input_tokens: 3, output_tokens: 4 } }))
  const memDir = join(tmp, 'C')
  const wf = writeWf('C', `export const meta = { name: 'C', description: 'text json string' }\nconst out = await agent('x', { label: 'text' })\nreturn { out }`)
  await runWorkflow(wf, { memDir })
  const l0 = leafOf(memDir, 0)
  ok(l0.resultKind === 'text', 'C: a text leaf is tagged resultKind:"text"')
  ok(l0.result === '{"a":1,"b":2}', 'C: result is the raw string (unchanged)')
  ok(l0.resultJson && l0.resultJson.a === 1 && l0.resultJson.b === 2, 'C: resultJson carries the pre-parsed object (no second JSON.parse for the reader)')
}

console.log(fail === 0 ? '\nPASS — wf leaf failure contract (loud infra-fail + preserved soft-null + typed kinds)' : `\nFAIL — wf leaf failure (${fail})`)
process.exit(fail === 0 ? 0 : 1)
