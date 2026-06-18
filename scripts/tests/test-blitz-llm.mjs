#!/usr/bin/env node
// Headless unit test for the blitzscript llm() chokepoint — NO real LLM is ever spawned.
// Injects a fake spawner (llm._setSpawn) and asserts the runtime's contract:
//   1) the appended leaf metadata (depth + no-recurse + act-vs-ask) is in the prompt actually sent
//   2) BLITZ_DEPTH is set on the child env and INCREMENTED (parent depth + 1)
//   3) claude vs codex command+flags are built correctly for given { harness, model, effort }
//   4) the concurrency semaphore bounds parallelism (a wide Promise.all never exceeds the cap)
//   5) parse() extracts the final text from a sample stdout for each harness
//
// Run: node scripts/tests/test-blitz-llm.mjs

import os from 'node:os'
import { llm, _setSpawn, _stats, leafMetadata } from '../../src/main/blitzscript/llm.mjs'
import { harnesses } from '../../src/main/blitzscript/harnesses.mjs'

let failed = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) failed++
}

// A fake spawner: records every (cmd, args, env) and returns a canned stdout per harness so parse()
// has something realistic to chew on. NEVER launches a process.
const calls = []
function fakeSpawn(stdoutFor) {
  return async (cmd, args, env) => {
    calls.push({ cmd, args, env })
    return stdoutFor(cmd)
  }
}
const cannedStdout = (cmd) => {
  if (cmd === 'claude') return JSON.stringify({ type: 'result', subtype: 'success', result: 'CLAUDE_ANSWER' })
  if (cmd === 'codex') {
    // Real codex --json shape (confirmed live): a JSONL stream; final agent_message is the answer.
    return [
      JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'CODEX_ANSWER' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ].join('\n') + '\n'
  }
  return ''
}

// ── 1 + 2 + 3: claude command, metadata, depth env ─────────────────────────────────────────────
console.log('\n[claude] command + metadata + depth')
{
  _setSpawn(fakeSpawn(cannedStdout))
  calls.length = 0
  process.env.BLITZ_DEPTH = '0' // simulate the root run
  const out = await llm('Summarize the slice.', { harness: 'claude', model: 'haiku', effort: 'low' })

  const c = calls.at(-1)
  ok('claude binary is "claude"', c.cmd === 'claude', c.cmd)
  ok('claude uses print mode -p', c.args.includes('-p'))
  ok('claude uses --output-format json', c.args.join(' ').includes('--output-format json'))
  ok('claude passes --dangerously-skip-permissions', c.args.includes('--dangerously-skip-permissions'))
  ok('claude maps opts.model -> --model haiku', adjacent(c.args, '--model', 'haiku'))
  ok('claude maps opts.effort -> --effort low', adjacent(c.args, '--effort', 'low'))

  // The prompt argument is the one right after -p; it must carry our metadata block verbatim.
  const promptArg = c.args[c.args.indexOf('-p') + 1]
  ok('(1) prompt carries the user task', promptArg.includes('Summarize the slice.'))
  ok('(1) prompt carries the no-recurse rule', /Do NOT recurse/.test(promptArg) && /no `blitz run`/.test(promptArg))
  ok('(1) prompt carries the act-vs-ask boundary', /Act-vs-ask boundary/.test(promptArg) && /irreversible outward act/.test(promptArg))
  ok('(1) prompt states the leaf depth (1 at root+1)', /depth 1/.test(promptArg) && promptArg.includes(leafMetadata(1).trim().split('\n')[1]))

  ok('(2) child env BLITZ_DEPTH is set + incremented to 1', c.env.BLITZ_DEPTH === '1', `got ${c.env.BLITZ_DEPTH}`)
  ok('(5) claude parse() extracts the final text', out === 'CLAUDE_ANSWER', out)
}

// ── 2 (nested): a leaf already at depth 2 labels its child depth 3 ──────────────────────────────
console.log('\n[depth] increment from a non-root BLITZ_DEPTH')
{
  _setSpawn(fakeSpawn(cannedStdout))
  calls.length = 0
  process.env.BLITZ_DEPTH = '2'
  await llm('x', { harness: 'claude' })
  const c = calls.at(-1)
  ok('(2) BLITZ_DEPTH=2 -> child BLITZ_DEPTH=3', c.env.BLITZ_DEPTH === '3', `got ${c.env.BLITZ_DEPTH}`)
  const promptArg = c.args[c.args.indexOf('-p') + 1]
  ok('(2) metadata reflects depth 3', /depth 3/.test(promptArg))
  process.env.BLITZ_DEPTH = '0'
}

