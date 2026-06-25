// blitzscript — runtime.mjs: the Claude Code Workflow loader + the injected orchestration globals.
//
// A Claude Code workflow file (src/main/blitzscript/examples/claude_workflows/*.js) is NOT a module and
// NOT a script you can `node <file>`: it has `export const meta = {…}` on line 1, ZERO imports, top-level
// `await`, and a top-level `return {…}` (illegal at module/script top level). Every dependency it uses
// (agent, parallel, pipeline, phase, log, args, budget, workflow) is an INJECTED GLOBAL. Claude is trained
// on exactly this DSL, so it authors it more reliably than blitzscript's bespoke llm() API.
//
// This loader makes such a file RUN UNCHANGED:
//   loadWorkflow(file)            parse + strip `export const meta` (line numbers preserved), return {meta, body}
//   runWorkflow(file, {args,…})   wrap the body in an AsyncFunction, inject the globals (bound to a FRESH
//                                 per-run RunContext), run it, return its top-level `return` value.
// See plans/blitzos-blitzscript-claude-interface.md §4-§8.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { agent, RunContext, withRunContext, getRunContext, WorkflowBudgetExceededError } from './agent.mjs'
import { emitProgress, withGroup, previewOf, setProgressSink } from './progress.mjs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// The globals injected into a workflow body, in a FIXED order (the AsyncFunction param list must match).
export const GLOBAL_NAMES = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow']
// Determinism shadows: passed as params so they lexically override the real builtins INSIDE the body.
const SHADOW_NAMES = ['Date', 'Math', 'setTimeout', 'setInterval', 'setImmediate', 'performance', 'crypto']

const MAX_FANOUT = 4096 // cap items per parallel/pipeline (matches the plan; a runaway fan-out fails loud)

// ── 1) loadWorkflow: parse the pure `meta` literal + strip it (line-number-preserving) ────────────
export function loadWorkflow(file) {
  const source = readFileSync(file, 'utf8')
  const { meta, body } = stripMeta(source, file)
  return { meta, body, file }
}

// Extract `export const meta = { … }` (a guaranteed-pure object literal across the corpus) and return the
// source with that statement replaced by whitespace (so stack-trace line numbers stay aligned). A missing
// meta synthesizes { name: basename }. We do NOT eval the whole file — only the isolated literal.
export function stripMeta(source, file = 'workflow') {
  const m = /export\s+const\s+meta\s*=\s*/.exec(source)
  if (!m) return { meta: { name: baseName(file) }, body: source }
  const braceStart = source.indexOf('{', m.index + m[0].length)
  if (braceStart < 0) return { meta: { name: baseName(file) }, body: source }
  const braceEnd = matchBrace(source, braceStart)
  if (braceEnd < 0) return { meta: { name: baseName(file) }, body: source }
  // include a trailing semicolon in the stripped span if present.
  let end = braceEnd + 1
  while (end < source.length && /[ \t]/.test(source[end])) end++
  if (source[end] === ';') end++

  const literal = source.slice(braceStart, braceEnd + 1)
  let meta
  try {
    // The literal is pure (no calls/identifiers/spreads across the whole corpus). Evaluate it in
    // isolation; on any surprise, fall back to a synthesized name rather than failing the load.
    meta = new Function('return (' + literal + ')')() // eslint-disable-line no-new-func
    if (!meta || typeof meta !== 'object') meta = { name: baseName(file) }
    if (!meta.name) meta.name = baseName(file)
  } catch { meta = { name: baseName(file) } }

  // Replace the whole `export const meta = {…};` span with whitespace, preserving newlines for line numbers.
  const removed = source.slice(m.index, end)
  const blanked = removed.replace(/[^\n]/g, ' ')
  const body = source.slice(0, m.index) + blanked + source.slice(end)
  return { meta, body }
}

const baseName = (file) => basename(String(file)).replace(/\.[^.]+$/, '')

// Find the index of the `}` matching the `{` at `open`, string/template/comment-aware (so a brace inside a
// string or comment in the literal doesn't throw the count off).
function matchBrace(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i], next = s[i + 1]
    // skip strings / templates
    if (ch === '"' || ch === "'" || ch === '`') { i = skipString(s, i, ch); continue }
    // skip comments
    if (ch === '/' && next === '/') { i = s.indexOf('\n', i); if (i < 0) return -1; continue }
    if (ch === '/' && next === '*') { const e = s.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue }
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}
// Return the index of the closing quote of the string starting at `start` (quote `q`). Handles escapes;
// for templates, skips `${ … }` interpolations (which can themselves contain strings/braces).
function skipString(s, start, q) {
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') { i++; continue }
    if (q === '`' && ch === '$' && s[i + 1] === '{') { i = matchBrace(s, i + 1); if (i < 0) return s.length; continue }
    if (ch === q) return i
  }
  return s.length
}

