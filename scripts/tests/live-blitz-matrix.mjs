#!/usr/bin/env node
// live-blitz-matrix.mjs — HARNESS-MATRIX (LIVE). Makes REAL claude/codex spawns.
//
// Drives the blitzscript llm() chokepoint across the real harness matrix on THIS machine:
//   - 7 SUCCESS combos (claude x4, codex x3): a tiny deterministic prompt whose only correct answer
//     is 391, asserting the returned text contains "391".
//   - 3 FAIL-LOUD cases: llm() MUST THROW rather than silently return a wrong answer —
//       (a) claude model 'fable'        -> a real spawn that the CLI rejects (404-ish) -> throw
//       (b) claude effort 'ultra'       -> build() validation throws BEFORE any spawn (0 real calls, fast)
//       (c) codex model 'nope-not-real-xyz' -> a real spawn the CLI rejects -> throw
//
// HARD CAP: <= 12 real LLM spawns. Success(7) + the two failing-but-real spawns (fable, nope) = 9.
// The 'ultra' case spawns NOTHING (it throws in harness.build() before llm() reaches _spawn), and we
// assert BOTH: llm()'s internal call counter is unchanged across it AND it returns in <500ms.
//
// We count REAL spawns via the lib's own _stats().calls counter (incremented inside llm() at the
// point of no return, AFTER build()-validation but for every path that proceeds to spawn / would
// have). These are deliberately REAL CLI invocations — the spawner below shells out to the actual
// claude/codex binaries (it does NOT stub anything). We install it via the lib's documented _spawn
// override ONLY to enrich a failed spawn's error with the child's STDOUT: the default lib spawner
// appends only STDERR, but codex reports an inaccessible-model 400 as a JSONL `{"type":"error"}`
// event on STDOUT, so without this the thrown error is the uninformative "codex exited 1". Capturing
// stdout lets the test (and, this surfaces, any real caller would want the same) name the real reason.

import { llm, _stats, _setSpawn } from '/Users/minjunes/superapp/teenybase/agent-os/src/main/blitzscript/llm.mjs'
import { spawn } from 'node:child_process'

// REAL spawner, identical semantics to the lib's _defaultSpawn (stdio ignore/pipe/pipe so codex does
// not swallow our stdin), EXCEPT the rejection message also carries the tail of STDOUT.
_setSpawn((cmd, args, env) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  child.on('error', (e) => reject(new Error(`blitz llm: failed to spawn ${cmd}: ${e.message}`)))
  child.on('close', (code) => {
    if (code === 0) return resolve(out)
    const extra = [err.trim(), out.trim()].filter(Boolean).join('\n')
    reject(new Error(`blitz llm: ${cmd} exited ${code}${extra ? `\n${extra}` : ''}`))
  })
}))

const PROMPT = 'What is 17*23? Reply with ONLY the number.'
const EXPECT = '391'

