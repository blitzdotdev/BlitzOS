# blitzscript → Claude Code Workflow interface: full refactor plan

Status: DESIGN FOR REVIEW (rev 2, 2026-06-18). Parent: `plans/blitzos-blitzscript.md` (this plan REPLACES its §11 execution model and §72 item 7 "later opts"). Goal: a real Claude Code workflow script (e.g. `src/main/blitzscript/examples/claude_workflows/island-tournament-refactor-wf_*.js`) runs UNCHANGED via `blitz run`, because Claude is trained on this exact DSL and authors it more reliably than blitzscript's bespoke `llm()` API.

**Rev-2 changelog (6 adversary gaps closed, every fact re-verified on this machine — claude 2.1.170, codex-cli 0.139.0, node v25.2.1):**
- **[fatal] G1 — claude structured output reads `structured_output`, NOT `.result`.** A real `claude -p --output-format json --json-schema <s>` run returned `{"result":"Done! I've created a person object for Alice, age 30.", … ,"structured_output":{"name":"Alice","age":30}, …}`. `.result` is a PROSE acknowledgment; the validated object lives in the top-level `structured_output` field. §6 now mandates a DISTINCT `buildStructured`/`parseStructured` path keyed on `structured_output`, with the exact fixture + a test. (Bonus: `usage{input_tokens,output_tokens,…}` + `total_cost_usd` live in the SAME object — used for `budget`, §8.)
- **[major] G2 — codex HAS native structured output.** `codex exec --help` shows `--output-schema <FILE>` ("Path to a JSON Schema file describing the model's final response shape"). The old "codex (no such flag)" was false. §2/§6 corrected: codex schema path = write the schema to a tmp file + `--output-schema <path>`; prompt-coax is demoted to a fallback for codex builds lacking it.
- **[major] G3 — `node --check` is a FALSE PASS on the `.js` corpus.** Verified: `node --check <corpus>.js` exits 0 (does NOT catch the illegal top-level `return`) because `agent-os/package.json` has no `type:"module"` so a bare `.js` is checked permissively as a script; the same bytes as `.mjs` correctly throw `SyntaxError: Illegal return statement`. §11 rewritten: the authoritative syntax gate is compiling `new AsyncFunction(...8 globals..., body)` in try/catch (verified to throw on a bad body and compile a good body with top-level await+return); raw `node --check` is dropped for Claude `.js` (kept only to check legacy `.mjs`).
- **[major] G4 — in-process execution corrupts journals via module-global leaf state.** `llm.mjs` holds `_jIndex/_journal/_divergedAt/_calls/_active/_waiters/_caps` at MODULE scope (reset only by the `_resetJournal` test hook). In-process `runWorkflow` + recursive `workflow()` would share one journal index/file across parent and child runs. RESOLVED by **per-run context** (§5.1): refactor `agent.mjs` so all per-run state lives in a `RunContext` passed in by `runWorkflow`; `depth`/`memDir` flow through the context, NOT `process.env`. The concurrency semaphore stays process-global (it bounds the RESOURCE across all concurrent runs — correct). This single refactor also closes G6.
- **[minor] G5 — soften the journal determinism wording.** name-the-thing is parallel-OF-parallel (`match()` itself awaits `parallel(panelSize votes)`); the invocation index is assigned at the (deterministic, microtask-ordered) START of each async `agent()` body, NOT "synchronously at call entry". §5.4/§13 reworded; resume is valid only while program shape is byte-identical (pre-existing, preserved — not a regression).
- **[minor] G6 — the 1000-call cap must be per-RUN, not per-process.** `_calls++` (`llm.mjs:231`) runs BEFORE the dry-run branch and is module-global; in-process it would trip spuriously across unrelated runs. Folded into the G4 RunContext: `ctx.calls` is per-run, reset each `runWorkflow`; dry-run accounting is separate.

## 0. The decision in one line