// ── 2) the determinism shadow (matches Claude Code: nondeterministic builtins break resume) ───────
function banned(name) {
  return () => { throw new Error(`blitz workflow: ${name}() is unavailable in a workflow body — it breaks deterministic resume. Pass timestamps/ids via args.`) }
}
const ShadowDate = new Proxy(function () {}, {
  construct() { throw new Error('blitz workflow: new Date() is unavailable in a workflow body — it breaks deterministic resume. Pass timestamps via args.') },
  apply() { throw new Error('blitz workflow: Date() is unavailable in a workflow body — pass timestamps via args.') },
  get(_t, prop) {
    if (prop === 'now') return () => { throw new Error('blitz workflow: Date.now() is unavailable in a workflow body — it breaks deterministic resume. Pass timestamps via args.') }
    // Date.UTC / Date.parse are pure given explicit inputs -> allow.
    return Date[prop]
  },
})
const ShadowMath = new Proxy(Math, {
  get(_t, prop) {
    if (prop === 'random') return () => { throw new Error('blitz workflow: Math.random() is unavailable in a workflow body — it breaks deterministic resume. Pass any randomness via args.') }
    return Math[prop] // max/min/floor/abs/… pass through (used pervasively)
  },
})
const ShadowPerf = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'now') return () => { throw new Error('blitz workflow: performance.now() is unavailable in a workflow body — it breaks deterministic resume.') }
    return typeof performance !== 'undefined' ? performance[prop] : undefined
  },
})
const ShadowCrypto = new Proxy({}, {
  get(_t, prop) {
    if (prop === 'getRandomValues' || prop === 'randomUUID') return () => { throw new Error(`blitz workflow: crypto.${String(prop)}() is unavailable in a workflow body — it breaks deterministic resume. Pass ids via args.`) }
    return (typeof crypto !== 'undefined' && crypto) ? crypto[prop] : undefined
  },
})
function shadowValues() {
  // order must match SHADOW_NAMES
  return [ShadowDate, ShadowMath, banned('setTimeout'), banned('setInterval'), banned('setImmediate'), ShadowPerf, ShadowCrypto]
}

// ── 3) wrap the body in an injected async function (NOT a module load) ────────────────────────────
export function makeWrappedFn(body) {
  // Throws SyntaxError on a malformed body (this is also the check.mjs syntax gate). Globals + shadows
  // are params, so a free `agent(...)` / `Math.max(...)` resolves lexically; `import`/`require` would throw.
  return new AsyncFunction(...GLOBAL_NAMES, ...SHADOW_NAMES, body)
}

// ── 4) the orchestration globals, bound to a RunContext ───────────────────────────────────────────
// The progress sink + the WfEvent shapes live in progress.mjs (shared with agent.mjs, no circular dep).
// A host installs one setProgressSink that routes every event by runId into the per-run bus; the default
// mirrors phase/log to stderr so `blitz run` in a terminal stays readable. Re-exported for back-compat.
export { setProgressSink }

// parallel(thunks) — BARRIER over an array of FUNCTIONS (not promises). Each runs under the same ambient
// RunContext (AsyncLocalStorage), so a deeply-nested parallel-of-parallel sees the right run. A throwing
// thunk -> null (callers .filter(Boolean)); a budget overflow -> null + a dropped-slots log. Never rejects.
function parallel(thunks) {
  if (!Array.isArray(thunks)) throw new TypeError('parallel() expects an array of functions, e.g. parallel([() => agent(...), () => agent(...)])')
  if (thunks.length > MAX_FANOUT) throw new Error(`blitz parallel: ${thunks.length} items exceeds the cap (${MAX_FANOUT})`)
  for (const t of thunks) {
    if (typeof t !== 'function') throw new TypeError('parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)')
  }
  const ctx = getRunContext()
  const groupId = `g${ctx.groupSeq++}`
  emitProgress(ctx, { type: 'group:start', groupId, kind: 'parallel', phaseId: ctx.phase, size: thunks.length })
  let droppedBudget = 0
  // withGroup scopes each thunk under the fan-out id, so agent() leaves inside report this groupId.
  const ps = thunks.map((t) => Promise.resolve().then(() => withGroup(groupId, t)).catch((e) => {
    if (e instanceof WorkflowBudgetExceededError) { droppedBudget++; return null }
    logThrow(e)
    return null
  }))
  return Promise.all(ps).then((res) => {
    const failed = res.filter((r) => r === null).length
    emitProgress(ctx, { type: 'group:done', groupId, ok: res.length - failed, failed })
    if (droppedBudget) emitProgress(ctx, { type: 'log', phaseId: ctx.phase, message: `parallel: ${droppedBudget} slot(s) dropped — token budget exceeded` })
    return res
  })
}

