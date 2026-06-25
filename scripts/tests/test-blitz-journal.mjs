// test-blitz-journal.mjs — journaling (edge-result memoization for resume) + retries (failure recovery).
//
// Zero real LLM calls: an injected stub spawner stands in for claude/codex. The resume cases run a
// fixture WORKFLOW as a real subprocess (fresh node process per "run", journal file persists between
// them) so the index/journal behave exactly as under `blitz run`. Run: `node scripts/tests/test-blitz-journal.mjs`.
import { llm, _setSpawn, _resetJournal } from '../../src/main/blitzscript/llm.mjs'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LLM = join(__dirname, '..', '..', 'src', 'main', 'blitzscript', 'llm.mjs')
delete process.env.BLITZ_MEM_DIR // in-process tests must not journal to a stray dir

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '') }
}
const readJournal = (mem) => existsSync(join(mem, 'journal.jsonl')) ? readFileSync(join(mem, 'journal.jsonl'), 'utf8') : ''

// ── A) retries: a transient failure is retried up to opts.retries; retries:0 fails loud ─────────────
console.log('retries (failure recovery):')
{
  _resetJournal()
  let attempts = 0
  _setSpawn(async () => { attempts++; if (attempts < 3) throw new Error('transient blip'); return JSON.stringify({ result: 'OK' }) })
  const r = await llm('x', { harness: 'claude', retries: 2 })
  ok('retries:2 recovers after 2 transient failures (3rd attempt succeeds)', r === 'OK' && attempts === 3, { r, attempts })

  _resetJournal(); attempts = 0
  _setSpawn(async () => { attempts++; throw new Error('always fails') })
  let threw = false
  try { await llm('y', { harness: 'claude' }) } catch { threw = true }
  ok('retries:0 (default) does NOT retry and throws (fail-loud)', threw && attempts === 1, { threw, attempts })
  _setSpawn(null)
}

// ── the resume fixture: 3 sequential llm() calls, a stub spawner that logs each spawn to SPAWN_LOG and
//    can crash/fail on demand. Env: SPAWN_LOG, CRASH_AT (process.exit on the Nth spawn), FAIL_TAG (throw
//    for that call), B_VARIANT (change call B's prompt to test divergence). \\w / \\n -> \w / \n in the file.
const FIXDIR = mkdtempSync(join(tmpdir(), 'blitz-journal-fix-'))
const FIXTURE = join(FIXDIR, 'wf.mjs')
writeFileSync(FIXTURE, `
import { llm, _setSpawn } from ${JSON.stringify(LLM)}
import { appendFileSync } from 'node:fs'
const LOG = process.env.SPAWN_LOG, CRASH_AT = Number(process.env.CRASH_AT || 0), FAIL_TAG = process.env.FAIL_TAG || ''
let n = 0
_setSpawn(async (cmd, args) => {
  const prompt = String(args[1] || '')
  const tag = (prompt.match(/CALLTAG:(\\w+)/) || [])[1] || '?'
  n++
  if (LOG) appendFileSync(LOG, tag + '\\n')
  if (FAIL_TAG && tag === FAIL_TAG) throw new Error('stub fail ' + tag)
  if (CRASH_AT && n >= CRASH_AT) process.exit(137) // simulate a hard interrupt DURING this spawn
  return JSON.stringify({ result: 'R-' + tag })
})
const B = process.env.B_VARIANT || 'b1'
const calls = [['A', 'call CALLTAG:A'], ['B', 'call CALLTAG:B variant ' + B], ['C', 'call CALLTAG:C']]
for (const [tag, p] of calls) { const r = await llm(p, { harness: 'claude', model: 'haiku' }); console.log(tag + '=' + r) }
console.log('DONE')
`)

let logSeq = 0
function runFixture(mem, env = {}) {
  const logPath = join(mem, `spawns-${++logSeq}.log`)
  const res = spawnSync(process.execPath, [FIXTURE], {
    env: { ...process.env, BLITZ_MEM_DIR: mem, BLITZ_DEPTH: '0', SPAWN_LOG: logPath, ...env }, encoding: 'utf8',
  })
  const spawned = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : []
  return { code: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), spawned }
}

