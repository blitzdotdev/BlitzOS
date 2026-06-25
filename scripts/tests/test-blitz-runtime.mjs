// test-blitz-runtime.mjs — the Claude Code Workflow loader + injected globals (NO real LLM is spawned).
//
// Covers (plans/blitzos-blitzscript-claude-interface.md §15):
//   loader: parses `meta` + STRIPS it (line numbers preserved); AsyncFunction wrap runs a body with
//           top-level await + return; the syntax gate throws on a bad body.
//   determinism shadow: Date.now / new Date / Math.random / setTimeout / crypto.randomUUID THROW, but
//           Math.max/floor + Date.UTC pass.
//   parallel: BARRIER; a throwing thunk -> null; the 4096 cap; a TypeError on a non-function element.
//   pipeline: NO inter-stage barrier; stage cb (prev, item, index); a throwing stage drops that item to null.
//   phase/log: emit to the progress sink. injected agent: callable (stub spawner) under the run context.
//   G4: two runWorkflow() in ONE process keep DISTINCT journals; workflow() child writes a SUBDIR journal,
//       the parent journal untouched.
//   G6: ctx.calls is per-RUN (two 600-"call" dry-runs neither trips the 1000 cap).
//
// Run: node scripts/tests/test-blitz-runtime.mjs

import {
  loadWorkflow, stripMeta, makeWrappedFn, runWorkflow, parallel, pipeline, setProgressSink, makeBudget,
} from '../../src/main/blitzscript/runtime.mjs'
import { _setSpawn, _resetJournal, RunContext, withRunContext, agent } from '../../src/main/blitzscript/agent.mjs'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORPUS = join(__dirname, '..', '..', 'src', 'main', 'blitzscript', 'examples', 'claude_workflows')
delete process.env.BLITZ_MEM_DIR

let failures = 0
const ok = (name, cond, extra) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '') } }
const TMP = mkdtempSync(join(tmpdir(), 'blitz-rt-test-'))
const wfFile = (name, src) => { const p = join(TMP, name); writeFileSync(p, src); return p }

// ── loader: parse + strip meta, line numbers preserved ──────────────────────────────────────────
console.log('loader (parse + strip meta):')
{
  const src = `export const meta = {
  name: 'demo',
  phases: [{ title: 'A', detail: 'first' }],
}
phase('A')
return { ok: true }
`
  const { meta, body } = stripMeta(src, 'demo.js')
  ok('meta.name parsed', meta.name === 'demo', meta)
  ok('meta.phases parsed', Array.isArray(meta.phases) && meta.phases.length === 1, meta.phases)
  ok('line count preserved (meta blanked, not removed)', src.split('\n').length === body.split('\n').length, { src: src.split('\n').length, body: body.split('\n').length })
  ok('meta statement removed from body', !/export\s+const\s+meta/.test(body))
  ok('body keeps the code after meta', /phase\('A'\)/.test(body) && /return \{ ok: true \}/.test(body))

  // a real corpus file
  const real = loadWorkflow(join(CORPUS, 'name-the-thing-wf_f432b204-456.js'))
  ok('real corpus meta.name', real.meta.name === 'name-the-thing', real.meta.name)
  ok('real corpus meta.phases (6)', (real.meta.phases || []).length === 6)
  const realSrc = readFileSync(join(CORPUS, 'name-the-thing-wf_f432b204-456.js'), 'utf8')
  ok('real corpus line count preserved', realSrc.split('\n').length === real.body.split('\n').length)

  // a file with NO meta synthesizes { name: basename }
  const nm = stripMeta('return 1\n', '/tmp/foo-bar.js')
  ok('missing meta -> synthesized { name: basename }', nm.meta.name === 'foo-bar', nm.meta)
}

// ── AsyncFunction wrap + syntax gate ─────────────────────────────────────────────────────────────
console.log('\nwrap + syntax gate:')
{
  const fn = makeWrappedFn('return (await Promise.resolve(40)) + 2')
  const v = await fn(/* agent */ null, /* parallel */ null, /* pipeline */ null, /* phase */ () => {}, /* log */ () => {}, /* args */ undefined, /* budget */ null, /* workflow */ null, /* Date */ null, /* Math */ Math, /* setTimeout */ null, /* setInterval */ null, /* setImmediate */ null, /* performance */ null, /* crypto */ null)
  ok('top-level await + return runs', v === 42, v)
  let threw = false
  try { makeWrappedFn('const x = ;') } catch (e) { threw = e instanceof SyntaxError }
  ok('a bad body throws SyntaxError (the check.mjs gate)', threw)
}