// ── 3: codex command + flags ────────────────────────────────────────────────────────────────────
console.log('\n[codex] command + flags + parse')
{
  _setSpawn(fakeSpawn(cannedStdout))
  calls.length = 0
  const out = await llm('Reconcile the verdicts.', { harness: 'codex', model: 'gpt-5.4-codex', effort: 'high' })

  const c = calls.at(-1)
  ok('codex binary is "codex"', c.cmd === 'codex', c.cmd)
  ok('codex uses the exec subcommand', c.args[0] === 'exec', c.args[0])
  ok('codex prompt is passed as an arg', c.args.includes('Reconcile the verdicts.') || c.args.some(a => a.includes('Reconcile the verdicts.')))
  ok('codex uses --json', c.args.includes('--json'))
  ok('codex bypasses approvals+sandbox', c.args.includes('--dangerously-bypass-approvals-and-sandbox'))
  ok('codex skips the git repo check', c.args.includes('--skip-git-repo-check'))
  ok('codex maps opts.model -> -c model="…"', adjacent(c.args, '-c', 'model="gpt-5.4-codex"'))
  ok('codex maps opts.effort -> -c model_reasoning_effort="…"', adjacent(c.args, '-c', 'model_reasoning_effort="high"'))
  ok('(2) codex child env BLITZ_DEPTH=1', c.env.BLITZ_DEPTH === '1', `got ${c.env.BLITZ_DEPTH}`)
  ok('(5) codex parse() extracts the final agent_message', out === 'CODEX_ANSWER', out)
}

// ── 5 (direct): parse() against the real sample stdout for each harness ─────────────────────────
console.log('\n[parse] direct parser checks')
{
  ok('(5) claude parse handles the single result object', harnesses.claude.parse(cannedStdout('claude')) === 'CLAUDE_ANSWER')
  // claude streamed multi-line: last result line wins.
  const multi = 'noise\n' + JSON.stringify({ type: 'system' }) + '\n' + JSON.stringify({ result: 'LAST' })
  ok('(5) claude parse takes the last result line', harnesses.claude.parse(multi) === 'LAST')
  ok('(5) codex parse handles the JSONL agent_message', harnesses.codex.parse(cannedStdout('codex')) === 'CODEX_ANSWER')
  // codex flat-shape fallback (alternate builds).
  ok('(5) codex parse handles the flat agent_message shape', harnesses.codex.parse(JSON.stringify({ type: 'agent_message', message: 'FLAT' })) === 'FLAT')
}

// ── 4: the concurrency semaphore bounds parallelism ─────────────────────────────────────────────
console.log('\n[concurrency] semaphore caps parallel leaves')
{
  const cap = _stats().maxConcurrency
  ok('cap defaults to max(2, cores-2)', cap === Math.max(2, os.cpus().length - 2), `cap=${cap} cores=${os.cpus().length}`)

  let inFlight = 0, peak = 0
  // A gated spawner: each "leaf" holds its slot until we release it, so we can observe the peak.
  const gates = []
  _setSpawn(async (cmd) => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise((r) => gates.push(r)) // block here, occupying a semaphore slot
    inFlight--
    return cannedStdout(cmd)
  })

  // Fan out far more calls than the cap; they must NOT all be in flight at once.
  const N = cap + 8
  const all = Promise.all(Array.from({ length: N }, () => llm('parallel slice', { harness: 'claude' })))
  // Let the event loop settle so all admittable calls have entered the spawner.
  await tick()
  ok(`(4) at most ${cap} leaves run concurrently (peak=${peak})`, peak <= cap, `peak=${peak} cap=${cap}`)
  ok(`(4) the cap is actually saturated (peak=${peak})`, peak === cap, `peak=${peak} cap=${cap}`)
  ok(`(4) the rest are queued (${N - cap} waiting)`, _stats().waiting === N - cap, `waiting=${_stats().waiting}`)

  // Drain: releasing slots one-by-one must admit the queued calls until all N complete.
  while (gates.length) gates.shift()()
  // Newly admitted calls re-enter the gated spawner; keep draining until the queue empties.
  for (let i = 0; i < N + 4 && (gates.length || _stats().active > 0); i++) { await tick(); while (gates.length) gates.shift()() }
  await all
  ok('(4) all calls drain to completion', _stats().active === 0 && _stats().waiting === 0, `active=${_stats().active} waiting=${_stats().waiting}`)
}

// ── done ─────────────────────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — blitz llm()  (${failed} failure${failed === 1 ? '' : 's'})`)
process.exit(failed === 0 ? 0 : 1)

// helpers
function adjacent(args, flag, val) {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === flag && args[i + 1] === val) return true
  return false
}
function tick() { return new Promise((r) => setImmediate(r)) }