// pipeline(items, ...stages) — NO barrier between stages: each item flows through ALL stages independently.
// stage1 cb = (item); stageK cb = (prevResult, originalItem, index). A throwing stage drops THAT item to
// null and skips its remaining stages. Returns Promise.all of the per-item chains. Never rejects.
function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new TypeError('pipeline() expects (items[], ...stageFns)')
  if (items.length > MAX_FANOUT) throw new Error(`blitz pipeline: ${items.length} items exceeds the cap (${MAX_FANOUT})`)
  for (const s of stages) if (typeof s !== 'function') throw new TypeError('pipeline() stages must be functions: pipeline(items, (item)=>…, (prev,item,i)=>…)')
  const ctx = getRunContext()
  const groupId = `g${ctx.groupSeq++}`
  emitProgress(ctx, { type: 'group:start', groupId, kind: 'pipeline', phaseId: ctx.phase, size: items.length })
  // Each item's whole stage-chain runs under the group id, so every agent() leaf in it reports this group.
  const runItem = (item, index) => withGroup(groupId, async () => {
    let prev
    for (let s = 0; s < stages.length; s++) {
      try {
        prev = s === 0 ? await stages[0](item) : await stages[s](prev, item, index)
      } catch (e) {
        if (!(e instanceof WorkflowBudgetExceededError)) logThrow(e)
        return null // drop this item; skip its remaining stages
      }
    }
    return prev
  })
  return Promise.all(items.map((item, i) => runItem(item, i))).then((res) => {
    const failed = res.filter((r) => r === null).length
    emitProgress(ctx, { type: 'group:done', groupId, ok: res.length - failed, failed })
    return res
  })
}

function logThrow(e) {
  emitProgress(getRunContext(), { type: 'error', message: e && e.message ? e.message : String(e) })
  process.stderr.write(`[blitz] slot failed: ${e && e.message ? e.message : e}\n`)
}

// budget — a frozen { total, spent(), remaining() } over ctx.tokensSpent. total:null = UNBOUNDED.
export function makeBudget(total, ctx) {
  const cap = (total == null || total === '' || !Number.isFinite(Number(total))) ? null : Number(total)
  return Object.freeze({
    total: cap,
    spent: () => ctx ? ctx.tokensSpent : 0,
    remaining: () => cap == null ? Infinity : Math.max(0, cap - (ctx ? ctx.tokensSpent : 0)),
  })
}

// Bind the globals to a specific RunContext. phase/log are per-invocation (write ctx.phase, emit markers);
// agent is passed through but the workflow body sees ITS phase via ctx (agent() reads ctx.phase when
// opts.phase is absent). workflow() runs another workflow ONE level deep with its OWN fresh context.
function bindGlobals(ctx) {
  const phase = (title) => { ctx.phase = title == null ? null : String(title); emitProgress(ctx, { type: 'phase', phaseId: ctx.phase, title: ctx.phase }) }
  const log = (message) => emitProgress(ctx, { type: 'log', phaseId: ctx.phase, message: String(message) })
  // agent:start/done are emitted INSIDE agent() (where the node id + group live), so the wrapper that the
  // body sees is a plain pass-through; agent() reads the ambient ctx.phase itself.
  const agentG = (prompt, opts = {}, fallback) => agent(prompt, opts, fallback)
  const budget = makeBudget(ctx.budget && typeof ctx.budget === 'object' ? ctx.budget.total : ctx.budget, ctx)
  const workflowG = (nameOrRef, wfArgs) => runNestedWorkflow(ctx, nameOrRef, wfArgs)
  // order MUST match GLOBAL_NAMES
  return [agentG, parallel, pipeline, phase, log, ctx.args, budget, workflowG]
}

