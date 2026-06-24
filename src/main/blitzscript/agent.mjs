// blitzscript — agent(): the leaf + resource layer (RENAMED from llm.mjs).
//
// A blitzscript workflow's ONE injected primitive for delegating intelligence:
//
//   const text = await agent('summarize this slice…', { harness: 'claude', model: 'haiku' })
//   const obj  = await agent('extract people', { schema: PERSON_SCHEMA })   // structured output
//
// agent() SPAWNS a local headless coding-agent process on this machine (claude -p / codex exec — see
// harnesses.mjs), captures its stdout, and returns either the final assistant TEXT (no schema) or a
// schema-valid OBJECT (with `opts.schema`, validated + retried, null after retries). It is the single
// chokepoint the runtime owns. `llm` is kept as a deprecated alias (export const llm = agent).
//
// Guardrails (cost/recursion, NOT security — see plans/blitzos-blitzscript.md):
//   1. Depth is TOLD to the leaf, not gated. A metadata block is APPENDED to the prompt stating the
//      leaf's depth, the no-recurse rule, and the act-vs-ask boundary; BLITZ_DEPTH is set on the child
//      env (propagation/labeling). main does NOT refuse recursion; we observe instead.
//   2. Concurrency is self-capped by a PROCESS-GLOBAL counting semaphore on the resource (the leaf is a
//      heavy process, not an API call), so a wide fan-out never spawns more than min(16, cores-2) leaves
//      AT ONCE — across ALL concurrent runs (that is why it stays module-global, not per-run).
//
// ── G4 RunContext (the one architectural change) ──────────────────────────────────────────────────
// All PER-RUN state (the journal index/array/divergence point, the call counter, memDir, depth, args,
// budget/tokensSpent, current phase) lives in a RunContext threaded via AsyncLocalStorage, NOT module
// globals. runtime.mjs's runWorkflow() creates a fresh RunContext per run and runs the whole body under
// withRunContext(); a nested workflow() gets its OWN context (own journal/index/calls). Calling agent()
// OUTSIDE any runWorkflow (the existing unit tests, library scripts) uses a lazily-created DEFAULT
// context, so back-compat is preserved (the _resetJournal test hook resets that default context).
//
// opts: { harness?, model?, effort?, cwd?, retries?, schema?, label?, phase?, agentType?, isolation? }.
//   schema    — JSON-Schema for structured output (claude --json-schema reading structured_output; codex
//               --output-schema tmpfile; prompt-coax fallback). Returns the validated object or null.
//   label/phase — display/grouping for the progress sink (opts.phase overrides ctx.phase).
//   agentType — claude --agents/--agent (a known-type system block) / codex appended system block.
//   isolation:'worktree' — run the leaf in a fresh `git worktree` under ctx.memDir (thin; spec-only).
// The spawner is INJECTABLE via _setSpawn so unit tests never hit a real LLM.

