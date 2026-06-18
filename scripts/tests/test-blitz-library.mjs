// test-blitz-library.mjs — the built-in workflow library + model-alias resolution (no real LLM call).
//
//  (A) name resolution: `verify-job` / `supervise-tick` resolve to the shipped built-ins; a bogus name fails.
//  (B) both built-ins dry-run-check (check()) PASS — full chunk/map/reduce flow validated against fallbacks.
//  (C) model aliases: llm() resolves 'cheap'/'strong'/'default' via the caps cache (+ claude fallback); a
//      concrete model id passes through. Asserted by capturing the spawned argv via an injected spawner.
//  (D) `blitz capabilities` writes the caps cache llm() reads.
// Run: node scripts/tests/test-blitz-library.mjs
import { llm, _setSpawn, _setCaps, _resetJournal } from '../../src/main/blitzscript/llm.mjs'
import { check } from '../../src/main/blitzscript/check.mjs'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUN = join(__dirname, '..', '..', 'src', 'main', 'blitzscript', 'run.mjs')
const LIB = join(__dirname, '..', '..', 'src', 'main', 'blitzscript', 'library')
delete process.env.BLITZ_MEM_DIR // never journal to a stray dir
delete process.env.BLITZ_DRY_RUN
let failures = 0
const ok = (n, c, x) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.log(`  ✗ ${n}`, x !== undefined ? JSON.stringify(x) : '') } }

// ── (A) name resolution via the real CLI (run.mjs) ───────────────────────────────────────────────
console.log('name resolution (blitz run/check <name>):')
{
  // a bogus name fails loud with a "not found" usage error (exit 2), naming where it looked.
  const bad = spawnSync(process.execPath, [RUN, 'check', 'no-such-workflow-xyz'], { encoding: 'utf8' })
  ok('bogus name → exit 2 + "not found"', bad.status === 2 && /not found/.test(String(bad.stderr)), { code: bad.status, err: String(bad.stderr).trim() })
  // both built-ins resolve to the shipped library dir (printed in the report header) + PASS.
  for (const name of ['verify-job', 'supervise-tick']) {
    const r = spawnSync(process.execPath, [RUN, 'check', name], { encoding: 'utf8' })
    const out = String(r.stdout)
    ok(`${name} resolves to the built-in library + PASSes`, r.status === 0 && out.includes(join(LIB, `${name}.mjs`)) && /\nPASS$/.test(out.trim()), { code: r.status, out: out.trim().split('\n').slice(0, 2) })
  }
}

// ── (B) both built-ins dry-run-check via check() directly ─────────────────────────────────────────
console.log('\nbuilt-in dry-run (check()):')
{
  for (const name of ['verify-job', 'supervise-tick']) {
    const rep = await check(join(LIB, `${name}.mjs`))
    ok(`${name}: syntax OK + dry-run OK`, rep.ok && rep.syntax === 'ok' && rep.dryRun === 'ok', rep.errors)
  }
}

// ── (C) model alias resolution (cheap | strong | default | concrete) ──────────────────────────────
console.log('\nmodel aliases (llm resolves via caps cache):')
{
  let lastArgs = null
  _setSpawn(async (_cmd, args) => { lastArgs = args; return JSON.stringify({ result: 'OK' }) }) // claude --output-format json shape
  const modelOf = () => { const k = lastArgs.indexOf('--model'); return k >= 0 ? lastArgs[k + 1] : null }
  const codexModelOf = () => { const c = lastArgs.filter((a, i) => lastArgs[i - 1] === '-c'); const m = c.find((s) => s.startsWith('model=')); return m ? m.slice('model='.length) : null }

  // with an injected caps cache: 'cheap'/'strong' map to THIS machine's picks.
  _setCaps({ harnesses: { claude: { cheap: 'haiku', strong: 'opus' }, codex: { cheap: 'gpt-cheap', strong: 'gpt-strong' } } })
  _resetJournal(); await llm('p', { harness: 'claude', model: 'cheap' }); ok("claude cheap → caps pick (haiku)", modelOf() === 'haiku', lastArgs)
  _resetJournal(); await llm('p', { harness: 'claude', model: 'strong' }); ok('claude strong → caps pick (opus)', modelOf() === 'opus', lastArgs)
  _resetJournal(); await llm('p', { harness: 'claude', model: 'default' }); ok("claude default → omit --model", modelOf() === null, lastArgs)
  _resetJournal(); await llm('p', { harness: 'claude', model: 'claude-opus-4-8' }); ok('concrete model id passes through', modelOf() === 'claude-opus-4-8', lastArgs)
  _resetJournal(); await llm('p', { harness: 'codex', model: 'cheap' }); ok('codex cheap → caps pick via -c model=', codexModelOf() === '"gpt-cheap"', lastArgs)

  // with NO caps cache: claude falls back to haiku/opus; codex omits (its own config default).
  _setCaps(null)
  _resetJournal(); await llm('p', { harness: 'claude', model: 'cheap' }); ok('no cache: claude cheap → built-in fallback (haiku)', modelOf() === 'haiku', lastArgs)
  _resetJournal(); await llm('p', { harness: 'codex', model: 'cheap' }); ok('no cache: codex cheap → omit -c model (config default)', codexModelOf() === null, lastArgs)
  _setCaps(undefined); _setSpawn(null)
}

// ── (D) `blitz capabilities` writes the caps cache ────────────────────────────────────────────────
console.log('\ncapabilities cache write:')
{
  const dir = mkdtempSync(join(tmpdir(), 'blitz-caps-'))
  const capsFile = join(dir, 'caps.json')
  const r = spawnSync(process.execPath, [RUN, 'capabilities'], { encoding: 'utf8', env: { ...process.env, BLITZ_CAPS_FILE: capsFile }, timeout: 30000 })
  ok('capabilities exits 0', r.status === 0, { code: r.status, err: String(r.stderr).slice(0, 200) })
  ok('caps cache file written + valid JSON with harnesses', existsSync(capsFile) && !!JSON.parse(readFileSync(capsFile, 'utf8')).harnesses, existsSync(capsFile) ? 'parsed' : 'missing')
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : failures + ' FAILED'} — blitz built-in library + model aliases`)
process.exit(failures === 0 ? 0 : 1)
