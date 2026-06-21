// test-blitz-schema.mjs — the structured-output path (schema validator + stub + harness build/parse).
//
// Covers (plans/blitzos-blitzscript-claude-interface.md §15):
//   schema.mjs: validate() accepts/rejects the corpus subset (type/properties/required/items/enum/
//               additionalProperties:false); stubFromSchema() shapes a representative value.
//   G1 (claude): parseStructured extracts `o.structured_output` (NOT `o.result`) from the REAL-shaped
//                fixture; buildStructured includes `--json-schema`.
//   G2 (codex):  buildStructured (native) writes a tmp schema file + includes `--output-schema <path>`;
//                the prompt-coax fallback (no native flag) appends the schema + parseStructured parses JSON.
//   agent({schema}): returns the validated object; dry-run returns stubFromSchema; bad-then-good re-prompt
//                returns the good object; a stubborn bad result -> null after retries.
//
// Run: node scripts/tests/test-blitz-schema.mjs

import { validate, stubFromSchema } from '../../src/main/blitzscript/schema.mjs'
import { harnesses, _setCodexOutputSchemaSupport, strictifyForCodex } from '../../src/main/blitzscript/harnesses.mjs'
import { agent, _setSpawn, _resetJournal, RunContext, withRunContext } from '../../src/main/blitzscript/agent.mjs'
import { existsSync, readFileSync } from 'node:fs'

let failures = 0
const ok = (name, cond, extra) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '') } }
delete process.env.BLITZ_MEM_DIR

// ── schema.mjs validator ─────────────────────────────────────────────────────────────────────────
console.log('schema validator (corpus subset):')
{
  // a representative corpus schema: object with required array-of-objects + enum + additionalProperties:false
  const S = {
    type: 'object', additionalProperties: false, required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['quote', 'category', 'strength'],
          properties: {
            quote: { type: 'string' },
            category: { type: 'string', enum: ['a', 'b', 'c'] },
            strength: { type: 'string', enum: ['mild', 'firm'] },
            count: { type: 'integer' },
          },
        },
      },
    },
  }
  ok('valid object passes', validate({ findings: [{ quote: 'x', category: 'a', strength: 'mild', count: 2 }] }, S).ok)
  ok('missing required property fails', !validate({ findings: [{ category: 'a', strength: 'mild' }] }, S).ok)
  ok('wrong type fails (count string)', !validate({ findings: [{ quote: 'x', category: 'a', strength: 'mild', count: 'two' }] }, S).ok)
  ok('non-integer for integer fails', !validate({ findings: [{ quote: 'x', category: 'a', strength: 'mild', count: 1.5 }] }, S).ok)
  ok('enum violation fails', !validate({ findings: [{ quote: 'x', category: 'z', strength: 'mild' }] }, S).ok)
  ok('additionalProperties:false rejects an extra key', !validate({ findings: [], extra: 1 }, S).ok)
  ok('empty findings array is valid', validate({ findings: [] }, S).ok)
  ok('top-level wrong type fails', !validate([], S).ok)
  ok('number accepts integers too', validate(3, { type: 'number' }).ok && validate(3.5, { type: 'number' }).ok)
  ok('a null/loose schema accepts anything', validate({ anything: 1 }, null).ok)

  // stubFromSchema
  const stub = stubFromSchema(S)
  ok('stub is an object with findings array of one representative item', Array.isArray(stub.findings) && stub.findings.length === 1, stub)
  ok('stub enum -> first value', stub.findings[0].category === 'a' && stub.findings[0].strength === 'mild', stub.findings[0])
  ok('stub validates against its own schema', validate(stub, S).ok, validate(stub, S).errors)
  ok('stub for a bare string schema is ""', stubFromSchema({ type: 'string' }) === '')
  ok('stub infers object from properties when type omitted', typeof stubFromSchema({ properties: { k: { type: 'string' } } }) === 'object')
}