const cases = []
const record = (name, ok, detail) => { cases.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ::  ${detail}`) }

// Shared one-shot retry budget for SUCCESS combos only. A real frontier model very occasionally
// over-thinks the bare "17*23" prompt and emits a stray token on a single spawn (observed: a lone
// "34"); that is model nondeterminism, NOT a harness defect, so we allow ONE re-spawn. Capped GLOBAL
// so a string of flakes can never blow the 12-call budget (success=7 + fail-spawns=2 leaves 3 to spare).
let retryBudget = 2

// The account genuinely lacks the model (vs a real bug): the CLI says so explicitly. We treat these
// as ok:false WITH THE REAL REASON and keep going (spec: don't abort the category).
function inaccessibleReason(msg) {
  const m = String(msg)
  if (/not supported when using .* with a ChatGPT account/i.test(m)) return 'model not supported on this ChatGPT-plan codex account'
  if (/\b404\b/.test(m) || /not.{0,3}found/i.test(m)) return 'model not found / not on this account (404-ish)'
  if (/unauthorized|forbidden|access|entitle|permission denied/i.test(m)) return 'account not entitled to this model'
  return null
}

// Each success combo: spawn for real, assert the answer text contains EXPECT. A model the account
// cannot access throws -> we record ok:false WITH THE REAL ERROR (and the parsed reason), but do NOT
// abort the category (per spec). 60s+ per call is normal for a cold agent process.
async function expectAnswer(name, opts) {
  const before = _stats().calls
  let res, err
  try { res = await llm(PROMPT, opts) } catch (e) { err = e }
  // One re-spawn on a wrong-but-non-throwing answer (model nondeterminism), if budget remains.
  if (!err && !String(res ?? '').includes(EXPECT) && retryBudget > 0) {
    retryBudget--
    const first = String(res ?? '')
    try { res = await llm(PROMPT, opts) } catch (e) { err = e }
    if (!err) {
      const text = String(res ?? '')
      const ok = text.includes(EXPECT)
      const spawned = _stats().calls - before
      record(name, ok, `${ok ? 'got' : `expected to contain ${EXPECT}, got`} ${JSON.stringify(trunc(text))} (after 1 retry; first spawn returned ${JSON.stringify(trunc(first))}) [realSpawns+=${spawned}]`)
      return
    }
  }
  const spawned = _stats().calls - before
  if (err) {
    const reason = inaccessibleReason(err.message)
    record(name, false, `llm() threw -> ${reason ? `INACCESSIBLE: ${reason}` : 'unexpected error'}: ${oneLine(err.message)} [realSpawns+=${spawned}]`)
    return
  }
  const text = String(res ?? '')
  const ok = text.includes(EXPECT)
  record(name, ok, `${ok ? 'got' : `expected to contain ${EXPECT}, got`} ${JSON.stringify(trunc(text))} [realSpawns+=${spawned}]`)
}

// FAIL-LOUD success-would-be-a-bug: llm() MUST throw. Records ok=true ONLY if it threw.
async function expectThrow(name, opts, { mustBeFast = false } = {}) {
  const before = _stats().calls
  const t0 = Date.now()
  let res, err
  try { res = await llm(PROMPT, opts) } catch (e) { err = e }
  const ms = Date.now() - t0
  const spawned = _stats().calls - before
  if (!err) {
    record(name, false, `expected llm() to THROW but it returned ${JSON.stringify(trunc(String(res)))} [realSpawns+=${spawned}]`)
    return
  }
  if (mustBeFast) {
    // The pre-spawn build()-validation path: no spawn must have happened and it must be ~instant.
    const fast = ms < 500
    const noSpawn = spawned === 0
    const ok = fast && noSpawn
    record(name, ok,
      `threw=${ok ? 'as expected ' : ''}${JSON.stringify(oneLine(err.message))}; ` +
      `noSpawn=${noSpawn} (realSpawns+=${spawned}, want 0), fast=${fast} (${ms}ms, want <500ms)`)
    return
  }
  record(name, true, `threw as expected: ${JSON.stringify(oneLine(err.message))} [realSpawns+=${spawned}]`)
}

const trunc = (s, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s)
const oneLine = (s) => trunc(String(s).replace(/\s+/g, ' ').trim(), 200)

async function main() {
  const startCalls = _stats().calls

  // ── FAIL-LOUD 'ultra' FIRST: it must be free + fast (0 real spawns). Doing it first also keeps the
  //    real-spawn budget unambiguous regardless of later access failures. ───────────────────────────
  await expectThrow("claude effort 'ultra' throws in build() (no spawn, fast)", { effort: 'ultra' }, { mustBeFast: true })

  // ── claude SUCCESS combos ───────────────────────────────────────────────────────────────────────
  await expectAnswer("claude model 'haiku'", { model: 'haiku' })
  await expectAnswer("claude model 'sonnet' effort 'low'", { model: 'sonnet', effort: 'low' })
  await expectAnswer("claude model 'haiku' effort 'high'", { model: 'haiku', effort: 'high' })
  await expectAnswer('claude DEFAULT (no model/effort)', {})

  // ── codex SUCCESS combos ────────────────────────────────────────────────────────────────────────
  await expectAnswer('codex DEFAULT (no model/effort)', { harness: 'codex' })
  await expectAnswer("codex model 'gpt-5.3-codex-spark' effort 'low'", { harness: 'codex', model: 'gpt-5.3-codex-spark', effort: 'low' })
  await expectAnswer("codex model 'gpt-5.3-codex' effort 'medium'", { harness: 'codex', model: 'gpt-5.3-codex', effort: 'medium' })

  // ── remaining FAIL-LOUD cases (real spawns the CLI rejects) ─────────────────────────────────────
  await expectThrow("claude model 'fable' throws (404-ish)", { model: 'fable' })
  await expectThrow("codex model 'nope-not-real-xyz' throws", { harness: 'codex', model: 'nope-not-real-xyz' })

  const realCalls = _stats().calls - startCalls
  const pass = cases.every((c) => c.ok)
  const underCap = realCalls <= 12
  console.log(`\nrealLlmCalls=${realCalls} (cap 12, underCap=${underCap})  pass=${pass && underCap}`)
  // Emit a machine-readable summary line the parent can grep.
  console.log('RESULT_JSON ' + JSON.stringify({ pass: pass && underCap, realLlmCalls: realCalls, underCap, cases }))
  process.exit(pass && underCap ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