import { spawn, execFileSync } from 'node:child_process'
import os, { tmpdir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { harnesses } from './harnesses.mjs'
import { validate as validateSchema, stubFromSchema } from './schema.mjs'
import { emitProgress, currentGroup, previewOf } from './progress.mjs'

// ── concurrency cap (PROCESS-GLOBAL — bounds the resource across ALL runs) ───────────────────────
// Each leaf is a heavy PROCESS (model/config startup costs seconds), not an API call, so a wide
// fan-out must be bounded on the RESOURCE. Ceiling 8 (was 16): the real limit for live `claude` leaves is
// the account's RATE LIMIT, not CPU cores — a wider burst just trips 429/overload (the bug-1 failure class).
// Still scales DOWN on small machines via min(8, max(2, cores-2)) so a low-core box never oversubscribes.
export const MAX_CONCURRENCY = Math.min(8, Math.max(2, os.cpus().length - 2))

let _active = 0          // leaves currently running (across all runs)
const _waiters = []      // FIFO queue of resolvers waiting for a free slot

function _acquire() {
  if (_active < MAX_CONCURRENCY) { _active++; return Promise.resolve() }
  return new Promise((resolve) => _waiters.push(resolve))
}
function _release() {
  const next = _waiters.shift()
  if (next) next()          // hand the slot straight to the next waiter (keeps _active steady)
  else _active--
}

// ── the per-run context (G4/G6) ──────────────────────────────────────────────────────────────────
// Everything that was module-global in llm.mjs lives here so concurrent/nested runs never collide.
const PER_RUN_CALL_CAP = 1000        // agent() calls per RUN (G6); the dry-run path has its OWN cap.

export class RunContext {
  constructor({ memDir = null, depth = 0, args = undefined, budget = null, phase = null, defaultModel = undefined, runId = null, dry = false } = {}) {
    this.dry = !!dry                     // per-run dry preflight (no spawn; emits the skeleton). Race-free vs env.
    this.memDir = memDir || null
    this.depth = Number.isFinite(Number(depth)) ? Number(depth) : 0
    this.args = args
    this.budget = budget                 // a frozen budget object (runtime.makeBudget) or null
    this.defaultModel = defaultModel     // meta.model — the per-workflow model default
    this.phase = phase                   // current phase title (set by phase())
    this.runId = runId != null ? String(runId) : null  // the externalization run id (telemetry routing); null off-host
    this.groupSeq = 0                    // monotonic fan-out group counter (parallel/pipeline emit g0,g1,…)

    // journaling (edge-result memoization for resume) — was _jIndex/_journal/_divergedAt
    this.jIndex = 0                      // next invocation index (assigned at the deterministic start of each agent() body)
    this.journal = null                  // lazily-loaded: journal[i] = { hash, result } | undefined
    this.divergedAt = Infinity           // first index that diverged -> it + everything after re-run

    // counters — was _calls
    this.calls = 0                       // real agent() calls this RUN (caps at PER_RUN_CALL_CAP)
    this.dryCalls = 0                    // dry-run-only counter (separate ceiling; never bleeds into .calls)
    this.tokensSpent = 0                 // accumulated from each harness's parsed usage (for budget)
  }

  journalPath() { return this.memDir ? join(this.memDir, 'journal.jsonl') : null }

  loadJournal() {
    if (this.journal !== null) return
    this.journal = []
    const p = this.journalPath()
    if (!p || !existsSync(p)) return
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const s = line.trim(); if (!s) continue
        const e = JSON.parse(s)
        if (e && Number.isInteger(e.i) && typeof e.hash === 'string') this.journal[e.i] = { hash: e.hash, result: e.result }
      }
    } catch { /* a corrupt journal -> treat as empty (safe: everything re-runs) */ }
  }

  // Returns the cached entry for an unchanged prefix, or null; a miss/mismatch marks the divergence point.
  journalHit(i, hash) {
    if (!this.memDir) return null
    this.loadJournal()
    if (i < this.divergedAt && this.journal[i] && this.journal[i].hash === hash) return this.journal[i]
    if (i < this.divergedAt) this.divergedAt = i
    return null
  }

  // Record a SUCCESSFUL result, written SYNCHRONOUSLY so it is durable before agent() resolves.
  journalRecord(i, hash, result) {
    if (!this.memDir) return
    this.journal[i] = { hash, result }
    try {
      const lines = []
      for (let k = 0; k < this.journal.length; k++) { const e = this.journal[k]; if (e) lines.push(JSON.stringify({ i: k, hash: e.hash, result: e.result })) }
      writeFileSync(this.journalPath(), lines.length ? lines.join('\n') + '\n' : '')
    } catch { /* best-effort persistence */ }
  }

  stats() {
    return { calls: this.calls, tokensSpent: this.tokensSpent, depth: this.depth, jIndex: this.jIndex }
  }
}

// The AsyncLocalStorage that scopes the active RunContext through any depth of parallel/pipeline nesting.
const _runStore = new AsyncLocalStorage()

