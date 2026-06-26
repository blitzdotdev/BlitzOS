// blitzscript agent()/llm() leaf layer: metadata+depth propagation, harness builders, parse samples, and
// the concurrency semaphore. Tests the CURRENT src/main/blitzscript code (the old src/main/blitz/ duplicate
// was deleted). llm is the back-compat alias of agent; the spawner is injected positionally via _setSpawn.
import os from 'node:os'
import { agent as llm, _setSpawn, _resetJournal, leafMetadata, MAX_CONCURRENCY } from '../../src/main/blitzscript/agent.mjs'
import { harnesses } from '../../src/main/blitzscript/harnesses.mjs'

let failures = 0
const ok = (label, cond, extra) => { if (cond) console.log('  ✓ ' + label); else { failures++; console.log('  ✗ ' + label, extra ?? '') } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const originalDepth = process.env.BLITZ_DEPTH

// ── (1) leaf metadata + depth propagation (parent depth 3 -> leaf depth 4) ───────────────────────
console.log('metadata + depth propagation:')
{
  process.env.BLITZ_DEPTH = '3'
  let last = null
  _setSpawn(async (cmd, args, env) => { last = { cmd, args, env }; return JSON.stringify({ result: 'ok' }) })
  const out = await llm('Plan stage: check repo state.', { harness: 'claude', model: 'opus', effort: 'high' })
  ok('llm() returns the parsed claude text', out === 'ok', out)
  const sent = (last.args || []).find((a) => typeof a === 'string' && a.includes('runtime metadata')) || ''
  ok('prompt carries the leaf metadata at depth 4', /\[blitzscript runtime metadata — depth 4\]/.test(sent))
  ok('metadata states the no-recurse rule', /Do NOT recurse: no `blitz run`, no spawning sub-agents/.test(sent))
  ok('metadata states the act-vs-ask boundary', /Act-vs-ask boundary: do reversible work on your own;/.test(sent))
  ok('child env BLITZ_DEPTH = 4', last.env.BLITZ_DEPTH === '4', last.env.BLITZ_DEPTH)
  ok('spawned cmd is claude', last.cmd === 'claude', last.cmd)
  ok('parent BLITZ_DEPTH is untouched (still 3)', process.env.BLITZ_DEPTH === '3')
}

// ── (2) harness command builders (current flags) ─────────────────────────────────────────────────
console.log('\nharness builders:')
{
  const claude = harnesses.claude.build('ask', { model: 'opus', effort: 'high' })
  ok('claude cmd', claude.cmd === 'claude')
  ok('claude uses print mode (-p first)', claude.args[0] === '-p', claude.args[0])
  ok('claude maps --model/--effort', claude.args.includes('--model') && claude.args.includes('opus') && claude.args.includes('--effort') && claude.args.includes('high'))
  ok('claude skips permissions', claude.args.includes('--dangerously-skip-permissions'))

  const codex = harnesses.codex.build('ask', { model: 'o3', effort: 'low' })
  ok('codex cmd', codex.cmd === 'codex')
  ok('codex uses the exec subcommand + the prompt right after it', codex.args[0] === 'exec' && codex.args[1] === 'ask')
  ok('codex emits JSONL + bypass flags', codex.args.includes('--json') && codex.args.includes('--dangerously-bypass-approvals-and-sandbox') && codex.args.includes('--skip-git-repo-check'))
  ok('codex maps -c model="o3" + model_reasoning_effort="low"', codex.args.includes('-c') && codex.args.includes('model="o3"') && codex.args.includes('model_reasoning_effort="low"'))
}

// ── (3) final-text parse samples (claude .result, codex agent_message) ────────────────────────────
console.log('\nparse samples:')
{
  ok('claude.parse pulls .result', harnesses.claude.parse(JSON.stringify({ type: 'result', is_error: false, result: 'Hello from Claude.' })) === 'Hello from Claude.')
  const codexStdout = [
    '{"type":"thread.started","thread_id":"019edd16-63bd-7982-83ec-a302c598c127"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG."}}',
  ].join('\n')
  ok('codex.parse pulls the final agent_message', harnesses.codex.parse(codexStdout) === 'PONG.')
}

// ── (4) concurrency semaphore: peak active never exceeds MAX_CONCURRENCY ───────────────────────────
console.log('\nconcurrency semaphore (cap = MAX_CONCURRENCY):')
{
  _resetJournal()                 // also resets the module-global semaphore counters
  process.env.BLITZ_DEPTH = '0'
  let active = 0, peak = 0
  _setSpawn(async () => { active++; peak = Math.max(peak, active); await sleep(40); active--; return JSON.stringify({ result: 'ok' }) })
  const N = MAX_CONCURRENCY + 6
  await Promise.all(Array.from({ length: N }, () => llm('parallel leaf', { harness: 'claude', effort: 'low' })))
  ok(`peak active hit the cap (peak=${peak}, cap=${MAX_CONCURRENCY})`, peak === MAX_CONCURRENCY, { peak, cap: MAX_CONCURRENCY })
  ok('peak never exceeded the cap', peak <= MAX_CONCURRENCY)
  ok('all leaves drained (active back to 0)', active === 0)
}

// ── (5) depth increments per nesting level (parent 9 -> leaf 10) ──────────────────────────────────
console.log('\ndepth increment:')
{
  process.env.BLITZ_DEPTH = '9'
  let last = null
  _setSpawn(async (cmd, args, env) => { last = { env, args }; return JSON.stringify({ result: (args.find((a) => typeof a === 'string' && a.includes('depth 10')) ? 'ten' : 'bad') }) })
  const out = await llm('one more', { harness: 'claude' })
  ok('leaf prompt is depth 10 (parent 9 + 1)', out === 'ten', out)
  ok('child env BLITZ_DEPTH = 10', last.env.BLITZ_DEPTH === '10', last.env.BLITZ_DEPTH)
}

_setSpawn(null)
if (originalDepth === undefined) delete process.env.BLITZ_DEPTH; else process.env.BLITZ_DEPTH = originalDepth

console.log(`\n${failures === 0 ? 'PASS' : failures + ' FAILED'} — blitz llm()`)
process.exit(failures === 0 ? 0 : 1)