// ── determinism shadow ───────────────────────────────────────────────────────────────────────────
console.log('\ndeterminism shadow:')
{
  const throws = async (expr) => { try { await runWorkflow(wfFile('det.js', `export const meta={name:'d'}\nreturn ${expr}`), {}); return false } catch { return true } }
  ok('Date.now() throws', await throws('Date.now()'))
  ok('new Date() throws', await throws('new Date().getTime()'))
  ok('Math.random() throws', await throws('Math.random()'))
  ok('setTimeout() throws', await throws('setTimeout(()=>{},1)'))
  ok('crypto.randomUUID() throws', await throws('crypto.randomUUID()'))
  const r = await runWorkflow(wfFile('detok.js', `export const meta={name:'d'}\nreturn { a: Math.max(2,5), b: Math.floor(3.9), c: Date.UTC(2020,0,1) }`), {})
  ok('Math.max/floor + Date.UTC pass through', r.result.a === 5 && r.result.b === 3 && r.result.c === 1577836800000, r.result)
}

// ── parallel ─────────────────────────────────────────────────────────────────────────────────────
console.log('\nparallel:')
{
  await withRunContext(new RunContext({}), async () => {
    const res = await parallel([() => 1, () => Promise.resolve(2), () => { throw new Error('boom') }])
    ok('barrier returns all; a throwing thunk -> null', JSON.stringify(res) === JSON.stringify([1, 2, null]), res)
    let te = false
    try { await parallel([Promise.resolve(1)]) } catch (e) { te = e instanceof TypeError }
    ok('a non-function element -> TypeError (wrap as () => …)', te)
    let cap = false
    try { await parallel(Array.from({ length: 4097 }, () => () => 1)) } catch (e) { cap = /cap/.test(e.message) }
    ok('over 4096 items -> throws (cap)', cap)
  })
}

// ── pipeline ─────────────────────────────────────────────────────────────────────────────────────
console.log('\npipeline:')
{
  await withRunContext(new RunContext({}), async () => {
    const res = await pipeline([10, 20], (n) => n + 1, (prev, item, i) => `${prev}|${item}|${i}`)
    ok('stage1(item) then stage2(prev,item,index)', JSON.stringify(res) === JSON.stringify(['11|10|0', '21|20|1']), res)
    // NO inter-stage barrier: an item whose stage2 throws drops to null; the OTHER item still completes.
    const res2 = await pipeline([1, 2], (n) => n, (prev) => { if (prev === 1) throw new Error('drop'); return prev * 100 })
    ok('a throwing stage drops THAT item to null, others survive', JSON.stringify(res2) === JSON.stringify([null, 200]), res2)
  })
}

// ── phase / log emit ─────────────────────────────────────────────────────────────────────────────
console.log('\nphase / log emit:')
{
  const events = []
  setProgressSink((ev) => events.push(ev))
  await runWorkflow(wfFile('emit.js', `export const meta={name:'e'}\nphase('P1')\nlog('hello')\nreturn 1`), {})
  setProgressSink(null)
  ok('phase emits a phase marker', events.some((e) => e.type === 'phase' && e.title === 'P1'), events)
  ok('log emits a log marker', events.some((e) => e.type === 'log' && e.message === 'hello'), events)
}

// ── injected agent is callable (stub spawner), under the run context ─────────────────────────────
console.log('\ninjected agent (stub spawner):')
{
  _setSpawn(async () => JSON.stringify({ result: 'STUB' }))
  const r = await runWorkflow(wfFile('agent.js', `export const meta={name:'a'}\nconst t = await agent('hi', { harness: 'claude' })\nreturn { t }`), {})
  ok('agent() returns the stubbed text', r.result.t === 'STUB', r.result)
  ok('run stats count the real call', r.stats.calls === 1, r.stats)
  _setSpawn(null)
}