// The DEFAULT context used when agent() is called OUTSIDE runWorkflow (unit tests, legacy library scripts
// run as plain Node where the file imports agent/llm directly). In the legacy contract memDir/depth come
// from process.env and are read LIVE on every call (a standalone `node wf.mjs` can set BLITZ_MEM_DIR /
// BLITZ_DEPTH mid-process and the next agent() reflects it — the old llm() read env each call). Under a
// real RunContext (runWorkflow), depth/memDir come from ctx and env is NOT consulted.
let _defaultCtx = null
function _refreshDefaultCtxFromEnv(ctx) {
  ctx.memDir = process.env.BLITZ_MEM_DIR || null
  const d = Number(process.env.BLITZ_DEPTH || 0)
  ctx.depth = Number.isFinite(d) ? d : 0
  // A changed memDir invalidates the lazily-loaded journal (re-read from the new dir on next access).
  if (ctx.memDir !== ctx._loadedMemDir) { ctx.journal = null; ctx.divergedAt = Infinity; ctx._loadedMemDir = ctx.memDir }
}
function getRunContext() {
  const ctx = _runStore.getStore()
  if (ctx) return ctx
  if (!_defaultCtx) { _defaultCtx = new RunContext({}); _defaultCtx._isDefault = true; _defaultCtx._loadedMemDir = null }
  _refreshDefaultCtxFromEnv(_defaultCtx)
  return _defaultCtx
}
/** Run `fn` with `ctx` as the ambient RunContext (used by runtime.runWorkflow / workflow()). */
export function withRunContext(ctx, fn) { return _runStore.run(ctx, fn) }
export { getRunContext }

/** Read-only counters, for tests + self-pacing. Reads the ACTIVE run's context (or the default). */
export function _stats() {
  const ctx = getRunContext()
  return { active: _active, calls: ctx.calls, waiting: _waiters.length, maxConcurrency: MAX_CONCURRENCY }
}

/** Test hook: clear the DEFAULT in-process context (simulate a fresh process; the journal FILE persists).
 *  Also resets the process-global semaphore counters. runWorkflow contexts are unaffected (they are fresh). */
export function _resetJournal() { _defaultCtx = null; _active = 0; _waiters.length = 0 }

// ── the leaf-prompt metadata block (the plan's guardrail #1 + #5) ──────────────────────────────
export function leafMetadata(depth) {
  return [
    '',
    '---',
    `[blitzscript runtime metadata — depth ${depth}]`,
    'You are a leaf agent inside a blitzscript workflow. Do NOT recurse: no `blitz run`, no spawning sub-agents. Answer the task directly.',
    'Permissions: do everything reversible on your own; ask ONLY before a destructive or irreversible act (messaging or posting as the user, force pushing, deleting, deploying, spending).',
    'Return a concise, structured result and stop.',
    '---',
  ].join('\n')
}

// ── model alias resolution (cheap | strong | default) ────────────────────────────────────────────
const _MODEL_ALIASES = new Set(['cheap', 'strong', 'default'])
const _CLAUDE_ALIAS_FALLBACK = { cheap: 'haiku', strong: 'opus' } // mirrors capabilities.mjs probeClaude
let _caps                       // undefined = not loaded; null = none found; else the parsed caps object
const _capsFile = () => process.env.BLITZ_CAPS_FILE || join(os.homedir(), '.blitzos', 'blitz-caps.json')
function _loadCaps() {
  if (_caps !== undefined) return _caps
  _caps = null
  try { _caps = JSON.parse(readFileSync(_capsFile(), 'utf8')) } catch { /* no cache yet -> built-in fallbacks */ }
  return _caps
}
/** Resolve opts.model for a harness: a concrete id passes through; 'cheap'/'strong'/'default' map via the
 *  caps cache (then claude's built-in fallback); anything unresolved => undefined (omit --model). */
function _resolveModel(harnessName, model) {
  if (model == null || model === '') return undefined
  const alias = String(model).toLowerCase()
  if (!_MODEL_ALIASES.has(alias)) return String(model) // a real model id/alias -> as-is
  if (alias === 'default') return undefined
  const h = _loadCaps()?.harnesses?.[harnessName]
  if (h && typeof h[alias] === 'string' && h[alias]) return h[alias] // the SAME pick the agent was shown
  if (harnessName === 'claude') return _CLAUDE_ALIAS_FALLBACK[alias]
  return undefined // codex/other with no cache -> omit -> the harness's configured default
}
/** Test hook: inject (obj) or clear (undefined) the in-process capabilities cache. */
export function _setCaps(obj) { _caps = obj }

// ── budget overflow signal ───────────────────────────────────────────────────────────────────────
// Thrown by agent() when a budget is set and exceeded; parallel/pipeline catch it -> that slot -> null.
export class WorkflowBudgetExceededError extends Error {
  constructor(msg) { super(msg); this.name = 'WorkflowBudgetExceededError' }
}