blitzscript today is **only the leaf half** of the interface: `llm()` (a local `claude -p` / `codex exec` leaf) + a concurrency semaphore + positional-index+prompt-hash journaling/resume + dry-run fallbacks + model-alias resolution. The Claude Code Workflow interface is that **same leaf** wrapped in an **orchestration layer** (`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/`workflow` + `schema`) **delivered as injected GLOBALS, not imports**. So we KEEP the leaf+resource layer, RENAME `llm()`→`agent()`, **lift its module-global per-run state into a RunContext** (the one architectural change, forced by in-process execution — §5.1), and BUILD a new loader + the orchestration globals. The leaf stays a subprocess (blitzscript's deliberate divergence from Claude Code's in-process subagents — confirmed sound by the binary RE; we mirror the SEMANTICS, not the architecture).

## 1. The structural proof (why this is an execution-model change, not an add-on)

Confirmed empirically across all 26 corpus files in `src/main/blitzscript/examples/claude_workflows/`:
- **26/26** start with `export const meta = {…}` on **line 1** — a pure object literal (no vars/calls/spreads; one file adds `whenToUse`, `model` never appears as a meta key).
- **0/26** contain any `import` or `require` (grepped) — every dependency is an injected global.
- **26/26** end with a **`return {…}` at column 0** — illegal at ES-module top level.
- Top-level `await` is pervasive (`const survivors = await parallel(...)`).

That triad (`export` + top-level `await` + top-level `return`, zero imports) **cannot be loaded as an ES module or a CJS module**, and CANNOT run under the current runner. `src/main/blitzscript/run.mjs:87` does `spawn(process.execPath, [workflow, ...wfArgs.slice(1)], { stdio:'inherit' })` — it runs the file as a plain Node child whose stdout IS the result, where the script must `import { llm }` (as `examples/naming-tournament.mjs` + `examples/workflow-patterns.mjs` do) and `console.log` its answer. A Claude workflow has no imports (so `agent` is undefined) and a top-level `return` (so it's a SyntaxError under module loading — VERIFIED: `node --check` on the `.mjs` form throws `Illegal return statement`). **The core build is a loader that parses out `meta`, wraps the body in an async function, and injects the globals into scope.**

Which contract opts actually appear as CODE in the corpus (drives build priority):
- **Heavy:** `schema` (137 occurrences), `label` (182), `phase` (147) — must be first-class.
- **Real but rare:** `agentType` (5 uses — re-verified by grep: `'Explore'` in `blitzos-features-3-5` L162 + `blitzos-journey-audit` L98; `'general-purpose'` in `blitzos-journey-audit` L139/195/217).
- **Spec-only (zero real-code uses — re-verified by grep, every hit was inside a prompt STRING):** `isolation:'worktree'`, `budget.total/spent()/remaining()`, `workflow(...)`, `args` as a read identifier, `meta.model`, `opts.model`. Implement these to-contract but they are lower-risk and unexercised by examples.
- **Determinism:** `Date.now`/`Math.random`/`new Date`/`setTimeout` appear ZERO times as real code — the corpus is already determinism-clean.

## 2. Semantics confirmed from the claude binary RE + the live CLIs (mirror these exactly)

The claude binary (2.1.170) is bun-packed cleartext; a `strings` pass (clean-room, semantics only — do NOT copy minified source) plus **live `--help` + real-call verification on this machine** confirmed:
- **Concurrency:** `min(16, max(2, cpus-2))` — a counting semaphore ON THE RESOURCE (the agent leaf). Current `MAX_CONCURRENCY = max(2, cpus-2)` (`llm.mjs:36`) needs the `min(16, …)` ceiling. (Stays process-global — it bounds total concurrent leaves across all runs; see §5.1.)
- **Call cap:** **1000** agent() calls **per RUN** (`dWK=1000`), with the message "loop using budget.remaining() never terminates". **Per-run, not per-process** (G6) — `ctx.calls`, reset each `runWorkflow`.
- **Stall retries:** 5 (`QWK=5`) — blitzscript's `opts.retries` is the analog (keep default 0; subprocess leaves are heavy).
- **Budget:** `Object.freeze({ total: opt ?? null, spent: ()=>turnSpent, remaining: ()=> total==null ? Infinity : max(0,total-turnSpent) })`. Default `total:null` = UNBOUNDED. Token accounting is now CHEAP and real: the claude json result carries `usage.input_tokens/output_tokens/cache_*` + `total_cost_usd` (verified in the live fixture); codex `--json` emits token-count events. `WorkflowBudgetExceededError` thrown inside `parallel`/`pipeline` → that slot → null + a "N slots dropped — token budget exceeded" log; it never rejects.
- **Schema — claude:** native StructuredOutput tool, Ajv-validated. **The CLI exposes it via `--json-schema <schema>` + `--output-format json` (VERIFIED present in `claude -p --help`).** **CRITICAL (G1): a real run puts the validated object in the top-level `structured_output` field; `.result` is a prose acknowledgment.** Live fixture (claude 2.1.170, model haiku, schema `{type:object, properties:{name,age}, required:[name,age]}`): `{"type":"result","subtype":"success",…,"result":"Done! I've created a person object for Alice, age 30.",…,"usage":{…},"total_cost_usd":0.0327,…,"structured_output":{"name":"Alice","age":30},…}`. So `parseStructured` reads `o.structured_output`, NEVER `.result`.
- **Schema — codex:** **VERIFIED present: `codex exec --output-schema <FILE>` ("Path to a JSON Schema file describing the model's final response shape").** Codex HAS native structured output (file-based). The old "codex has no such flag" was FALSE (G2). Use it; prompt-coax is only a fallback.
- **agentType:** **VERIFIED present: `claude --agents <json>` + `--agent <name>` + `--append-system-prompt`** — a real binding.
- **Resume:** `journal.jsonl` (SAME filename blitzscript uses) + longest-unchanged-prefix. Claude keys by content-hash; **blitzscript keeps its positional-index + prompt-hash keying** (the signed-off, safer choice for side-effecting subprocess leaves — `plans/blitzos-blitzscript.md:39`). The only change: **fold the new output-affecting opts (`schema`, resolved `model`, `agentType`) into the hash** so a changed schema/agentType invalidates.

## 3. Architecture of the change

```
src/main/blitzscript/
  agent.mjs        RENAMED from llm.mjs — the leaf + resource layer + journal, REFACTORED to per-run state.
                     export agent(prompt, opts, fallback)  ← was llm()   (reads the active RunContext)
                     export const llm = agent  (deprecated back-compat alias)
                     export { _setSpawn, _resetJournal, _stats, _setCaps, leafMetadata }  ← test hooks PRESERVED
                     RunContext class: { calls, jIndex, journal, divergedAt, memDir, depth, args,
                                         budget, tokensSpent, phase } + withRunContext(ctx, fn)
                     + schema-forced structured output (native --json-schema for claude reading
                       structured_output; --output-schema tmpfile for codex; prompt-coax fallback)
                     + opts.agentType, opts.isolation:'worktree', opts.label/phase passthrough
                     + concurrency cap min(16,cores-2) (process-global); 1000-call cap PER RUN
  runtime.mjs      NEW — the orchestration layer (the injected globals + the loader)
                     loadWorkflow(file)  → { meta, body }   (parse export const meta, strip it)
                     runWorkflow(file, { args, memDir, budget, depth }) → the script's top-level return value
                       (creates a fresh RunContext, runs the whole body under withRunContext)
                     parallel(thunks) / pipeline(items, ...stages) / phase(title) / log(msg)
                     makeBudget(total) / the inline workflow() global (own RunContext + memDir subdir)
                     the determinism shadow (Date/Math.random/etc throw inside the wrapped scope)
  schema.mjs       NEW — tiny self-contained JSON-Schema validator (type/properties/required/items/
                     enum/additionalProperties subset the corpus uses) + stubFromSchema(schema) for dry-run.
                     (Do NOT add ajv as a direct dep — only transitively present; the subset is ~80 lines.)
  harnesses.mjs    EXTEND — add claude.buildStructured (--json-schema) + parseStructured (reads
                     structured_output); codex.buildStructured (--output-schema tmpfile) + parseStructured;
                     claude --agents/--agent for agentType; codex prompt-coax fallback path.
  run.mjs          REWRITE the executor: dual-mode dispatch; Claude-shaped files → in-process runWorkflow();
                     legacy .mjs (import { llm }) → keep spawn(node, [file]). Print/persist the RETURN VALUE.
  check.mjs        REWRITE: syntax gate = AsyncFunction-compile the wrapped body (NOT node --check on raw .js);
                     dry-run via runtime.mjs (globals injected, schema→stub); per-run 1000 cap; wall-clock timeout.
  capabilities.mjs unchanged (still probes harness/model/effort; the matrix still backs opts.model aliases).
  llm.mjs          → a re-export shim: export { agent as llm, _setSpawn, _resetJournal, _stats, _setCaps,
                     leafMetadata } from './agent.mjs'  (existing examples + library + tests keep working).
  agent.d.mts      NEW types for agent.mjs (the dir has none today).
  runtime.d.mts    NEW types for runtime.mjs.
```

## 4. The execution model (the load-bearing build) — `runtime.mjs` loader

### 4.1 Parse + strip `meta` (a pure literal — read statically, never eval the whole file)

`loadWorkflow(file)`:
1. Read source.
2. Extract the `export const meta = { … }` literal. Because it is guaranteed pure (verified across the corpus), parse it safely: prefer an AST walk (acorn is a transitive dep via electron-vite); the fallback is a balanced-brace scan from `export const meta =` to the matching `}` then `new Function('return (' + literal + ')')()` (acceptable — the literal has no calls/identifiers). Validate shape: accept `{ name, description, phases?, whenToUse?, model? }`, ignore unknown keys, tolerate a missing `meta` (synthesize `{ name: basename }`).
3. Produce `body` = the source with the `export const meta = …;` statement removed (replace its exact span with whitespace so line numbers in stack traces stay aligned).

### 4.2 Wrap the body in an injected async function (NOT a module load)

```js
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
const fn = new AsyncFunction(
  'agent','parallel','pipeline','phase','log','args','budget','workflow',
  // determinism shadows passed as params so they lexically override globals in the body:
  'Date','Math','setTimeout','setInterval','performance','crypto',
  body
)
const result = await fn(agent, parallel, pipeline, phase, log, args, budget, workflow,
                        ShadowDate, ShadowMath, banned('setTimeout'), banned('setInterval'),
                        ShadowPerf, ShadowCrypto)