// ── B) resume: interrupt mid-run, re-run fast-forwards the completed prefix ──────────────────────────
console.log('\njournaling (resume / edge-result memoization):')
{
  const mem = mkdtempSync(join(tmpdir(), 'blitz-jmem-'))
  const r1 = runFixture(mem, { CRASH_AT: '3' }) // crash on the 3rd spawn (call C)
  ok('run1 interrupted on call C (exit 137)', r1.code === 137, { code: r1.code })
  ok('run1 spawned A,B,C (C is the crashing spawn)', r1.spawned.join(',') === 'A,B,C', r1.spawned)
  const j1 = readJournal(mem)
  ok('journal durably has A(i0)+B(i1), NOT C (C never completed)',
    /"i":0/.test(j1) && /"i":1/.test(j1) && !/"i":2/.test(j1) && /R-A/.test(j1) && /R-B/.test(j1), j1)

  const r2 = runFixture(mem) // resume (same mem dir, no crash)
  ok('run2 completes (DONE)', /DONE/.test(r2.stdout), r2.stdout)
  ok('run2 FAST-FORWARDS A,B (only C re-spawns)', r2.spawned.join(',') === 'C', r2.spawned)
  ok('run2 output uses cached A,B + fresh C', /A=R-A/.test(r2.stdout) && /B=R-B/.test(r2.stdout) && /C=R-C/.test(r2.stdout), r2.stdout)
  ok('journal now has all 3 (i0,i1,i2)', /"i":2/.test(readJournal(mem)))
  rmSync(mem, { recursive: true, force: true })
}

// ── C) divergence: a changed call re-runs from that point (positional-prefix invalidation) ───────────
console.log('\ndivergence (a changed call invalidates itself + downstream):')
{
  const mem = mkdtempSync(join(tmpdir(), 'blitz-jdiv-'))
  const r1 = runFixture(mem) // seed a full journal
  ok('seed run completes + journals all 3', /DONE/.test(r1.stdout) && r1.spawned.join(',') === 'A,B,C', { out: r1.stdout, sp: r1.spawned })
  const r2 = runFixture(mem, { B_VARIANT: 'b2' }) // B's prompt changes
  ok('A fast-forwards; changed B + downstream C re-spawn', r2.spawned.join(',') === 'B,C', r2.spawned)
  ok('re-run completes', /DONE/.test(r2.stdout))
  rmSync(mem, { recursive: true, force: true })
}

// ── D) a FAILED call is not journaled -> it re-runs on resume (cross-run failure recovery) ───────────
console.log('\nfailure not journaled (re-runs on resume):')
{
  const mem = mkdtempSync(join(tmpdir(), 'blitz-jfail-'))
  const r1 = runFixture(mem, { FAIL_TAG: 'B' }) // B throws
  ok('run1 fails on B (non-zero exit)', r1.code !== 0, { code: r1.code })
  const j1 = readJournal(mem)
  ok('run1 journaled A only, NOT the failed B', r1.spawned.join(',') === 'A,B' && /"i":0/.test(j1) && !/"i":1/.test(j1), { sp: r1.spawned, j: j1 })
  const r2 = runFixture(mem) // B no longer fails
  ok('run2 RECOVERS: A cached, B+C re-spawn, DONE', r2.spawned.join(',') === 'B,C' && /DONE/.test(r2.stdout), { sp: r2.spawned, out: r2.stdout })
  rmSync(mem, { recursive: true, force: true })
}

// ── E) dry-run does NOT journal (blitz check stays free + side-effect-free) ──────────────────────────
console.log('\ndry-run writes no journal:')
{
  const mem = mkdtempSync(join(tmpdir(), 'blitz-jdry-'))
  const r = runFixture(mem, { BLITZ_DRY_RUN: '1' })
  ok('dry-run completes via fallbacks, NO real spawn', /DONE/.test(r.stdout) && r.spawned.length === 0, { out: r.stdout, sp: r.spawned })
  ok('no journal.jsonl written in dry-run', !existsSync(join(mem, 'journal.jsonl')))
  rmSync(mem, { recursive: true, force: true })
}

rmSync(FIXDIR, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : failures + ' FAILED'} — blitz journaling + retries`)
process.exit(failures === 0 ? 0 : 1)