// ── the injectable spawner ─────────────────────────────────────────────────────────────────────
// Resolves with the child's stdout string (rejects on spawn error / non-zero exit). stdin is 'ignore'
// so codex (which appends piped stdin to the prompt) doesn't absorb the parent's stdin.
async function _defaultSpawn(cmd, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      cwd: cwd || undefined,            // opts.cwd — run the leaf in a given dir (e.g. a git worktree)
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`blitz agent: failed to spawn ${cmd}: ${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) return resolve(out)
      // Surface BOTH streams on failure: claude prints its error JSON on stdout (--output-format json)
      // and codex reports an inaccessible-model 400 as a JSONL error event on STDOUT, so stderr alone
      // gives the uninformative "exited 1". Include a trimmed tail of each so callers get the real reason.
      const tail = (s) => { s = String(s).trim(); return s.length > 1200 ? '…' + s.slice(-1200) : s }
      const detail = [err && tail(err), out && tail(out)].filter(Boolean).join('\n')
      reject(new Error(`blitz agent: ${cmd} exited ${code}${detail ? `\n${detail}` : ''}`))
    })
  })
}

// Override point for tests. `_spawn(cmd, args, env, cwd) -> Promise<stdout string>`.
export let _spawn = _defaultSpawn
export function _setSpawn(fn) { _spawn = fn || _defaultSpawn }

// ── journal hash (G5.3): fold the output-affecting opts in so resume invalidates on a change ──────
const _hashCall = (harness, model, effort, agentType, schema, prompt) =>
  createHash('sha256')
    .update(`${harness}\0${model || ''}\0${effort || ''}\0${agentType || ''}\0${schema ? JSON.stringify(schema) : ''}\0${prompt}`)
    .digest('hex')

// ── isolation: a thin git-worktree wrapper for a mutating leaf (spec-only; 0 corpus uses) ─────────
// Creates a fresh worktree at <ctx.memDir>/worktrees/<tag> on HEAD, runs `fn(cwd)`, removes it (force on
// failure). Falls back to the given cwd if git/worktree is unavailable (never hard-fail the leaf on setup).
async function _withWorktree(ctx, tag, baseCwd, fn) {
  const root = ctx.memDir ? join(ctx.memDir, 'worktrees') : mkdtempSync(join(tmpdir(), 'blitz-wt-'))
  let wt
  try {
    mkdirSync(root, { recursive: true })
    wt = join(root, String(tag).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'wt')
    execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], { cwd: baseCwd || process.cwd(), stdio: 'ignore' })
  } catch (e) {
    // worktree setup failed (not a git repo, dirty tree, etc.) — run in the original cwd instead.
    return fn(baseCwd)
  }
  try {
    return await fn(wt)
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: baseCwd || process.cwd(), stdio: 'ignore' }) } catch { /* best-effort cleanup */ }
  }
}

/**
 * Run one leaf agent and return its final assistant text — OR a schema-valid object when opts.schema is set.
 *
 * @param {string} prompt   The task for the leaf (metadata is appended automatically).
 * @param {{harness?:string, model?:string, effort?:string, cwd?:string, retries?:number,
 *          schema?:object, label?:string, phase?:string, agentType?:string, isolation?:string}} [opts]
 * @param {*} [fallback]     Returned INSTEAD of spawning under `blitz check` (BLITZ_DRY_RUN) for the TEXT
 *                           path. With a schema, dry-run returns stubFromSchema(schema) instead.
 * @returns {Promise<string|object|null>}  text (no schema) | validated object (schema) | null (schema retries exhausted)
 */
// ── per-leaf capture (OPT-IN via BLITZ_CAPTURE_LEAVES; e.g. the kanban lab) ──────────────────────
// Additive telemetry for a drill-in view: writes each leaf's prompt + typed result + claude session_id
// (→ its full rollout under ~/.claude/projects) to <memDir>/leaves/<nodeId>.json. Best-effort + guarded.
// OFF by default — the product run path is byte-for-byte unchanged when the env is unset.
function _tryJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}
function _sessionIdFrom(stdout) {
  const text = String(stdout || '')
  const whole = _tryJson(text.trim())
  if (whole && whole.session_id) return String(whole.session_id)
  const lines = text.split('\n')
  for (let k = lines.length - 1; k >= 0; k--) {
    const o = _tryJson(lines[k].trim())
    if (o && o.session_id) return String(o.session_id)
  }
  return ''
}
// The prose acknowledgment (the harness's FINAL assistant text) — a human one-liner of what the leaf did. For a
// schema leaf this sits BESIDE structured_output (harness.parse → `.result`); for a text leaf it equals the result.
function _leafSummary(harness, stdout, out) {
  try {
    if (harness && typeof harness.parse === 'function') {
      const s = String(harness.parse(stdout) || '').trim()
      if (s) return s
    }
  } catch {
    /* best-effort */
  }
  return typeof out === 'string' ? out : ''
}
function captureLeaf(memDir, rec) {
  // Default OFF when unset; ON for any value EXCEPT the explicit disables '0' / 'false' / '' (note: the bare
  // string '0' is TRUTHY in JS, so `!env` would wrongly capture on '0' — check the disables explicitly).
  const cap = process.env.BLITZ_CAPTURE_LEAVES
  if (!cap || cap === '0' || cap === 'false' || !memDir) return
  try {
    const dir = join(memDir, 'leaves')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, rec.nodeId + '.json'), JSON.stringify(rec))
  } catch {
    /* never break a run on a capture write */
  }
}

// ── auto-wrap structured output with a human summary (the default meta seam) ──────────────────────
// EVERY structured leaf (an agent() with a `schema`) is ALSO required to return a concise, human-readable
// one-liner of what it did, under `meta.human_summary` — SEPARATE from the `output` it was meant to submit. The
// kanban card + drawer show that summary (no JSON soup, no per-leaf prose parsing); agent() UNWRAPS and returns
// just `output`, so workflow code is unchanged. The author's schema is nested under `output`; both are required.
const HUMAN_SUMMARY_DESC =
  "A concise, ONE-sentence, human-readable summary of what you just did and concluded — plain language for a person, NOT JSON or jargon. Shown to the user as this step's headline."
function wrapSchemaWithSummary(schema) {
  return {
    type: 'object',
    properties: {
      meta: { type: 'object', properties: { human_summary: { type: 'string', description: HUMAN_SUMMARY_DESC } }, required: ['human_summary'] },
      output: schema
    },
    required: ['meta', 'output']
  }
}
// The prompt note injected for a structured leaf so it knows to produce the wrapper (belt-and-suspenders with the
// schema's own required field + description). Kept OUT of the resume hash (the cache key uses the bare schema).
const SUMMARY_WRAP_NOTE =
  '\n\n[Response wrapper] Return a top-level object of EXACTLY this shape: { "meta": { "human_summary": "<one concise plain-language sentence describing what you just did and concluded, written for a human>" }, "output": <your actual result matching the required output schema> }. The human_summary is the user-facing headline for this step; `output` is your real deliverable.'

export async function agent(prompt, opts = {}, fallback = undefined) {
  if (typeof prompt !== 'string') throw new Error('blitz agent: prompt must be a string')
  const ctx = getRunContext()
  // Operator override seam (env WINS over a script's own opts) so ANY workflow can be exercised against a
  // chosen backend WITHOUT editing it — e.g. run the canonical Claude-authored corpus against codex with
  // `BLITZ_HARNESS=codex BLITZ_MODEL=cheap`. All three unset = the script's opts (the normal path) decide.
  const harnessName = process.env.BLITZ_HARNESS || opts.harness || 'claude'
  const harness = harnesses[harnessName]
  if (!harness) {
    throw new Error(`blitz agent: unknown harness ${JSON.stringify(harnessName)} (known: ${Object.keys(harnesses).join(', ')})`)
  }

  // The leaf's own depth = the orchestrator's depth + 1 (read from ctx, NOT process.env — G4).
  const depth = ctx.depth + 1
  const fullPrompt = prompt + leafMetadata(depth)

  // Resolve a model ALIAS, falling back to the workflow's meta.model default when opts.model is absent.
  // BLITZ_MODEL (when set) wins over the script's opts.model so a forced cross-harness run never feeds codex
  // a claude-only id (haiku/sonnet/opus); BLITZ_EFFORT likewise clamps a script's claude-only effort (max).
  const forcedModel = process.env.BLITZ_MODEL
  const model = _resolveModel(harnessName, forcedModel != null && forcedModel !== ''
    ? forcedModel
    : (opts.model != null && opts.model !== '' ? opts.model : ctx.defaultModel))
  const effort = process.env.BLITZ_EFFORT || opts.effort
  const agentType = opts.agentType
  const schema = opts.schema
  // The schema actually SENT to the leaf + validated: the author's schema auto-wrapped with meta.human_summary
  // (see wrapSchemaWithSummary). agent() returns the unwrapped `output`; the hash/dry-stub use the bare `schema`.
  const effectiveSchema = schema ? wrapSchemaWithSummary(schema) : null

  // Stable invocation index — assigned at the (deterministic, microtask-ordered) start of this agent()
  // body, the positional half of the journal key (G5).
  const i = ctx.jIndex++

  // DRY RUN (`blitz check`, or a per-run ctx.dry preflight): no spawn, no journal — return a stub/fallback. We DO
  // emit agent:start + agent:done, so a dry run is a COMPLETE instant skeleton (every leaf with its label + phase),
  // which a viz uses as a preflight to show the whole planned graph before anything runs. Own counter (G6).
  if (process.env.BLITZ_DRY_RUN || ctx.dry) {
    const cap = Number(process.env.BLITZ_DRY_MAX_CALLS || 5000)
    ctx.dryCalls++
    if (ctx.dryCalls > cap) throw new Error(`blitz check: agent() called ${ctx.dryCalls} times (> ${cap}) — likely an unbounded loop`)
    const out = schema ? stubFromSchema(schema) : fallback !== undefined ? fallback : '[blitz dry-run fallback: this agent() call had no 3rd-arg fallback]'
    emitProgress(ctx, { type: 'agent:start', nodeId: i, label: opts.label != null ? String(opts.label) : null, phaseId: opts.phase != null ? String(opts.phase) : ctx.phase, groupId: currentGroup(), model: model || undefined, harness: harnessName, prompt: fullPrompt })
    emitProgress(ctx, { type: 'agent:done', nodeId: i, status: schema && out === null ? 'null' : 'ok', ms: 0, tokens: 0, preview: previewOf(out) })
    return out
  }

  // Per-RUN lifetime cap (G6): real calls only, reset each runWorkflow.
  ctx.calls++
  if (ctx.calls > PER_RUN_CALL_CAP) {
    throw new Error(`blitz agent: call cap (${PER_RUN_CALL_CAP}) reached this run — a loop using budget.remaining() never terminates`)
  }

  // Budget gate: if a budget is set and already exhausted, signal (parallel/pipeline turn this into null).
  if (ctx.budget && typeof ctx.budget.remaining === 'function' && ctx.budget.remaining() <= 0) {
    throw new WorkflowBudgetExceededError('blitz agent: token budget exceeded')
  }

  // RESUME fast-forward: a matching unchanged-prefix journal entry returns its cached result, no spawn.
  const hash = _hashCall(harnessName, model, effort, agentType, schema, fullPrompt)
  // The externalization start event for this node (emitted on the real path AND on a resume fast-forward,
  // so the live viz stays complete across a resume). phaseId honors an explicit opts.phase, else the ambient.
  // Carry the leaf's prompt on agent:start so the board's drawer can show "Asked" while the leaf is still
  // RUNNING (the captured leaf file, with the prompt, only exists once it FINISHES). The dry skeleton's prompt
  // is unreliable for data-dependent leaves (its inputs are stubs) and can be missing if the preflight timed out.
  const startEv = { type: 'agent:start', nodeId: i, label: opts.label != null ? String(opts.label) : null, phaseId: opts.phase != null ? String(opts.phase) : ctx.phase, groupId: currentGroup(), model: model || undefined, harness: harnessName, prompt: fullPrompt }
  const cached = ctx.journalHit(i, hash)
  if (cached) {
    emitProgress(ctx, startEv)
    emitProgress(ctx, { type: 'agent:done', nodeId: i, status: 'ok', ms: 0, tokens: 0, preview: previewOf(cached.result) })
    return cached.result
  }

  // Build the spawn descriptor. build()/buildStructured() VALIDATE flags (e.g. claude effort), so bad
  // opts throw here. The structured path is DISTINCT (G1/G2): it forces the schema via the native flag.
  const buildOpts = { ...opts, model, effort, agentType }
  const usingStructured = !!schema && typeof harness.buildStructured === 'function'

  // SPAWN, retrying a transient failure up to opts.retries; for the schema path, ALSO re-prompt once with
  // the validator error appended on an invalid/missing structured result. Record ONLY on success.
  const retries = Math.max(0, Number(opts.retries) || 0)
  const schemaRetries = schema ? Math.max(1, Math.min(3, Number(opts.schemaRetries) || 1)) : 0

  let leafTokens = 0  // tokens parsed for THIS leaf (best-effort), surfaced on its agent:done event
  let leafStdout = '' // raw stdout of the last attempt (carries claude's session_id) — for BLITZ_CAPTURE_LEAVES
  let leafHumanSummary = '' // the structured meta.human_summary (the card headline), set on a schema-success parse
  const runOnce = async (cwd, extraNote) => {
    // A schema leaf gets the wrapper NOTE appended + the WRAPPED schema (meta.human_summary + output). Text leaves
    // are unchanged. The note is OUTSIDE the resume hash (hash uses the bare schema/prompt).
    const base = (schema ? fullPrompt + SUMMARY_WRAP_NOTE : fullPrompt) + (extraNote || '')
    const built = usingStructured
      ? harness.buildStructured(base, buildOpts, effectiveSchema, ctx)
      : harness.build(base, buildOpts)
    const childEnv = { ...(built.env || {}), BLITZ_DEPTH: String(depth) }
    const stdout = await _spawn(built.cmd, built.args, childEnv, cwd)
    leafStdout = stdout
    // Accumulate token usage for budget (best-effort; harnesses expose usage() when they can parse it).
    if (typeof harness.usage === 'function') {
      try { const u = harness.usage(stdout); if (Number.isFinite(u)) { ctx.tokensSpent += u; leafTokens += u } } catch { /* best-effort */ }
    }
    return stdout
  }

  // Win a concurrency slot FIRST, THEN show the leaf as "running" and start its clock. Emitting agent:start
  // BEFORE _acquire painted EVERY leaf as running the instant it was created, so a 12-leaf fan-out looked like
  // 12 ran at once when only MAX_CONCURRENCY actually spawned and the rest were queued. Now the board's Doing
  // column reflects TRUE parallelism (<= MAX_CONCURRENCY); a leaf waiting for a slot stays 'queued' (the
  // skeleton's To-do card) until it acquires. `ms` is now work time, not work + queue-wait.
  await _acquire()
  emitProgress(ctx, startEv)
  const startedAt = Date.now()
  try {
    const exec = async (cwd) => {
      let lastErr
      // schema path: an extra outer loop re-prompts on an invalid/missing structured object.
      const schemaAttempts = schema ? schemaRetries + 1 : 1
      for (let sa = 0; sa < schemaAttempts; sa++) {
        const note = sa === 0 ? '' : `\n\nYour previous response did not match the required schema. Respond AGAIN with ONLY a value matching the schema. Validation errors: ${lastErr && lastErr.schemaErrors ? lastErr.schemaErrors.join('; ') : 'shape mismatch'}.`
        // inner loop: transient spawn-failure retries (opts.retries).
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const stdout = await runOnce(cwd, note)
            if (schema) {
              const wrapped = usingStructured ? harness.parseStructured(stdout) : _coaxJson(harness.parse(stdout))
              const v = validateSchema(wrapped, effectiveSchema)
              if (!v.ok) { const e = new Error('schema validation failed'); e.schemaErrors = v.errors; lastErr = e; break } // re-prompt (outer loop)
              // UNWRAP: agent() returns the author's `output`; meta.human_summary is the leaf's human headline.
              const obj = wrapped && typeof wrapped === 'object' && 'output' in wrapped ? wrapped.output : wrapped
              leafHumanSummary = wrapped && wrapped.meta && typeof wrapped.meta.human_summary === 'string' ? wrapped.meta.human_summary : ''
              ctx.journalRecord(i, hash, obj)
              return obj
            }
            const result = harness.parse(stdout)
            ctx.journalRecord(i, hash, result)
            return result
          } catch (e) { lastErr = e } // transient spawn failure -> retry inner; schema mismatch breaks to outer
        }
      }
      // A schema leaf soft-nulls ONLY on a genuine schema MISS — a model that RAN but could not emit a
      // schema-valid object after re-prompts (lastErr carries `.schemaErrors`, tagged at the validate site
      // above). A SPAWN/INFRA failure (a non-zero claude exit: a 404 for an inaccessible/over-capacity model,
      // an overload, any crash) has NO `.schemaErrors` and must FAIL LOUDLY — rethrow so the catch records
      // status:'error' with the real reason, instead of laundering it into the same status:'null'/result:null
      // a stubborn-but-valid model produces (the bug that silently no-opped 7 sonnet scouts).
      if (schema && lastErr && lastErr.schemaErrors) return null
      throw lastErr
    }
    const out = opts.isolation === 'worktree'
      ? await _withWorktree(ctx, opts.label || `i${i}`, opts.cwd, exec)
      : await exec(opts.cwd)
    // The leaf's human one-liner for the card / capture: the STRUCTURED meta.human_summary when the leaf had a
    // schema (authoritative, written by the agent for a human), else the harness's final prose (text leaves).
    const leafSummary = leafHumanSummary || _leafSummary(harness, leafStdout, out)
    // Self-describing terminal state for the captured leaf (bug 6): the engine KNOWS the result kind at this
    // exit, so TAG it once instead of making every reader sniff `typeof` + guess how many JSON.parse passes a
    // payload needs. A text leaf that emitted JSON also carries the pre-parsed object under `resultJson`.
    const resultKind = (out === null && schema) ? 'null' : (typeof out === 'string' ? 'text' : 'object')
    const resultJson = resultKind === 'text' ? _tryJson(out) : null
    emitProgress(ctx, { type: 'agent:done', nodeId: i, status: (out === null && schema) ? 'null' : 'ok', ms: Date.now() - startedAt, tokens: leafTokens, preview: previewOf(out), summary: leafSummary })
    captureLeaf(ctx.memDir, { nodeId: i, label: opts.label != null ? String(opts.label) : null, prompt: fullPrompt, model: model || '', harness: harnessName, phaseId: opts.phase != null ? String(opts.phase) : ctx.phase, groupId: currentGroup(), status: (out === null && schema) ? 'null' : 'ok', resultKind, ms: Date.now() - startedAt, tokens: leafTokens, result: out === undefined ? null : out, ...(resultJson != null ? { resultJson } : {}), summary: process.env.BLITZ_CAPTURE_LEAVES ? leafSummary : '', sessionId: _sessionIdFrom(leafStdout), ts: Date.now() })
    return out
  } catch (e) {
    emitProgress(ctx, { type: 'agent:done', nodeId: i, status: 'error', ms: Date.now() - startedAt, tokens: leafTokens, message: e && e.message ? e.message : String(e) })
    captureLeaf(ctx.memDir, { nodeId: i, label: opts.label != null ? String(opts.label) : null, prompt: fullPrompt, model: model || '', harness: harnessName, phaseId: opts.phase != null ? String(opts.phase) : ctx.phase, groupId: currentGroup(), status: 'error', resultKind: 'error', ms: Date.now() - startedAt, tokens: leafTokens, result: null, error: e && e.message ? e.message : String(e), sessionId: _sessionIdFrom(leafStdout), ts: Date.now() })
    throw e
  } finally {
    _release()
  }
}

// Pull the first balanced JSON object/array out of free text (the codex prompt-coax fallback path).
function _coaxJson(text) {
  const s = String(text ?? '')
  // Fast path: the whole thing parses.
  try { return JSON.parse(s.trim()) } catch { /* fall through to a scan */ }
  // Strip ``` fences if present.
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1].trim()) } catch { /* keep scanning */ } }
  // Scan for the first balanced { } or [ ] (string/escape-aware).
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = s.indexOf(open)
    if (start < 0) continue
    let depth = 0, inStr = false, esc = false
    for (let k = start; k < s.length; k++) {
      const ch = s[k]
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue }
      if (ch === '"') inStr = true
      else if (ch === open) depth++
      else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, k + 1)) } catch { break } } }
    }
  }
  return null
}

// Deprecated back-compat alias — existing examples/library/tests import { llm } from llm.mjs (a shim that
// re-exports this). New workflows use the injected `agent` global (NO imports).
export const llm = agent

export default agent