// ── G1: claude buildStructured + parseStructured (structured_output, NOT .result) ────────────────
console.log('\nG1 (claude structured output reads structured_output):')
{
  const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } }, required: ['name', 'age'] }
  const built = harnesses.claude.buildStructured('make a person', { model: 'haiku' }, schema)
  ok('claude buildStructured cmd is claude', built.cmd === 'claude')
  ok('claude buildStructured includes --json-schema with the schema JSON', adjacent(built.args, '--json-schema', JSON.stringify(schema)), built.args)
  ok('claude buildStructured keeps --output-format json', built.args.join(' ').includes('--output-format json'))
  ok('claude buildStructured maps model', adjacent(built.args, '--model', 'haiku'))

  // THE REAL FIXTURE (claude 2.1.170): .result is PROSE, structured_output is the validated object.
  const fixture = JSON.stringify({
    type: 'result', subtype: 'success',
    result: "Done! I've created a person object for Alice, age 30.",
    usage: { input_tokens: 12, output_tokens: 8 }, total_cost_usd: 0.0327,
    structured_output: { name: 'Alice', age: 30 },
  })
  const parsed = harnesses.claude.parseStructured(fixture)
  ok('parseStructured returns the structured_output object (NOT the prose result)', JSON.stringify(parsed) === JSON.stringify({ name: 'Alice', age: 30 }), parsed)
  ok('the prose .result is NOT what parseStructured returns', typeof parsed !== 'string')
  ok('parseStructured returns null when structured_output is absent', harnesses.claude.parseStructured(JSON.stringify({ result: 'just prose' })) === null)
  // usage() sums tokens for budget.
  ok('claude usage() sums tokens from usage{}', harnesses.claude.usage(fixture) === 20, harnesses.claude.usage(fixture))
}

// ── G2: codex buildStructured native (--output-schema tmpfile) + coax fallback ───────────────────
console.log('\nG2 (codex native --output-schema + coax fallback):')
{
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
  // native path (force support ON); needs a ctx with a memDir so the schema file lands deterministically.
  _setCodexOutputSchemaSupport(true)
  const ctx = new RunContext({ memDir: process.env.TMPDIR || '/tmp', defaultModel: undefined })
  ctx.jIndex = 7
  const built = harnesses.codex.buildStructured('return ok', { model: 'gpt-x' }, schema, ctx)
  const osIdx = built.args.indexOf('--output-schema')
  ok('codex buildStructured includes --output-schema', osIdx >= 0, built.args)
  const schemaFile = built.args[osIdx + 1]
  ok('codex --output-schema points at a written tmp schema file', !!schemaFile && existsSync(schemaFile), schemaFile)
  ok('the tmp schema file is the STRICT-coerced schema (codex --output-schema needs OpenAI-strict)', existsSync(schemaFile) && JSON.stringify(JSON.parse(readFileSync(schemaFile, 'utf8'))) === JSON.stringify(strictifyForCodex(schema)))
  ok('codex buildStructured keeps exec + --json', built.args[0] === 'exec' && built.args.includes('--json'))
  ok('native path does NOT coax the prompt (no schema text appended)', !built.args[1].includes('Respond with ONLY a JSON'))

  // strictifyForCodex coerces a LENIENT schema (optional field) to OpenAI-strict so codex stops 400ing.
  const lenient = { type: 'object', required: ['a'], properties: { a: { type: 'string' }, b: { type: 'number' } } }
  const strict = strictifyForCodex(lenient)
  ok('strictifyForCodex: required lists EVERY property + additionalProperties:false', strict.additionalProperties === false && JSON.stringify(strict.required) === JSON.stringify(['a', 'b']))
  ok('strictifyForCodex: an originally-optional field is made nullable', Array.isArray(strict.properties.b.type) && strict.properties.b.type.includes('null'))

  // fallback path (force support OFF): prompt-coax appends the schema, no --output-schema.
  _setCodexOutputSchemaSupport(false)
  const fb = harnesses.codex.buildStructured('return ok', {}, schema)
  ok('fallback path has NO --output-schema', !fb.args.includes('--output-schema'))
  ok('fallback path appends the schema to the prompt', fb.args[1].includes('Respond with ONLY a JSON') && fb.args[1].includes('"required"'), fb.args[1].slice(-80))

  // parseStructured pulls JSON from the final agent_message (both native + coaxed).
  const jsonl = [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } })].join('\n')
  ok('codex parseStructured parses the agent_message JSON', JSON.stringify(harnesses.codex.parseStructured(jsonl)) === JSON.stringify({ ok: true }))
  const coaxed = [JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Sure:\n```json\n{"ok":false}\n```' } })].join('\n')
  ok('codex parseStructured strips fences in the coaxed reply', JSON.stringify(harnesses.codex.parseStructured(coaxed)) === JSON.stringify({ ok: false }))
  _setCodexOutputSchemaSupport(undefined)
}