// ── G4: two runWorkflow in ONE process keep DISTINCT journals ────────────────────────────────────
console.log('\nG4 (per-run journal isolation):')
{
  // A stub spawner that echoes the prompt's TAG so the two runs journal different results.
  _setSpawn(async (cmd, args) => { const tag = (String(args[1] || '').match(/TAG:(\w+)/) || [])[1] || '?'; return JSON.stringify({ result: 'R-' + tag }) })
  const memA = join(TMP, 'memA'), memB = join(TMP, 'memB')
  const a = await runWorkflow(wfFile('runA.js', `export const meta={name:'A'}\nconst x = await agent('p TAG:AAA')\nreturn { x }`), { memDir: memA })
  const b = await runWorkflow(wfFile('runB.js', `export const meta={name:'B'}\nconst x = await agent('p TAG:BBB')\nreturn { x }`), { memDir: memB })
  ok('run A journaled to memA', existsSync(join(memA, 'journal.jsonl')) && /R-AAA/.test(readFileSync(join(memA, 'journal.jsonl'), 'utf8')), readFileSync(join(memA, 'journal.jsonl'), 'utf8'))
  ok('run B journaled to memB (distinct file + distinct result)', existsSync(join(memB, 'journal.jsonl')) && /R-BBB/.test(readFileSync(join(memB, 'journal.jsonl'), 'utf8')) && !/R-AAA/.test(readFileSync(join(memB, 'journal.jsonl'), 'utf8')))
  ok('each journal has exactly index 0 (jIndex per-run, not shared)', /"i":0/.test(readFileSync(join(memA, 'journal.jsonl'), 'utf8')) && !/"i":1/.test(readFileSync(join(memB, 'journal.jsonl'), 'utf8')))
  ok('run A result distinct from run B', a.result.x === 'R-AAA' && b.result.x === 'R-BBB', { a: a.result, b: b.result })
  _setSpawn(null)
}

// ── G4: workflow() child writes a SUBDIR journal; the parent journal is untouched ────────────────
console.log('\nG4 (nested workflow() journal isolation):')
{
  _setSpawn(async (cmd, args) => { const tag = (String(args[1] || '').match(/TAG:(\w+)/) || [])[1] || '?'; return JSON.stringify({ result: 'R-' + tag }) })
  // a child workflow file (resolved by absolute path through the workflow() global)
  const child = wfFile('child.js', `export const meta={name:'child'}\nconst c = await agent('child TAG:CHILD')\nreturn { c }`)
  const memP = join(TMP, 'memParent')
  const parent = wfFile('parent.js', `export const meta={name:'parent'}\nconst p = await agent('parent TAG:PARENT')\nconst sub = await workflow(${JSON.stringify(child)})\nreturn { p, sub }`)
  process.env.BLITZ_WS = TMP
  const r = await runWorkflow(parent, { memDir: memP, depth: 0 })
  ok('parent + child both ran', r.result.p === 'R-PARENT' && r.result.sub && r.result.sub.c === 'R-CHILD', r.result)
  const pj = readFileSync(join(memP, 'journal.jsonl'), 'utf8')
  ok('parent journal has only the PARENT call (not the child)', /R-PARENT/.test(pj) && !/R-CHILD/.test(pj), pj)
  const subJournal = join(memP, 'sub', 'child', 'journal.jsonl')
  ok('child journaled into the SUBDIR (memParent/sub/child/)', existsSync(subJournal) && /R-CHILD/.test(readFileSync(subJournal, 'utf8')), existsSync(subJournal))
  _setSpawn(null)
}

// ── G6: ctx.calls is per-RUN — two 600-call dry-runs neither trips the 1000 cap ──────────────────
console.log('\nG6 (per-run call cap; dry-run counter separate):')
{
  process.env.BLITZ_DRY_RUN = '1'
  const wf = wfFile('many.js', `export const meta={name:'m'}\nlet n=0\nfor (let i=0;i<600;i++){ await agent('x'+i, {}, 'FB'); n++ }\nreturn { n }`)
  const r1 = await runWorkflow(wf, {})
  const r2 = await runWorkflow(wf, {})
  ok('run1 makes 600 dry-calls without tripping 1000', r1.result.n === 600, r1.result)
  ok('run2 ALSO makes 600 (the counter reset per run, did not accumulate to 1200)', r2.result.n === 600, r2.result)
  delete process.env.BLITZ_DRY_RUN
}

// ── budget helper ────────────────────────────────────────────────────────────────────────────────
console.log('\nbudget helper:')
{
  const ctx = new RunContext({})
  const unbounded = makeBudget(null, ctx)
  ok('null total -> unbounded (remaining = Infinity)', unbounded.total === null && unbounded.remaining() === Infinity)
  const b = makeBudget(1000, ctx)
  ctx.tokensSpent = 300
  ok('a numeric total tracks spent/remaining', b.total === 1000 && b.spent() === 300 && b.remaining() === 700, { spent: b.spent(), remaining: b.remaining() })
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : failures + ' FAILED'} — blitz runtime (loader + globals)`)
process.exit(failures === 0 ? 0 : 1)