```
- Top-level `await` is legal (async function body). Top-level `return` is legal (it's a function). Free `agent(...)` resolves to the param. `import`/`require` would throw — but the corpus has none. **VERIFIED on node v25.2.1: `new AsyncFunction('agent','parallel',…, body)` compiles a body with top-level await+return and throws `SyntaxError` on a malformed body** (this is the §11 syntax gate).
- **The return value of `fn()` IS the workflow result** (object/string/whatever the script `return`s). This REPLACES blitzscript's "stdout is the result" doctrine for Claude-shaped scripts (see §10).
- **Determinism enforcement** (matches Claude Code): `Date`/`Math.random`/`setTimeout`/`setInterval`/`performance.now`/`crypto.getRandomValues` are shadowed in the wrapped scope to THROW ("nondeterministic builtins are unavailable in a workflow body — they break resume; pass timestamps/ids via args"). `Math` is a proxy that throws ONLY on `.random` (`Math.max`/`min`/`floor`, used pervasively, pass through). `Date` throws on construction and `Date.now`.
- Why `new AsyncFunction` over `vm.SourceTextModule`: AsyncFunction needs no `--experimental-vm-modules` flag, supports top-level await+return natively, and injects globals as params (lexical, no `with`). vm.SourceTextModule forces module semantics (no top-level return). Node v25.2.1 supports both; AsyncFunction is simpler and flag-free.

### 4.3 `runWorkflow(file, ctx)` — creates the per-run state (G4/G6)

```js
async function runWorkflow(file, { args, memDir, budget, depth = 0 } = {}) {
  const { meta, body } = loadWorkflow(file)
  const runCtx = new RunContext({ memDir, depth, args, budget: makeBudget(budget) })  // FRESH per run
  return withRunContext(runCtx, async () => {
    const fn = makeWrappedFn(body)
    const globals = bindGlobals(runCtx)   // agent/parallel/pipeline/phase/log/args/budget/workflow bound to runCtx
    const result = await fn(...globals, ...determinismShadows)
    if (memDir) writeFileSync(join(memDir,'result.json'), JSON.stringify({ result, meta, stats: runCtx.stats() }, null, 2))
    return { result, meta, stats: runCtx.stats() }
  })
}
```
- `RunContext` holds **everything that was module-global** in `llm.mjs`: `calls`, `jIndex`, `journal`, `divergedAt`, `memDir`, `depth`, `args`, `budget`, `tokensSpent`, current `phase`. The semaphore (`_active`/`_waiters`/`MAX_CONCURRENCY`) STAYS module-global — it bounds the resource across ALL concurrent runs.
- `withRunContext` uses `AsyncLocalStorage` (node:async_hooks) so a deeply-nested `agent()` inside `parallel`-of-`parallel` reads the correct run's context without threading a param through every layer. `agent()` does `getRunContext()` at call time.
- Errors propagate (a workflow throwing is a failed run).

## 5. `agent()` = the renamed leaf, refactored to per-run state (G4/G6)

### 5.1 The RunContext refactor (the one architectural change — sign-off needed)

Today `llm.mjs` keeps `_jIndex/_journal/_divergedAt/_calls` at module scope. In-process execution (§4.3) plus recursive `workflow()` (§8) would make a child run **share the parent's journal index + journal.jsonl + call counter**, corrupting BOTH journals' resume and tripping the 1000 cap spuriously across unrelated runs. **Fix:** move that state into `RunContext`; `agent()` reads `getRunContext()` and mutates `ctx.jIndex/ctx.journal/ctx.calls/...`. `depth` and `memDir` come from `ctx`, NOT `process.env` (eliminates the `BLITZ_DEPTH` mid-flight race the adversary flagged — `process.env.BLITZ_DEPTH` is still SET on the LEAF child env for the subprocess to self-label, but the orchestrator reads `ctx.depth` in-process). The semaphore stays process-global. (Alternative considered + rejected: keep a child process per `workflow()` sub-run — it would re-pay claude/codex orchestration startup and, worse, split the shared semaphore so parent+child fan-outs could together exceed `min(16,cores-2)` concurrent leaves. The context refactor is the correct architecture.)

`_resetJournal()` becomes "create a fresh RunContext" under the hood; the exported test hook is preserved (it resets the ambient/default context the tests use when they call `llm()` outside `runWorkflow`).

### 5.2 The rename + opts

`export async function agent(prompt, opts, fallback)` is the current `llm()` body (reading `getRunContext()`). Keep `export const llm = agent` + a deprecation note. opts grows from `{harness?, model?, effort?, cwd?, retries?}` to ALSO accept `{label?, phase?, schema?, model?, isolation?, agentType?}`:
- **`label` / `phase`** — display/grouping only. Thread to the progress sink (`{kind:'agent', label, phase, status}`). `opts.phase` overrides `ctx.phase` (avoids races inside parallel/pipeline).
- **`model`** — ALREADY works via `_resolveModel` (`llm.mjs:133`): `cheap`/`strong`/`default` → this machine's pick. Keep. (`meta.model` becomes the per-workflow default when `opts.model` is absent — a runtime-supplied default on `ctx`; spec-only, low risk.)
- **`schema`** — see §6. Without schema → final TEXT (today). With schema → the validated OBJECT, or `null` after retries.
- **`agentType`** — claude: `--agents '<json defining the type>'` + `--agent <type>` (flags VERIFIED), OR `--append-system-prompt` with a preset. A small known-type map (`Explore` → read-only-exploration system block; `general-purpose` → default). codex: append the type's system block to the prompt. Unknown agentType → log a warning, fall through to default (never hard-fail).
- **`isolation:'worktree'`** — sits on the EXISTING `opts.cwd`. Before spawn: `git worktree add <tmp> HEAD` under `<ctx.memDir>/worktrees/<label-or-index>`, set `cwd`, run the leaf, `git worktree remove` on completion (force on failure). Spec-only (0 corpus uses) — ship the thin version; lifecycle is an open decision below.

### 5.3 Journal hash update

Fold the output-affecting opts into `_hashCall` so resume invalidates on a changed schema/agentType:
```js
sha256(`${harness}\0${model}\0${effort}\0${agentType||''}\0${schema?JSON.stringify(schema):''}\0${prompt}`)
```
Keep positional-index keying. `scripts/tests/test-blitz-journal.mjs` stays green — its fixtures pass NO schema/agentType (verified: the test's `_setSpawn` returns `{result:'OK'}`, no schema), so the hash is unchanged for them — but the test must be re-run.

### 5.4 Concurrency + call caps (G5/G6)

- **Concurrency cap (process-global):** `MAX_CONCURRENCY = Math.min(16, Math.max(2, os.cpus().length - 2))`.
- **Lifetime cap (PER RUN — G6):** in the spawn path, throw when `ctx.calls > 1000` ("call cap (1000) … loop using budget.remaining() never terminates"). `ctx.calls` resets each `runWorkflow`, so run #11 of a 100-agent workflow in a long-lived host never trips. The dry-run path has its OWN counter (§11) that does NOT bleed into `ctx.calls` real-path accounting.
- **Determinism wording (G5):** the invocation index is assigned at the **(deterministic, microtask-ordered) start of each `agent()` body** (post-`await`), NOT "synchronously at call entry, so Promise.all is deterministic". For a byte-identical program this index is stable across runs (V8 microtask order is deterministic), so resume is correct; but an edit that changes the NUMBER of inner thunks in an early `parallel` (e.g. `panelSize` in name-the-thing's early `match`) shifts every later index and re-runs the suffix by design. Document this; do NOT overstate the guarantee. (Pre-existing behavior, preserved — not a regression.)

## 6. Schema = structured output (harness-aware, both native) — `schema.mjs` + `harnesses.mjs`

When `opts.schema` is set, `agent()` returns a schema-valid OBJECT (not text), retrying on mismatch, `null` after retries.

- **`schema.mjs`** — a tiny self-contained validator for the JSON-Schema subset the corpus uses: `type` (object/array/string/number/integer/boolean), `properties`, `required`, `items`, `enum`, `additionalProperties:false`. Returns `{ok, errors[]}`. Also `stubFromSchema(schema)` → a representative value (first enum value, empty arrays/strings, recursed objects) for dry-run. (NOT importing ajv — only transitive; the subset is ~80 lines.)

- **claude harness (native — G1):** `claude.buildStructured(prompt, opts, schema)` → `['-p', prompt, '--output-format','json','--json-schema', JSON.stringify(schema), '--dangerously-skip-permissions', …model/effort]`. **`claude.parseStructured(stdout)` parses the result object and returns `o.structured_output`** — explicitly NOT `o.result` (which is prose: live fixture `"result":"Done! I've created a person object…"` while `"structured_output":{"name":"Alice","age":30}`). `buildStructured`/`parseStructured` are a DISTINCT path from `build()`/`parse()` (whose `.result` read is correct ONLY for the no-schema text path). One bounded retry on a missing/invalid `structured_output` (re-prompt with the validator error appended).

- **codex harness (native — G2):** `codex.buildStructured(prompt, opts, schema)` writes the schema JSON to a temp file (`<ctx.memDir>/schemas/<index>.json` or `mkdtemp`) and passes `--output-schema <path>` alongside `exec … --json …`. `codex.parseStructured(stdout)` pulls the final `agent_message` (already the validated JSON since codex forces the shape) and `JSON.parse`s it. **Fallback** (codex build lacking `--output-schema`): the prompt-coax path — append "Respond with ONLY a JSON object matching this schema: `<schema>`. No prose, no fences.", parse the first JSON object, validate, retry N, then `null`. (Detect flag support once via `capabilities.mjs`/a `codex exec --help` probe.)

- `agent()` branches: `opts.schema ? harness.buildStructured(...) : harness.build(...)`, and `opts.schema ? validate+retry+return obj|null : return text`. The journal stores the OBJECT (JSON-serializable).
- **Dry-run:** with `BLITZ_DRY_RUN`, `agent({schema})` returns `stubFromSchema(schema)` (so `blitz check` exercises real `.filter(Boolean)` + field access); `agent()` without schema returns the 3rd-arg fallback or the generic placeholder. The Claude contract has NO 3rd-arg fallback, so the schema-stub path is what makes dry-run meaningful for Claude scripts.

## 7. `parallel` / `pipeline` / `phase` / `log` — on top of the existing semaphore

PURE STRUCTURE over `agent()`; concurrency is already bounded ON the resource (the process-global semaphore), so they add NO concurrency control (matches the binary: the limiter lives on the agent, not the fan-out wrapper).

- **`parallel(thunks)`** — BARRIER. Type-guard: throw `TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)")` if any element isn't a function. Then `Promise.all(thunks.map(t => Promise.resolve().then(t).catch(e => { if (e instanceof WorkflowBudgetExceededError) droppedBudget++; else logThrow(e); return null })))`. A throwing thunk → `null` (never rejects); callers `.filter(Boolean)`. Cap ≤ 4096 items. After: if `droppedBudget`, `log("parallel: N slots dropped — token budget exceeded")`. (Survives parallel-OF-parallel: each thunk runs under the same `AsyncLocalStorage` RunContext.)
- **`pipeline(items, ...stages)`** — NO barrier between stages; each item flows through ALL stages independently. Per-item async chain: `items.map((item, i) => runStages(item, i))`, `runStages` awaits stage1(item) then stageK(prev, item, i); a throwing stage drops THAT item to `null` and skips its remaining stages (modeled by `browser-bug-sweep`'s `if (!findings) return {...}`). Returns `Promise.all` of the per-item chains. Stage cb signature `(prevResult, originalItem, index)`. Cap ≤ 4096.
- **`phase(title)`** — sets `ctx.phase`; later `agent()` calls without `opts.phase` group under it; `opts.phase` overrides. Emits a progress marker.
- **`log(message)`** — a narrator line to the progress sink AND mirrored to stderr (so `blitz run` in a terminal stays readable; BlitzOS shows salient lines via `say`).

All four are bound per-run in `bindGlobals(runCtx)` (phase/log state is per-invocation, no cross-run leak).

## 8. `args` / `budget` / `workflow()` (contract completeness; spec-only in corpus)

- **`args`** — the workflow INPUT, bound into the wrapped scope. Source: `blitz run <wf> <args-json>` (parse a single JSON arg; if not valid JSON, pass the raw string; if absent, `undefined`) AND the `start_workflow` seed (`task`/`contextRefs` threadable later). REPLACES the `wfArgs.slice(1)` → `process.argv` forwarding (`run.mjs:87`). (Back-compat: legacy library scripts read `process.argv[2..]` and run via the legacy spawn path with `process.argv` intact — both models coexist.)
- **`budget`** — `Object.freeze({ total: ctx.budget ?? null, spent: () => ctx.tokensSpent, remaining: () => total==null ? Infinity : Math.max(0, total - ctx.tokensSpent) })`. Default null = unbounded. `ctx.tokensSpent` accumulates from each harness's parsed usage — and this is now CHEAP: the claude json result carries `usage.input_tokens/output_tokens/cache_*` + `total_cost_usd` (verified in the live fixture), codex `--json` emits token counts. `WorkflowBudgetExceededError` thrown by `agent()` when a budget is set and exceeded; caught by parallel/pipeline → null + log. (Low priority: no corpus script reads `budget`.)
- **`workflow(nameOrRef, args?)`** — run another workflow inline, ONE level deep. Resolve via `resolveWorkflow` (`run.mjs:28`), then `runWorkflow` it with **its OWN fresh RunContext** (G4: separate `jIndex/journal/calls`) and a `memDir` SUBDIR (`<ctx.memDir>/sub/<name>/`) at `depth+1`; refuse `depth >= 1`. Returns its top-level `return` value. Because each `runWorkflow` makes a fresh RunContext and AsyncLocalStorage scopes it, the child NEVER touches the parent's journal/index. (Zero corpus uses; ship the thin version.)

## 9. `run.mjs` executor rewrite (the consumer change)

Replace the child-process executor (`run.mjs:87-92`) with an in-process call for Claude-shaped files:
```js
const { runWorkflow } = await import('./runtime.mjs')
const args = parseArgsJson(wfArgs.slice(1))   // single JSON arg → args global
const { result } = await runWorkflow(workflow, { args, memDir, budget: parseBudget(), depth: 0 })
process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
```
- **Dual-mode dispatch:** detect script shape from the file head. NO top-level `import`/`require` AND (a top-level `return` OR an `export const meta`) → the Claude-workflow loader (runtime.mjs). A file WITH `import { llm }` (legacy `examples/*.mjs` + `library/*.mjs`) → keep `spawn(node, [file])` so it runs unchanged with `process.argv` + `console.log`. Cheap regex on the head (`export const meta` / leading `import`). Zero-break migration.
- **In-process state isolation (G4/G6):** each top-level `blitz run` makes ONE fresh RunContext; even a long-lived host running many `blitz run` calls never shares journal/index/call-count across runs. (If we ever batch multiple runs in one process, the RunContext guarantees isolation by construction.)
- **`--resume`** unchanged: stable memDir → the journal fast-forwards. `resumeFromRunId` (`wf_<id>`) maps onto `--resume`+stable-mem-dir; optionally accept a `wf_<id>` positional → a memDir.
- Keep `BLITZ_WS`/`BLITZ_MEM_DIR` env; set `BLITZ_DEPTH` on the LEAF child env for self-labeling, but the orchestrator reads `ctx.depth` in-process.
- Errors: a throwing workflow → non-zero exit + the error on stderr (today's semantics preserved).

## 10. Result delivery to BlitzOS (open decision, decided here as a default)

The corpus returns structured OBJECTS, not stdout text. `blitz run` prints the return value as pretty JSON (above). For `start_workflow`/orchestrator: the orchestrator agent runs `bash .blitzos/blitz run <wf>` via Bash and reads the printed JSON (no new wiring — it's how the agent already consumes `blitz`). Additionally persist `{result, meta, stats}` to `<memDir>/result.json` (already wired in §4.3) for a `--resume`/inspection path. The progress stream from `phase`/`log`/agent-markers is the live-narration channel; the agent mirrors salient lines to chat via `say`.

## 11. `check.mjs` rewrite (the syntax-gate inversion — G3)

- **Syntax gate (G3 — the premise was backwards):** `node --check` on the raw corpus `.js` is a FALSE PASS — VERIFIED exit 0 on a file with top-level `return` (because `agent-os/package.json` has no `type:"module"`, a bare `.js` is checked permissively as a script; `return`/`await`/`import` parse differently than at module top level, so a genuinely broken body can pass). So DROP raw `node --check` for Claude `.js`. The authoritative gate is **`new AsyncFunction('agent','parallel',…,'crypto', body)` in try/catch** (VERIFIED: throws `SyntaxError` on a bad body, compiles a good body with top-level await+return). Dual-mode: legacy `.mjs` → real `node --check` (correctly catches `Illegal return statement`); Claude `.js` → AsyncFunction-compile the wrapped body (after `loadWorkflow` strips `meta`).
- **Dry-run:** run via `runtime.mjs` with `BLITZ_DRY_RUN=1`. `agent()` returns `stubFromSchema(schema)` (schema path) or the fallback (text path). Keep the wall-clock timeout. **The dry-run call cap is SEPARATE from the real-path per-run `ctx.calls` (G6)** — a dry-run-only counter (keep the existing 5000 as the check-time ceiling, OR align to 1000; align the message either way). The cap catches unbounded loops; the timeout catches stalls.
- Report shape unchanged (`formatCheck`): syntax / dry-run PASS/FAIL + first error. (Update the syntax-step label: "compiled (workflow body)" for `.js`, "node --check" for `.mjs`.)

## 12. Migration of existing assets

- **`examples/naming-tournament.mjs`, `examples/workflow-patterns.mjs`** — `import { llm }` + `console.log` + `Date.now()`. KEEP WORKING via (a) the `llm` re-export alias and (b) the dual-mode executor routing them to legacy `spawn(node, file)` (full stdlib incl. `Date.now`, `process.argv`). Optionally port `naming-tournament` to the new DSL as a canonical example (not required; `name-the-thing-wf_*.js` is already the new-DSL successor).
- **`library/verify-job.mjs`, `library/supervise-tick.mjs`** — `import { llm }` + `process.argv` + `console.log`. KEEP WORKING via the alias + legacy path. (Future: port with `meta` + `args`; out of scope.)
- **The shim + duty** (`agent-runtime.mjs:32` `writeBlitzShim` → `#!/bin/sh\nexec node <run.mjs> "$@"`, `:41` `orchestratorBootTask`, `blitzos-orchestrator.md`): the shim line is UNCHANGED (run.mjs is still the entry). The DUTY prose + `blitzos-orchestrator.md` must be REWRITTEN to teach the Claude Code Workflow DSL instead of `import { llm } from <BLITZ_LLM>`: "author a workflow.js with `export const meta` + the injected globals `agent/parallel/pipeline/phase/log/args/budget/workflow` (NO imports), end with `return <result>`". This is the single biggest behavioral switch for the agent — it's WHY we're doing this. Update `osActions.ts:939` (the live-flip ENABLE message) + `agent-runtime.mjs:41` identically. (The `BLITZ_LLM` constant in `agent-runtime.mjs:22` becomes unused by the new duty; keep it only if the legacy template path still references it.)
- **`.d.mts` types:** add `agent.d.mts` + `runtime.d.mts` (the dir has none) so the d.mts-consuming build sees the new signatures.

## 13. Concurrency/caps reconciliation summary

| Limit | Claude Code | blitzscript today | After |
|---|---|---|---|
| concurrent agents | `min(16,max(2,cpus-2))` | `max(2,cpus-2)` (module-global) | `min(16,max(2,cpus-2))` (module-global — bounds the resource across runs) |
| lifetime calls | 1000 (per run) | `_calls` (module-global, never reset) | throw at 1000 **per RUN** (`ctx.calls`, G6) |
| items per parallel/pipeline | 4096 | n/a | throw at 4096 |
| stall retries | 5 (auto) | `opts.retries` (default 0) | keep `opts.retries`; doc the 5 analog |
| budget | `{total,spent,remaining}`, null default | none | implement, null default; tokens from claude `usage`/`total_cost_usd` + codex token events |
| resume key | content-hash(prompt+opts) | positional-index + prompt-hash (module-global journal) | positional-index + prompt-hash **+ schema/agentType/model in hash**, journal **per RunContext** (G4) |
| index assignment | — | "sync at call entry" (overstated) | **at the deterministic, microtask-ordered start of each agent() body** (G5); resume valid only while program shape is byte-identical |

## 14. Sequencing

1. **RunContext refactor (G4/G6) + Loader + globals MVP.** Lift `llm.mjs` per-run state into `RunContext` + `AsyncLocalStorage`; rename `llm.mjs`→`agent.mjs` + the re-export shim preserving ALL test hooks. `runtime.mjs`: loadWorkflow/runWorkflow + AsyncFunction wrap + determinism shadow; `parallel`/`pipeline`/`phase`/`log`; `agent` = current leaf, no-schema. Make `island-tournament`/`name-the-thing` PARSE + dry-run (text path). [Unblocks everything; the refactor is the riskiest piece — do it first under the existing journal tests.]
2. **Schema (G1+G2)** — `schema.mjs` validator + stub; claude `buildStructured`/`parseStructured` reading **`structured_output`**; codex `--output-schema <tmpfile>` native path + prompt-coax fallback; `agent({schema})` returns obj|null. Now `mine-corrections`/`browser-bug-sweep`/`name-the-thing`/`island-tournament` run for real. [Heaviest-used; the G1 field is the make-or-break.]
3. **agentType** — claude `--agents`/`--agent`; codex system-block; known-type map. Now `blitzos-journey-audit`/`blitzos-features-3-5` run.
4. **run.mjs + check.mjs rewrite (G3)** — dual-mode dispatch; return-value delivery; **AsyncFunction-compile syntax gate** (not raw `node --check`); per-run 1000 cap; dry-run cap separated.
5. **args / budget / workflow()** — contract completeness; spec-only. `workflow()` uses its own RunContext + memDir subdir (G4).
6. **Duty + shim + docs rewrite** — `blitzos-orchestrator.md`, `orchestratorBootTask`, `osActions.ts:939` + `.d.mts` types. The agent now authors the new DSL.
7. **Tests (§15)** + live-verify one real corpus file end-to-end (against a stub leaf, then a real leaf).

## 15. Tests

- KEEP green: `scripts/tests/test-blitz-journal.mjs` (imports `{ llm, _setSpawn, _resetJournal }`), `test-blitz-llm.mjs` (imports `{ llm, _setSpawn, _stats, leafMetadata }`), `test-blitz-library.mjs`, `test-blitz-orchestrator.mjs` — via the `llm` alias + dual-mode path + preserved test hooks. (The re-export shim MUST export `llm, _setSpawn, _resetJournal, _stats, _setCaps, leafMetadata`.)
- NEW `scripts/tests/test-blitz-runtime.mjs`: loader parses `meta` + strips it (line numbers preserved); AsyncFunction wrap runs a body with top-level `await`+`return`; determinism shadow throws on `Date.now`/`Math.random` but `Math.max` works; `parallel` barrier + throw→null + 4096 cap + TypeError on non-thunk; `pipeline` no-barrier + (prev,item,i) + stage-throw drops item; `phase`/`log` emit; injected `agent` callable (stub spawner). **G4: two `runWorkflow` calls in ONE process do not share journal index/file (assert distinct journals); `workflow()` child run writes to a SUBDIR journal, parent journal untouched.** **G6: `ctx.calls` resets per run (run two 600-call dry-runs → neither trips 1000).**
- NEW `scripts/tests/test-blitz-schema.mjs`: `schema.mjs` validates the corpus subset; `stubFromSchema` shapes; **G1: claude `parseStructured` extracts `o.structured_output` (NOT `o.result`) from the real-shaped fixture `{"result":"Done…","structured_output":{"name":"Alice","age":30}}`**; `buildStructured` includes `--json-schema`; **G2: codex `buildStructured` writes a tmp schema file + includes `--output-schema <path>`**; codex prompt-coax fallback validate+retry+null (stub returning bad-then-good JSON).
- DRY-RUN gate: `blitz check` PASSes on a representative subset of `examples/claude_workflows/*.js` (ROOT/abs-path prompts that don't spawn) — proves they LOAD + dry-run unchanged AND that the AsyncFunction syntax gate (not raw `node --check`) is what's running.
- LIVE: `blitz run` one real file (e.g. `name-the-thing-wf_*.js`) with a stub-or-real leaf; assert the returned object shape (and, for a real claude leaf, that a schema call returns the OBJECT from `structured_output`, not prose).

## 16. Clean-room note

The claude binary RE confirmed semantics only (the numbers in §2/§13, the StructuredOutput/journal/budget shapes); the structured-output FIELD (`structured_output`) and the codex `--output-schema` flag were confirmed by LIVE CLI runs on this machine, not from minified source. All code is an independent reimplementation on blitzscript's subprocess leaf + fs memory. blitzscript's leaf-is-a-subprocess and positional-index resume are deliberate, signed-off divergences (not bugs to "correct"); we mirror the interface + the safety numbers, not the in-process architecture.