// ── agent({schema}): validated object, dry-run stub, bad-then-good re-prompt, null after retries ──
console.log('\nagent({schema}) end-to-end (stub spawner):')
{
  const schema = { type: 'object', properties: { k: { type: 'string' } }, required: ['k'] }

  // dry-run: returns stubFromSchema (no spawn)
  await withRunContext(new RunContext({}), async () => {
    process.env.BLITZ_DRY_RUN = '1'
    const v = await agent('x', { schema })
    delete process.env.BLITZ_DRY_RUN
    ok('dry-run agent({schema}) returns the schema stub', JSON.stringify(v) === JSON.stringify({ k: '' }), v)
  })

  // real path: the leaf returns the AUTO-WRAPPED shape { meta:{human_summary}, output } -> agent() UNWRAPS to `output`
  await withRunContext(new RunContext({}), async () => {
    _setSpawn(async () => JSON.stringify({ result: 'prose', structured_output: { meta: { human_summary: 'said hello' }, output: { k: 'hello' } } }))
    const v = await agent('x', { schema, harness: 'claude' })
    ok('agent({schema}) returns the UNWRAPPED output (meta.human_summary stripped)', JSON.stringify(v) === JSON.stringify({ k: 'hello' }), v)
    _setSpawn(null)
  })

  // bad-then-good: first response's `output` misses `k` (invalid) -> re-prompt -> good wrapped
  await withRunContext(new RunContext({}), async () => {
    let n = 0
    _setSpawn(async () => { n++; return JSON.stringify(n === 1 ? { result: 'p', structured_output: { meta: { human_summary: 'x' }, output: { wrong: 1 } } } : { result: 'p', structured_output: { meta: { human_summary: 'fixed it' }, output: { k: 'fixed' } } }) })
    const v = await agent('x', { schema, harness: 'claude', schemaRetries: 1 })
    ok('a schema-invalid first response triggers a re-prompt, then succeeds', JSON.stringify(v) === JSON.stringify({ k: 'fixed' }) && n === 2, { v, n })
    _setSpawn(null)
  })

  // the human_summary is a SCHEMA REQUIREMENT: a valid `output` but NO meta.human_summary fails -> null after retries
  await withRunContext(new RunContext({}), async () => {
    _setSpawn(async () => JSON.stringify({ result: 'p', structured_output: { output: { k: 'ok' } } }))
    const v = await agent('x', { schema, harness: 'claude', schemaRetries: 1 })
    ok('a response missing meta.human_summary -> null (the summary is auto-required)', v === null, v)
    _setSpawn(null)
  })

  // stubborn bad -> null after retries (never throws)
  await withRunContext(new RunContext({}), async () => {
    _setSpawn(async () => JSON.stringify({ result: 'p', structured_output: { wrong: 1 } }))
    let threw = false, v
    try { v = await agent('x', { schema, harness: 'claude', schemaRetries: 2 }) } catch { threw = true }
    ok('a stubbornly-invalid result -> null (not a throw) after retries', !threw && v === null, { threw, v })
    _setSpawn(null)
  })
}

console.log(`\n${failures === 0 ? 'PASS' : failures + ' FAILED'} — blitz schema + structured output`)
process.exit(failures === 0 ? 0 : 1)

function adjacent(args, flag, val) {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === flag && args[i + 1] === val) return true
  return false
}