// ── 5) runWorkflow: fresh per-run RunContext (G4/G6) ──────────────────────────────────────────────
export async function runWorkflow(file, { args, memDir, budget, depth = 0, runId = null, dry = false } = {}) {
  const { meta, body } = loadWorkflow(file)
  // Ensure the mem dir exists up front so the journal (written DURING agent() calls, before result.json)
  // and a nested workflow()'s SUBDIR can be created. The CLI also mkdir's it; this makes runWorkflow
  // robust when called directly (tests) or via workflow() (sub/<name>/).
  if (memDir) { try { mkdirSync(memDir, { recursive: true }) } catch { /* best-effort */ } }
  const runCtx = new RunContext({
    memDir: memDir || null,
    depth,
    args,
    budget: budget != null ? makeBudget(budget) : null, // a raw number -> a budget object; null = unbounded
    defaultModel: meta && typeof meta.model === 'string' ? meta.model : undefined,
    runId, // the externalization run id — stamped onto every WfEvent so a host sink can route by run.
    dry, // per-run dry preflight: agents emit a skeleton (start+done) but never spawn. Race-free vs BLITZ_DRY_RUN.
  })
  return withRunContext(runCtx, async () => {
    const startedAt = Date.now()
    emitProgress(runCtx, { type: 'run:start', name: meta && meta.name, description: meta && meta.description })
    let result
    try {
      const fn = makeWrappedFn(body)
      result = await fn(...bindGlobals(runCtx), ...shadowValues())
    } catch (e) {
      emitProgress(runCtx, { type: 'run:done', ok: false, ms: Date.now() - startedAt, calls: runCtx.calls, tokens: runCtx.tokensSpent, preview: previewOf(e && e.message ? e.message : e) })
      // ALWAYS leave a typed result.json, even when the body THREW (e.g. a standalone schema leaf that now
      // fails loud after the bug-1 rethrow). Without this a thrown body writes NO artifact at all, so a
      // completion waiter's resultPath dangles and recovery finds an empty run dir. This crash envelope is a
      // NEW shape (ok:false/error/resultKind:'error'); the success-path result.json below stays byte-identical.
      if (memDir) {
        try {
          mkdirSync(memDir, { recursive: true })
          writeFileSync(join(memDir, 'result.json'), JSON.stringify({ result: null, ok: false, error: e && e.message ? e.message : String(e), resultKind: 'error', meta, stats: runCtx.stats() }, null, 2))
        } catch { /* best-effort persistence */ }
      }
      throw e
    }
    emitProgress(runCtx, { type: 'run:done', ok: true, ms: Date.now() - startedAt, calls: runCtx.calls, tokens: runCtx.tokensSpent, preview: previewOf(result) })
    if (memDir) {
      try {
        mkdirSync(memDir, { recursive: true })
        writeFileSync(join(memDir, 'result.json'), JSON.stringify({ result, meta, stats: runCtx.stats() }, null, 2))
      } catch { /* best-effort persistence */ }
    }
    return { result, meta, stats: runCtx.stats() }
  })
}

// workflow() — run another workflow inline, ONE level deep (depth>=1 refused). Its OWN fresh RunContext +
// a memDir SUBDIR, so it never touches the parent's journal/index/calls (G4). Resolution is lazy to avoid
// a circular import with run.mjs.
async function runNestedWorkflow(parentCtx, nameOrRef, wfArgs) {
  if (parentCtx.depth >= 1) throw new Error('blitz workflow(): nested workflows are limited to one level deep')
  const { resolveWorkflow } = await import('./run.mjs').catch(() => ({ resolveWorkflow: null }))
  let file = nameOrRef
  if (resolveWorkflow) {
    const ws = process.env.BLITZ_WS || process.cwd()
    file = resolveWorkflow(nameOrRef, ws) || nameOrRef
  }
  const subName = baseName(file)
  const subMem = parentCtx.memDir ? join(parentCtx.memDir, 'sub', subName) : null
  const { result } = await runWorkflow(file, { args: wfArgs, memDir: subMem, depth: parentCtx.depth + 1 })
  return result
}

export { parallel, pipeline }
export default { loadWorkflow, runWorkflow, stripMeta, makeWrappedFn, makeBudget, parallel, pipeline, setProgressSink, GLOBAL_NAMES }
