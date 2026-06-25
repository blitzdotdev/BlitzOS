// blitzscript leaf harnesses — the pluggable registry behind llm().
//
// Each harness turns an llm() call into a real headless coding-agent process on THIS machine
// (the user's own auth/subscription, cwd = the workspace), captures its stdout, and parses the
// final assistant text back out. This is the RLM "cheap leaf" — a full local agent, not a bare
// completion. See plans/blitzos-blitzscript.md ("llm() = a local claude -p / codex exec").
//
// A harness is: { build(prompt, opts) -> { cmd, args, env }, parse(stdout) -> text }.
//   build()  — produces the spawn descriptor (binary + argv + extra env). NEVER a shell string,
//              so the prompt and flags can't be re-split/injected by the shell.
//   parse()  — extracts the harness's FINAL assistant message from its captured stdout.
//
// Flags below were confirmed against the real CLIs on this machine (2026-06-17):
//   `claude --help`, `claude -p --help`, `codex exec --help`, plus tiny real runs to see the
//   exact stdout JSON shape. They also match the repo's own codex invocation in
//   src/main/agent-runtime.mjs (buildCodexServerlessCommand).
//
// To add a harness: implement build()/parse() and register it here. 'pi' and 'opencode' are
// STUBBED as the obvious extension points (see the // TODO entries at the bottom).
//
// STRUCTURED OUTPUT (opts.schema): a harness MAY also implement buildStructured()/parseStructured() to
// force a schema-valid JSON object back (agent() validates + retries, null after retries). Both are
// NATIVE on this machine (verified 2026-06-18, claude 2.1.170 / codex 0.139.0):
//   claude: `-p --output-format json --json-schema <schema>` puts the validated object in the top-level
//           `structured_output` field (NOT `.result`, which is a PROSE acknowledgment) — G1.
//   codex:  `exec --output-schema <FILE>` ("Path to a JSON Schema file…") forces the final agent_message
//           to be the validated JSON — G2. A build lacking the flag falls back to prompt-coaxing.
// USAGE (budget): usage(stdout) -> total tokens this call (claude json usage.*, codex token-count events),
// or undefined when it can't be parsed. agent() accumulates it into ctx.tokensSpent for budget.remaining().

import { writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// claude's --effort accepts these levels (confirmed via `claude -p --help`). We pass the agent's
// opts.effort straight through after validating it against this set.
export const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// ── known agentType -> a system block (claude --append-system-prompt / codex prompt prefix) ──────────
// A small map of the agent types the corpus uses (verified: 'Explore', 'general-purpose'). Unknown types
// fall through to the default (agent() logs a warning). claude ALSO supports --agents/--agent natively,
// but an injected system block is portable across both harnesses and avoids defining a full agent json.
export const AGENT_TYPE_BLOCKS = {
  Explore: 'You are an EXPLORE agent: investigate read-only. Read files, search, and run read-only commands to map the territory. Do NOT modify files, do NOT run mutating commands. Return a thorough, well-cited findings report.',
  'general-purpose': '', // the default agent; no extra system block.
}
function agentTypeBlock(agentType) {
  if (!agentType) return ''
  return Object.prototype.hasOwnProperty.call(AGENT_TYPE_BLOCKS, agentType) ? AGENT_TYPE_BLOCKS[agentType] : ''
}

// A scratch dir to drop codex's --output-schema temp files when no run memDir is available.
function schemaDir(ctx) {
  if (ctx && ctx.memDir) { const d = join(ctx.memDir, 'schemas'); try { mkdirSync(d, { recursive: true }) } catch { /* fall through */ } return d }
  return mkdtempSync(join(tmpdir(), 'blitz-schema-'))
}

// Detect `codex exec --output-schema` support ONCE per process (the flag is recent; older builds lack it).
let _codexOutputSchema // undefined = unprobed; true/false after.
function codexSupportsOutputSchema() {
  if (_codexOutputSchema !== undefined) return _codexOutputSchema
  _codexOutputSchema = false
  try {
    const help = String(execFileSync('codex', ['exec', '--help'], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }) || '')
    _codexOutputSchema = /--output-schema/.test(help)
  } catch { _codexOutputSchema = false } // codex not runnable / no help -> assume no, use the coax fallback.
  return _codexOutputSchema
}
/** Test hook: force the codex --output-schema support flag (true/false), or undefined to re-probe. */
export function _setCodexOutputSchemaSupport(v) { _codexOutputSchema = v }

// ── codex --output-schema needs an OpenAI-STRICT schema ──────────────────────────────────────────────
// codex's `--output-schema` enforces OpenAI strict structured outputs: EVERY object must set
// additionalProperties:false AND list EVERY property in `required`. Claude-authored corpus schemas are
// LENIENT (optional fields), so codex 400s with `invalid_json_schema` (verified live, codex 0.139.0).
// strictifyForCodex() recursively coerces ANY schema to the strict shape and makes originally-OPTIONAL
// fields NULLABLE (the OpenAI-documented way to keep them optional under strict mode). The leaf may then
// return null for an omitted optional; stripNulls() (below) drops those so the result still validates
// against the author's ORIGINAL lenient schema. Claude's --json-schema is lenient, so this is codex-only.
function _strictNullable(child) {
  if (!child || typeof child !== 'object') return child
  if (Array.isArray(child.type)) return child.type.includes('null') ? child : { ...child, type: [...child.type, 'null'] }
  if (typeof child.type === 'string') return { ...child, type: [child.type, 'null'] }
  return { anyOf: [child, { type: 'null' }] } // no explicit type ($ref/anyOf/etc.) -> union with null
}
export function strictifyForCodex(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(strictifyForCodex)
  const out = { ...schema }
  if (out.type === 'object' || out.properties) {
    out.additionalProperties = false
    const props = out.properties || {}
    const keys = Object.keys(props)
    const origReq = new Set(Array.isArray(out.required) ? out.required : [])
    out.required = keys
    const np = {}
    for (const k of keys) { let c = strictifyForCodex(props[k]); if (!origReq.has(k)) c = _strictNullable(c); np[k] = c }
    out.properties = np
  }
  if (out.items) out.items = strictifyForCodex(out.items)
  if (out.$defs) { const d = {}; for (const k of Object.keys(out.$defs)) d[k] = strictifyForCodex(out.$defs[k]); out.$defs = d }
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(strictifyForCodex)
  if (Array.isArray(out.oneOf)) out.oneOf = out.oneOf.map(strictifyForCodex)
  return out
}
// Drop null-valued keys recursively so a strict-mode null for an originally-optional field reads as
// "omitted" and the result validates against the ORIGINAL lenient schema.
// TODO(blitz): a schema that EXPLICITLY makes a REQUIRED field nullable would lose a legitimate null here;
// no corpus schema does this, so revisit only if one appears (then thread the original schema in to be precise).
export function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v)) { if (v[k] === null) continue; out[k] = stripNulls(v[k]) }
    return out
  }
  return v
}

export const harnesses = {
  // ── claude: `claude -p <prompt> --output-format json [--model …] [--effort …]` ──────────────
  // print mode (-p) makes the run non-interactive and lands the final text on stdout. We use
  // --output-format json (a SINGLE result object) because its `.result` field is the clean final
  // assistant text — far more robust than scraping plain-text stdout. --dangerously-skip-permissions
  // so a leaf that legitimately needs a tool (read a file, run a command) is not blocked mid-run.
  claude: {
    build(prompt, opts = {}) {
      const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions']
      claudeApplyModelEffort(args, opts)
      claudeApplyAgentType(args, opts)
      return { cmd: 'claude', args, env: {} }
    },
    // --output-format json prints exactly one JSON object whose `.result` is the final text.
    // If a leaf streamed extra lines, take the LAST parseable JSON line that carries a result.
    parse(stdout) {
      const text = String(stdout ?? '')
      // Fast path: the whole stdout is the single result object.
      const whole = tryJson(text.trim())
      if (whole && typeof whole.result === 'string') return whole.result
      // Fallback: scan lines bottom-up for the last object with a string `result`.
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const obj = tryJson(lines[i].trim())
        if (obj && typeof obj.result === 'string') return obj.result
      }
      // Last resort: return the raw stdout trimmed (better than throwing on an unexpected shape).
      return text.trim()
    },

    // ── STRUCTURED OUTPUT (native, G1) ────────────────────────────────────────────────────────────
    // `--json-schema <schema> --output-format json` makes claude run its StructuredOutput tool and put
    // the VALIDATED OBJECT in the top-level `structured_output` field (`.result` stays a prose ack).
    buildStructured(prompt, opts = {}, schema /*, ctx */) {
      const args = ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--dangerously-skip-permissions']
      claudeApplyModelEffort(args, opts)
      claudeApplyAgentType(args, opts)
      return { cmd: 'claude', args, env: {} }
    },
    // Read `structured_output` (NOT `.result`). Fast path = the whole stdout object; else scan bottom-up
    // for the last object carrying a structured_output. Returns the object, or null when absent (agent()
    // then re-prompts / gives up to null).
    parseStructured(stdout) {
      const text = String(stdout ?? '')
      const whole = tryJson(text.trim())
      if (whole && whole.structured_output !== undefined && whole.structured_output !== null) return whole.structured_output
      const lines = text.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const obj = tryJson(lines[i].trim())
        if (obj && obj.structured_output !== undefined && obj.structured_output !== null) return obj.structured_output
      }
      return null
    },

    // Total tokens this call, from the result object's usage{} (input+output+cache_*), for budget.
    usage(stdout) { return claudeUsageTokens(stdout) },
  },

  // ── codex: `codex exec <prompt> -c model=… -c model_reasoning_effort=… --json …` ─────────────
  // `codex exec` runs one non-interactive turn and prints the agent output to stdout. Plain stdout
  // is noisy (status/reasoning lines), so we use --json (JSONL events) and pull the final
  // agent_message text. --dangerously-bypass-approvals-and-sandbox + --skip-git-repo-check match
  // the repo's existing serverless codex path and let a leaf actually do work without prompting.
  codex: {
    build(prompt, opts = {}) {
      const block = agentTypeBlock(opts.agentType)
      const fullPrompt = block ? `${block}\n\n${prompt}` : prompt
      const args = ['exec', fullPrompt, '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
      // codex overrides go through `-c key=<TOML value>`; strings must be quoted in the value.
      if (opts.model) args.push('-c', `model=${tomlString(String(opts.model))}`)
      if (opts.effort != null) args.push('-c', `model_reasoning_effort=${tomlString(String(opts.effort))}`)
      return { cmd: 'codex', args, env: {} }
    },
    // --json emits JSONL. The final assistant text is the last `agent_message` event. Confirmed shape:
    //   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
    // Older/alternate builds emit a flatter {"type":"agent_message","message":"…"}; handle both.
    parse(stdout) {
      return codexAgentMessage(stdout)
    },

    // ── STRUCTURED OUTPUT (native --output-schema, G2; prompt-coax fallback) ───────────────────────
    // Native: write the schema to a temp file under the run's memDir + pass `--output-schema <path>`,
    // which forces codex's final agent_message to be the validated JSON. If the build lacks the flag,
    // fall back to coaxing JSON via the prompt (agent() then parses the first JSON object + validates).
    buildStructured(prompt, opts = {}, schema, ctx) {
      const native = codexSupportsOutputSchema()
      const block = agentTypeBlock(opts.agentType)
      let fullPrompt = block ? `${block}\n\n${prompt}` : prompt
      let schemaArgs = []
      if (native) {
        const tag = ctx && Number.isInteger(ctx.jIndex) ? ctx.jIndex : Date.now()
        const file = join(schemaDir(ctx), `${tag}.json`)
        // STRICTIFY: codex's --output-schema rejects lenient (optional-field) schemas with a 400; coerce.
        writeFileSync(file, JSON.stringify(strictifyForCodex(schema), null, 2))
        schemaArgs = ['--output-schema', file]
      } else {
        // FALLBACK: ask for ONLY a JSON object/value matching the schema, no prose/fences.
        fullPrompt += `\n\nRespond with ONLY a JSON value matching this JSON Schema. No prose, no markdown fences:\n${JSON.stringify(schema)}`
      }
      const args = ['exec', fullPrompt, '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', ...schemaArgs]
      if (opts.model) args.push('-c', `model=${tomlString(String(opts.model))}`)
      if (opts.effort != null) args.push('-c', `model_reasoning_effort=${tomlString(String(opts.effort))}`)
      return { cmd: 'codex', args, env: {} }
    },
    // Both the native path (agent_message IS the validated JSON) and the coax fallback land the JSON in
    // the final agent_message; pull it + JSON.parse it. Returns the object or null (agent() validates).
    parseStructured(stdout) {
      const msg = codexAgentMessage(stdout)
      if (msg == null) return null
      // stripNulls: an originally-optional field made nullable for strict mode may come back null -> drop it
      // so the result validates against the author's ORIGINAL lenient schema.
      try { return stripNulls(JSON.parse(String(msg).trim())) } catch { /* coaxed text may wrap it -> scan below */ }
      // Lenient: strip fences / find the first balanced JSON (agent() also has a coax scanner, but keep
      // parseStructured self-sufficient for the fallback path).
      const fenced = String(msg).match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fenced) { try { return stripNulls(JSON.parse(fenced[1].trim())) } catch { /* fall through */ } }
      return null
    },

    // Total tokens this call, summed from codex's token-count / usage events, for budget.
    usage(stdout) { return codexUsageTokens(stdout) },
  },

  // ── extension points ────────────────────────────────────────────────────────────────────────
  // TODO(blitz): implement 'pi' once its non-interactive CLI + final-text extraction are confirmed.
  pi: {
    build() { throw new Error("blitz llm: harness 'pi' is not implemented yet (stub)") },
    parse(stdout) { return String(stdout ?? '').trim() },
  },
  // TODO(blitz): implement 'opencode' (e.g. `opencode run <prompt>`) once its flags + output shape
  // are confirmed against the real CLI, then map opts.model/opts.effort and parse the final text.
  opencode: {
    build() { throw new Error("blitz llm: harness 'opencode' is not implemented yet (stub)") },
    parse(stdout) { return String(stdout ?? '').trim() },
  },
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
function tryJson(s) {
  if (!s) return null
  try { return JSON.parse(s) } catch { return null }
}

// Quote a string as a TOML scalar for `-c key=value`. codex parses the value as TOML and falls
// back to a literal on failure; an explicitly quoted string is unambiguous and escapes safely.
function tomlString(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

// ── claude flag helpers (shared by build + buildStructured) ──────────────────────────────────────
function claudeApplyModelEffort(args, opts) {
  // opts.model -> --model (an alias like 'opus'/'sonnet'/'haiku' or a full model name).
  if (opts.model) args.push('--model', String(opts.model))
  // opts.effort -> --effort (low|medium|high|xhigh|max). Validate so a typo fails loudly here rather
  // than the child rejecting it after a slow startup.
  if (opts.effort != null) {
    const eff = String(opts.effort)
    if (!CLAUDE_EFFORTS.has(eff)) {
      throw new Error(`blitz agent: invalid claude effort ${JSON.stringify(eff)} (expected one of ${[...CLAUDE_EFFORTS].join('|')})`)
    }
    args.push('--effort', eff)
  }
}
// opts.agentType -> a system block via --append-system-prompt (portable; an unknown type adds nothing).
function claudeApplyAgentType(args, opts) {
  const block = agentTypeBlock(opts.agentType)
  if (block) args.push('--append-system-prompt', block)
}

// claude --output-format json carries usage{input_tokens,output_tokens,cache_creation_input_tokens,
// cache_read_input_tokens}. Sum them for a budget total; undefined when no usage object is present.
function claudeUsageTokens(stdout) {
  const text = String(stdout ?? '')
  let o = tryJson(text.trim())
  if (!o || !o.usage) {
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) { const x = tryJson(lines[i].trim()); if (x && x.usage) { o = x; break } }
  }
  const u = o && o.usage
  if (!u || typeof u !== 'object') return undefined
  let total = 0, any = false
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (typeof u[k] === 'number') { total += u[k]; any = true }
  }
  return any ? total : undefined
}

// ── codex output helpers (shared by parse + parseStructured) ─────────────────────────────────────
// The final agent_message text across codex JSONL shapes (item.completed wrapper + flat fallbacks).
function codexAgentMessage(stdout) {
  const lines = String(stdout ?? '').split('\n')
  let last = null
  for (const line of lines) {
    const ev = tryJson(line.trim())
    if (!ev) continue
    if (ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') { last = ev.item.text; continue }
    if (ev.type === 'agent_message') {
      if (typeof ev.text === 'string') last = ev.text
      else if (typeof ev.message === 'string') last = ev.message
    }
  }
  return last != null ? last : (String(stdout ?? '').trim() || null)
}
// Sum codex token usage from JSONL events. Codex reports usage on turn.completed (usage{input_tokens,
// output_tokens,…}) and/or token_count events; tolerate both. undefined when none present.
function codexUsageTokens(stdout) {
  const lines = String(stdout ?? '').split('\n')
  let total = 0, any = false
  const add = (u) => {
    if (!u || typeof u !== 'object') return
    for (const k of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_read_input_tokens', 'reasoning_output_tokens']) {
      if (typeof u[k] === 'number') { total += u[k]; any = true }
    }
    if (typeof u.total_tokens === 'number' && !any) { total += u.total_tokens; any = true }
  }
  for (const line of lines) {
    const ev = tryJson(line.trim())
    if (!ev) continue
    if (ev.usage) add(ev.usage)
    else if (ev.type === 'token_count' || ev.type === 'token.count') add(ev)
    else if (ev.item && ev.item.usage) add(ev.item.usage)
  }
  return any ? total : undefined
}
