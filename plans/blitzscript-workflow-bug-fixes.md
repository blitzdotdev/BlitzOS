# Blitzscript workflow bug-fix plan

The definitive fix plan for the 6 workflow bugs in the session friction report (`/Users/minjunes/Desktop/session-friction-report.md`). Every claim here is verified against real code and (where a run can prove it) a real CLI run under `/tmp/blitz-wf-debug/`. Source was reverted clean after every probe.

## IMPLEMENTED — 2026-06-22

Landed + verified: `npm run check` green (typecheck + parity + build), the full blitz/wf test suite passes, plus 2 new tests. Real proof under `/tmp/blitz-wf-debug/verify1` (infra-fail now loud + a typed crash artifact) and `/verify2` (a normal haiku run intact). Built AROUND live concurrent work on this subsystem (a new `wf-store.mjs`), so two items shifted from the plan below:

- **Bug 1 (silent swallow) + its crash-artifact companion — DONE.** `agent.mjs` exec: `if (schema && lastErr && lastErr.schemaErrors) return null; throw lastErr` (a spawn/infra failure now rethrows loud; a genuine schema MISS still soft-nulls). `runtime.mjs` catch: always writes a typed `{result:null,ok:false,error,resultKind:'error'}` result.json on a thrown body. Proof: an invalid-model leaf now exits 1, records `status:'error'` + the real 404, and leaves a crash result.json (was `status:'null'`, silent success).
- **Bug 6 (typed envelope) — DONE.** `captureLeaf` stamps `resultKind` (`object|text|null|error`) + a pre-parsed `resultJson` for a text leaf that emitted JSON. The success-path result.json stays byte-stable (`{result,meta,stats}`).
- **Bugs 2 + 3 (no completion wake) — DONE, wired next to `persistEvents`.** `workflow-host` calls an injected `onRunComplete` in the settle `.then/.catch`; `index.ts` turns it into an agent-private `trigger:'workflow'` perception moment (`perception-core.emitWorkflowMoment` + `visibleTo`/`redactMoment` passthrough). The agent is woken via `/events` on run:done with result.json already on disk. `os-tools` run_workflow doc updated (no more "poll result.json").
- **Bug 5 (run ownership) — DEFERRED to the concurrent `wf-store.mjs`.** That in-flight work writes a per-agent run `index.json` `{runId,agentId,file,...}` that supersedes the plan's `meta.json` sidecar; my sidecar was reverted to avoid a duplicate owner record.
- **Bug 4 (relay inflight) — partial, OUT of agent-os.** `MAX_INFLIGHT` lowered `10 -> 8` in `~/agent-socket/relay/src/relay-do.ts` per request. NO clean agent-os mitigation exists (handlers always reply; the SDK owns the WS; the watchdog already force-closes wedged sockets), so the plan's "close old WS on reconnect" change was NOT made (it would be a hack against the real code). The load-bearing cure remains the deferred `alarm()` stale-pending sweep in the relay.

New tests: `scripts/tests/test-wf-leaf-failure.mjs` (A loud infra-fail + crash artifact, B preserved soft-null, C typed kinds) and `scripts/tests/test-wf-wake.mjs` (pushed on run:done, agent-private, result.json on disk before the wake).

## The one theme

Every bug is the same OS-level feedback gap: the blitzscript engine does the work but never tells the agent the truth about what happened, so the agent (the swappable policy) is forced to guess. A 404 leaf writes to disk identically to a polite refusal (bug 1). The on-disk artifacts never declare their own type, so a reader sniffs `typeof` and guesses how many times to `JSON.parse` (bug 6). A finished run pushes nothing into the perception/wake channel that already exists for chat, so the agent hand-rolls a 16-minute `sleep 12` poll and races whatever instant it samples (bugs 2+3). A run dir carries no durable owner, so on restart the agent greps result content to re-claim its own runs (bug 5). The relay's inflight cap pins full with no durable sweep, so the only fix the agent found was restarting the app (bug 4).

BlitzOS is an OS for an agent, and an OS must make its syscalls' outcomes legible to its policy: every terminal state must be a distinct, typed, pushed signal — loud on infra failure, self-describing on disk, woken on completion, owned on creation — never a silent file the agent has to interrogate. Each fix closes the loop at the seam where the engine already knows the truth and currently throws it away.

## What the stress pass changed (read this before implementing)

Three corrections folded in from the adversarial review (all re-verified by me with real runs):

1. **Bug 1's rethrow CRASHES a standalone schema leaf and drops result.json.** The original plan reasoned only about the `parallel`/`pipeline` `.filter(Boolean)` path and called the soft-null "preserved." That holds inside a fan-out, but the dominant corpus pattern is a STANDALONE schema leaf (the synthesis/reduce step, zero try/catch). For that, `agent()` returning null vs throwing is NOT equivalent: nothing catches the throw before `runtime.mjs:257`, which re-throws at L259 and **skips the result.json write at L262-266**. So a synthesis leaf that 404s flips the run from "completes with a partial result + a durable result.json" to "**crashes, no result.json at all**". Proven below. Fix: bug 1 MUST ship with a runtime change that always writes a typed `result.json` even on a thrown body. This is now a co-equal part of the bug-1 class, not an edge case.

2. **Cut the harness `is_error` guard from the initial fix.** The real 404 envelope (`is_error:true, api_error_status:404`) exits NON-ZERO, so `_defaultSpawn` (agent.mjs:229-236) already rejects it and the primary rethrow already catches it. I found no exit-0 `is_error` case in the repo. The guard would add a false-positive surface to the two hottest parse paths (every text + every structured leaf throws if the model's own JSON output happens to carry an `api_error_status` field). Leave a TODO instead; add it only if a real exit-0 `is_error` is ever observed, and gate it on `is_error === true` ONLY (not `|| api_error_status`).

3. **`resultKind`/`resultJson` go in the LEAF record only, not the always-written `result.json` envelope.** Folding per-leaf kinds into `result.json`'s `{result,meta,stats}` mutates the envelope the kanban/enrichment/workflow-bus read, for marginal benefit. Keep result.json byte-stable for the success path. (The one exception is the NEW crash-path result.json from correction 1, which is a brand-new shape nobody read before, so it can carry `ok:false`/`error`/`resultKind:'error'` freely.)

Plus two seam choices the review settled:
- **Bug 2 wake-emit site = `index.ts:757`** (`wireWorkflowHost`'s broadcast handler), NOT `osActions.ts:368`. This keeps `osActions.ts` perception-free (it is pure control-plane mutation + IPC today and imports nothing from perception-core).
- **Bug 2 resultPath = `osWfRunMemDir(action.runId)`**, NOT `action.memDir`. The `done` broadcast (workflow-host.mjs:85/88) does NOT carry memDir; only the `started` broadcast does. But `osNoteWfRun` already persists memDir durably in `_wfMemDirs` (osActions.ts:641) and resolves it via `osWfRunMemDir` (osActions.ts:662). At the moment the `done` action is handled, `osNoteWfRun(action)` has already run, so the memDir is guaranteed present. Deriving the path there removes the dependency on threading memDir onto a broadcast that doesn't carry it.

Open-question #1 (does the rethrow change `parallel`/`pipeline` group semantics?) is RESOLVED by existing code: `parallel` (runtime.mjs:161-165) and `pipeline` (runtime.mjs:190-193) already `catch` any throw → `logThrow` → `return null`. So a now-thrown spawn error inside a fan-out still coalesces to a null slot; the run survives; the leaf reads `status:'error'`. Proven below: "loud at LEAF, soft at GROUP" is already the behavior. No group-semantics change needed.

---

## Proof trail (real CLI runs, source reverted after)

All under `/tmp/blitz-wf-debug/editor/`. Each real `claude` child was guarded by a `( sleep N; kill -9 )` watchdog (no `timeout` binary on this box).

### Standalone schema 404 — the crash + the fix

| | TODAY (`if (schema) return null`) | bug-1 fix only (`...schemaErrors) return null; throw`) | bug-1 + runtime always-write |
|---|---|---|---|
| process exit | `0` | `1` | `1` |
| body continues past `agent()` | YES | **NO (crashes)** | NO (crashes — correct) |
| `result.json` on disk | YES (`{synthesis:null}`) | **NO — absent** | **YES (`{result:null,ok:false,error:<404>,resultKind:'error'}`)** |
| leaf 0 status | `null` (no error field) | `error` (+ full 404) | `error` (+ full 404) |

So the bug-1 fix alone REGRESSES a standalone synthesis leaf (no durable artifact, the bug-2 wake would point at a dangling file). Adding the runtime always-write restores the artifact AND makes it typed/legible. Both proven end to end.

### Parallel fan-out (one good haiku leaf + one 404 leaf), bug-1 + runtime fix applied
- exit `0` (run SURVIVES), body reached the barrier, `survivors=1`
- `result.json` present: `survivors:['OK'], raw:['OK', null]` — the 404 leaf coalesced to a null slot
- leaf statuses: node 0 (haiku) `ok`, node 1 (404) `error` → loud at the leaf, soft at the group. No group-semantics change.

### Soft-null preserved (genuine schema MISS, valid model)
`/tmp/blitz-wf-debug/review-schemamiss/mem/leaves/0.json`: `status:"null", result:null, tokens:16` — a valid model that RAN (spent 16 tokens) but emitted JSON violating the schema, so `validateSchema` (agent.mjs:469) tags `.schemaErrors` (agent.mjs:470) → the gate `if (schema && lastErr && lastErr.schemaErrors) return null` keeps the by-design soft-null. Contrast `/tmp/blitz-wf-debug/review-standalone/mem/leaves/0.json`: `status:"null", tokens:0` (the 404 swallow). The `tokens` field is the tell — 16 (ran-then-missed) vs 0 (never-ran).

---

## The fixes, ranked by leverage and safety

Order = bug 2+3 → bug 5 → bug 1+6 → bug 4. Highest-leverage-lowest-risk first.

---

### 1. No completion wake (bugs 2 + 3) — bridge run:done into /events. Effort S.

**Root mechanism.** A workflow's completion has no bridge into the perception kernel, so an agent on the `/events` long-poll is never re-invoked when its run finishes — it must poll `result.json` and race whichever instant it samples. `runtime.mjs:261` emits `run:done` to the PROGRESS SINK only; `runtime.mjs:265` writes `result.json` after the body returns. In the hosted path the sink (`workflow-host.mjs:30`) feeds the renderer widget bus, and the terminal `.then/.catch` (`workflow-host.mjs:85-88`) fires only `broadcast({type:'workflow-run',done:true})`, wired (`index.ts:757`) to `osBroadcast` whose `workflow-run` branch (`osActions.ts:366-369`) calls `osNoteWfRun` (no emit) + `sendToRenderer` — pure renderer IPC. `waitForEvents` (`perception-core.mjs:535`) only delivers moments in LOG, which `emit()` alone fills, and the whole exported `emit*` API has NO workflow entry. The supervisor tick can't cover it: `emitTick` diffs only agent-status edges + terminal exits, and a leaf is an `agent.mjs` child, not a roster agent nor a terminal. Bug 3 ("result.json lag") is the SAME class, not a write-lag: the production run `wf_mqojni4o0` showed result.json landing the SAME SECOND as the final leaf; the felt "lag" was an 8.5-min synthesis leaf + the agent's "all leaf files exist" being an unsound completion predicate because there is no done-signal.

**The one structural fix.** Add a `trigger:'workflow'` moment that funnels through the existing `emit()`, agent-private like `'message'`, and fire it from the hosted completion seam AFTER result.json is on disk. Reuse `/events`, no new transport. The agent is then re-invoked exactly like a chat message; it reads result.json on wake; the unsound "count the leaf files" heuristic is never needed.

**Files + diff sketches (real identifiers).**

`src/main/perception-core.mjs` — new emitter mirroring `emitConnectionMoment` (L499); private trigger (L78); redact passthrough (L109):
```js
// new export (mirror emitConnectionMoment @499):
export function emitWorkflowMoment(runId, agentId = '0', info = {}) {
  const sid = String(agentId || '0')
  const ok = info.ok !== false
  emit({
    seq: ++seq, ts: Date.now(),
    surfaceId: sid === '0' ? 'chat' : `chat-${sid}`,
    agentId: sid,                       // visibleTo wakes ONLY this agent
    trigger: 'workflow', windowMs: 0,
    signals: { workflow: 1 },
    user: [`workflow ${runId} ${ok ? 'done' : 'failed'}`],
    workflow: { runId: String(runId), ok, resultPath: String(info.resultPath || '') }
  })
}
// visibleTo L78 — add 'workflow' to the agent-private set:
//   if (['message','action','connection','workflow'].includes(moment.trigger)) return String(moment.agentId||'0') === sid
// redactMoment L109 — pass workflow through (carries only ids + a path, no scraped content):
//   if (['message','connector','connection','workflow'].includes(m.trigger)) return m
```

`src/main/index.ts` — wake at the `wireWorkflowHost` broadcast handler (L753-757), keeping `osActions.ts` perception-free; derive the path from the durable registry:
```ts
// import emitWorkflowMoment from perception-core (alongside the existing perception imports)
wireWorkflowHost({
  // ...existing deps...
  broadcast: (action) => {
    try { osBroadcast(action) } catch { /* best-effort */ }
    // wake the launching agent on completion — AFTER osBroadcast ran osNoteWfRun, so the memDir is registered
    if (action?.type === 'workflow-run' && action.done) {
      try {
        const runId = String(action.runId || '')
        const md = osWfRunMemDir(runId)            // osActions.ts:662 — durable, traversal-safe
        emitWorkflowMoment(runId, String(action.agentId ?? '0'), { ok: action.ok !== false, resultPath: md ? join(md, 'result.json') : '' })
      } catch { /* best-effort */ }
    }
  }
})
```
(import `osWfRunMemDir` from `./osActions` and `join` from `node:path` if not already in scope.)

`src/main/os-tools.mjs` — update the `/run_workflow` note (L254 description, L267 note) from "poll result.json" to "wakes you via /events on completion":
```js
// description tail: "...Returns IMMEDIATELY with { runId }; the run continues in the background and WAKES you
//   via /events when it finishes — then read <workspace>/.blitzos/workflows/<runId>/result.json."
// note: `The run will WAKE you on completion via /events; then read .blitzos/workflows/${runId}/result.json.`
```

**Ordering is provably safe.** `result.json` (runtime.mjs:265) is written synchronously BEFORE `runWorkflow` returns (line 268); the `done` broadcast fires only in workflow-host's `.then()` AFTER `runWorkflow` resolves; the wake-emit is inside that broadcast handler. So result.json is always on disk before the agent is woken. No race. (Verified: writeFileSync at L265 precedes the L268 return that resolves the promise.)

**Verification test.** New `scripts/tests/test-wf-wake.mjs` on the `test-wf-leaf-capture.mjs` pattern (real workflow-host + stub spawn): register a `waitForEvents(since, 5000, '0')` BEFORE `runWorkflowHosted` resolves, route the host's broadcast into a shim calling `emitWorkflowMoment` (or the index.ts handler), run a 2-leaf haiku-stub workflow, assert the waiter RESOLVES with a moment whose `trigger==='workflow'`, `agentId==='0'`, and `workflow.resultPath` points at an existing `result.json`. Second assert: an agent `'7'` run wakes ONLY the `'7'` waiter, not `'0'` (visibleTo privacy).

**Contract it preserves.** Reuses `emit()`/`visibleTo()`/`waitForEvents()` so the ring cap, the workspace stamp (emit L211-213), and the undelivered-message hook are inherited unchanged. `'workflow'` as an agent-private trigger means it will NOT leak to the `'0'` supervisor when another agent launched the run (matches the per-agent chat model). `redactMoment` passthrough is consent-safe: the moment carries only `{runId, ok, resultPath}`, no scraped content. The renderer kanban path (osNoteWfRun → os:action) is untouched; the wake is additive. Both `.then`(ok:true) and `.catch`(ok:false) set `done:true`, so a FAILED run wakes too (and after fix 3 below, its result.json exists and is legible).

**Known hole (TODO, not in scope).** The bare CLI path (`run.mjs` in a child) has no perception kernel in-process, so its completion stays file-only — acceptable since the gap that bit the user is the HOSTED `run_workflow` path. Separately, a run that NEVER resolves (an in-process leaf child that hangs and isn't bounded) fires neither `.then` nor `.catch`, so no wake — same as today's kanban. This class is "finished-but-no-signal," not "never-finishes." Add a TODO + a future run-level watchdog that emits `ok:false` after a ceiling.

---

### 2. Run-ownership (bug 5) — write an owner sidecar at the runtime seam. Effort S.

**Root mechanism.** The run-dir layout encodes only the runId, never the launcher or the source script, so on recovery a run dir has zero durable link to the agent that launched it — the agent greps result CONTENT to re-claim its own runs. `workflowMemDir(runId)` (`workflow-host.mjs:41-44`) returns `join(ws,'.blitzos','workflows',String(runId))` — flat, agent-agnostic. `runWorkflowHosted` (L50) receives `agentId` but consumes it solely in-memory (`spawnEnrichment` L69; the broadcasts L73-108). No code writes the owner to disk: the only persisted artifacts are `journal.jsonl` + `leaves/<n>.json` (`captureLeaf`, no agentId field) and `result.json` (`runtime.mjs:265` = `{result,meta,stats}` where `meta` is the WORKFLOW's own meta literal). `os-tools.mjs:264` mints runId with no agent component. Verified on disk: all 14 `wf_*` dirs lack any owner; two different agents' runs differ only by result CONTENT. Critically the CLI path (`run.mjs`) uses `BLITZ_MEM_DIR` directly and NEVER calls `workflowMemDir`, so an owner write placed only in the hosted wrapper misses CLI runs.

**The one structural fix.** Write a durable owner+provenance `meta.json` sidecar at CREATION, at the seam all transports share — `runtime.mjs` (NOT only the hosted wrapper). Thread the launcher identity into `runWorkflow()` as a new `owner` opt; write the sidecar right after the up-front `mkdirSync` (runtime.mjs:240). Recovery then lists `workflows/` and reads `meta.json` to filter by owner.

**Files + diff sketches.**

`src/main/blitzscript/runtime.mjs` — signature L235 + the up-front mkdir block L240:
```js
export async function runWorkflow(file, { args, memDir, budget, depth = 0, runId = null, dry = false, owner = null } = {}) {
  // ...
  if (memDir) {
    try {
      mkdirSync(memDir, { recursive: true })
      if (owner) writeFileSync(join(memDir, 'meta.json'), JSON.stringify({
        runId, agentId: String(owner.agentId ?? '0'), file: owner.file || file,
        name: meta && meta.name, startedAt: Date.now(), ws: process.env.BLITZ_WS || null
      }, null, 2))
    } catch { /* best-effort */ }
  }
```
(`Date.now` is host-side here — the runtime wrapper, not the shadowed body — so it is allowed, same as `mintRunId` workflow-host.mjs:37.)

`src/main/workflow-host.mjs` — pass owner from `runWorkflowHosted` (L84; `aid` + `file` are already in scope):
```js
.then(() => rt.runWorkflow(file, { args, memDir, runId: id, dry, owner: { agentId: aid, file } }))
```

`src/main/blitzscript/run.mjs` — pass owner in the in-process Claude-shaped branch:
```js
const { result } = await runWorkflow(workflow, { args, memDir, budget, depth: 0, owner: { agentId: process.env.BLITZ_AGENT_ID || 'cli', file: workflow } })
```

**Verification test.** Extend `scripts/tests/test-wf-run-state.mjs` (or `test-wf-leaf-capture.mjs`): after `runWorkflowHosted({file, runId, agentId:'7'})`, assert `<memDir>/meta.json` parses to `{runId, agentId:'7', file:<the wf path>, startedAt:<number>, name:'demo'}`. Add a CLI assertion via a child `node run.mjs run <wf>` with `BLITZ_MEM_DIR` set, then assert `meta.json.agentId==='cli'` and `file===` the resolved path — proving the write lives in the runtime and covers BOTH hosted and CLI, not just the wrapper.

**Contract it preserves.** Purely ADDITIVE: `meta.json` is a new sidecar; nothing reads it yet, and every existing reader of `result.json`/`leaves/<n>.json`/`journal.jsonl` is untouched (the run's own meta inside result.json keeps being the WORKFLOW meta, so kanban/enrichment/workflow-bus are unaffected). Backward-compatible: the 14 owner-less dirs simply lack `meta.json` — recovery treats absent owner as "unknown." runId minting and the resume journal hash are untouched.

**Scope honesty.** This covers all RUNTIME-ROUTED runs (hosted + CLI-claude-shaped + server). Two paths still escape and are out of scope: the LEGACY plain-Node child in `run.mjs` (for non-claude-shaped workflows, spawned with only `BLITZ_MEM_DIR`, never calls `runWorkflow`), and nested `workflow()` subdirs (unless `owner` is threaded through `runNestedWorkflow`). Neither is the hosted hot path. Keep the dir-level namespacing (`.blitzos/workflows/a<agentId>/<runId>`) DEFERRED — the sidecar alone closes the class, and the dir change touches the renderer's `osWfRunMemDir` resolver for no functional gain.

---

### 3. Lossy + untyped leaf-result contract (bugs 1 + 6) — distinct typed terminal states + a durable artifact. Effort M.

**Root mechanism.** `agent.mjs` `exec()` has THREE terminal exits for a schema leaf but collapses two of them into one indistinguishable on-disk state, and the captured record never declares its own type.
- **Infra-failure swallow.** A non-zero-exit spawn reject (claude's 404/overload, any crash) is caught at `agent.mjs:480` `catch (e) { lastErr = e }`, then `agent.mjs:484` `if (schema) return null` returns null EXACTLY like a stubborn-but-valid model. The success path stamps `status:(out===null&&schema)?'null':'ok'` ⇒ `'null'` with `result:null` and NO error field (agent.mjs:493-494); the catch at 496-498 that would record `status:'error'`+message is never reached. tokens:0 + sessionId:"" is the tell that the child failed (vs mis-formatting), but `agent()` discards it.
- **Polymorphic `.result`.** Object (schema unwrap, agent.mjs:472), string (text, agent.mjs:477 → harnesses.mjs:140), a JSON-string-needing-a-second-parse (a text leaf that emitted JSON; `harness.parse` never parses the payload), or null (the swallow). Neither writeFileSync site (the flat leaf record agent.mjs:494, the `{result,meta,stats}` run file runtime.mjs:265) documents which.
- **The crash (from the stress pass).** Once the swallow is fixed to rethrow, a STANDALONE schema leaf (the synthesis/reduce step, no fan-out catch) makes `runWorkflow` re-throw at runtime.mjs:259 and SKIP the result.json write at L262-266 — the run leaves no artifact at all. Proven above.

**The one structural fix.** Make the leaf's terminal state DISTINCT and SELF-DESCRIBING at the exit sites, and guarantee every run leaves a typed result.json even on a thrown body. No per-model/per-task logic.

1. **Stop conflating "spawn failed" with "schema retries exhausted"** (agent.mjs:483-485): only a true schema-validation MISS (the Error tagged `.schemaErrors` at agent.mjs:470) yields the by-design soft null; a spawn-level reject (no `.schemaErrors`) rethrows into the catch at 496 and is captured `status:'error'` with the 404 message — identical to today's text path.
```js
// agent.mjs L483-485 — BEFORE:
//   // schema path exhausted retries -> null (never throw on a stubborn model). text path -> rethrow.
//   if (schema) return null
//   throw lastErr
// AFTER (a stubborn-but-VALID miss still -> null; a 404/overload/crash now throws -> status:error):
   if (schema && lastErr && lastErr.schemaErrors) return null   // only a real schema MISS soft-nulls
   throw lastErr                                                // spawn/infra failure fails loudly
```

2. **Always write a typed result.json, even on a thrown body** (runtime.mjs catch L257-260) — THIS IS MANDATORY, it closes the standalone-crash regression and removes the bug-1×bug-2 interaction (the wake's resultPath always resolves):
```js
// runtime.mjs catch (L257) — add the durable crash artifact before rethrow:
   } catch (e) {
     emitProgress(runCtx, { type: 'run:done', ok: false, ms: Date.now() - startedAt, calls: runCtx.calls, tokens: runCtx.tokensSpent, preview: previewOf(e && e.message ? e.message : e) })
     if (memDir) {
       try {
         mkdirSync(memDir, { recursive: true })
         writeFileSync(join(memDir, 'result.json'), JSON.stringify({ result: null, ok: false, error: e && e.message ? e.message : String(e), resultKind: 'error', meta, stats: runCtx.stats() }, null, 2))
       } catch { /* best-effort */ }
     }
     throw e
   }
```
(The success-path result.json at L265 stays byte-identical — the `ok/error/resultKind` keys appear ONLY in the new crash artifact, a shape nobody read before.)

3. **Self-describing leaf record**: stamp a `resultKind` discriminator (`'object'|'text'|'null'|'error'`) into the `captureLeaf` record — the engine knows the kind at each exit, so it is a one-field tag, not sniffing. LEAF RECORD ONLY (do not touch the success-path result.json envelope).
```js
// agent.mjs success captureLeaf (L494) — add the discriminator + a parsed sidecar for text leaves:
   const _kind = (out === null && schema) ? 'null' : (typeof out === 'string' ? 'text' : 'object')
   const _rj = (_kind === 'text') ? _tryJson(out) : null   // _tryJson already defined at agent.mjs:286 — no new code
   captureLeaf(ctx.memDir, { nodeId: i, /* ...existing fields... */, status: (out===null&&schema)?'null':'ok',
     resultKind: _kind, result: out===undefined?null:out, ...(_rj!=null ? { resultJson: _rj } : {}), /* ... */ })
// agent.mjs error captureLeaf (L498) — add `resultKind: 'error'`.
```

4. **Document the contract once** in `plans/blitzos-blitzscript.md`: a ~30-line "leaf-capture + result.json schema" section listing the flat leaf record fields, the `{result,meta,stats}` envelope, the new `{result:null,ok:false,error,resultKind:'error'}` crash envelope, and the `resultKind` values.

5. **CUT for now** (per stress): the harness `is_error` envelope guard (the real 404 exits non-zero, already caught). Leave a TODO at agent.mjs:484. (See "What the stress pass changed" correction 2.)

**Verification test.** Extend `scripts/tests/test-wf-leaf-capture.mjs` (drives the real workflow-host + real capture with a stubbed spawn via `_setSpawn`):
- (A) a spawn that REJECTS like `_defaultSpawn` on a 404 → assert the captured leaf is `status:'error'` with the 404 in `.error` AND `resultKind:'error'` (was `status:'null'` before).
- (B) a spawn returning well-formed claude json whose `structured_output` FAILS the schema → assert `status:'null'`, `result:null`, `resultKind:'null'` (the by-design soft-null is PRESERVED — gated by `lastErr.schemaErrors`).
- (C) a STANDALONE schema leaf that 404s, run end to end → assert the run rethrows AND `result.json` exists with `{result:null, ok:false, error:<404>, resultKind:'error'}` (the crash artifact).
- (D) a TEXT leaf that emits a JSON string → assert both `result` (the string) and `resultJson` (the object) are present.

The standalone-crash + artifact assertions (C) are the load-bearing proof; `/tmp/blitz-wf-debug/editor/` holds the standalone-today / standalone-fix / standalone-both runs that flip exactly as (C) asserts.

**Contract it preserves.** PRESERVES the intentional soft-null: a stubborn-but-schema-valid model that cannot emit valid JSON after retries still returns null (gated by `lastErr.schemaErrors`, set ONLY at agent.mjs:470 — verified). The resume journal hash (`_hashCall`, agent.mjs:246-249) folds opts not results, and `journalRecord` still runs on success only (inside the try, agent.mjs:474/478) — both the null AND throw paths never journal, so resume is byte-identical. result.json/leaves readers keep every existing field: `osReadLeaf` (osActions.ts:958) `JSON.parse`s and returns the whole object blind (no key enumeration); `IslandLeafDrawer.tsx:18` already branches on `status === 'error'`. So `resultKind`/`resultJson` and the `null→error` flip are safe. `agent()`'s return contract (object|string|null) is unchanged, so workflow body code is unaffected. The one behavior change is correct OS behavior: a standalone leaf's infra-failure now fails the run loud (and leaves a typed artifact) instead of laundering a 404 into `{synthesis:null}` success; `opts.retries` still cushions transient flakes.

**Known residual (Shape C, TODO).** A zero-exit leaf with `is_error:false`, real tokens spent, and prose instead of the structured object (model declined / content-filtered with a non-error envelope) still soft-nulls as `resultKind:'null'`, indistinguishable from a true schema miss. This is defensible (a model that ran and refused arguably IS a miss), but to keep the disk artifact legible, optionally stamp the non-run tell (`tokens===0 && sessionId===''`) into the leaf so a reader can tell "child never ran" from "model refused." Not load-bearing; add if it bites.

---

### 4. Relay inflight cap with no durable sweep (bug 4) — OUT OF agent-os. Effort M.

**This is NOT in the agent-os repo.** The load-bearing fix ships in `~/agent-socket` (the relay). The agent-os side is a defensive mitigation only.

**Root mechanism.** The limiter is the per-session Durable Object in `~/agent-socket/relay/src/relay-do.ts` (`MAX_INFLIGHT=10`, L28/L466). Only concurrent in-flight tool calls on the one agent-socket WS that have not yet received a `tool_reply` count toward 10 (NOT browser connections, NOT in-process workflow leaves — `run_workflow` returns fast and runs its leaves in-process, occupying ZERO slots). Each slot is added at L490 with a per-slot `setTimeout(MAX_SYNC_TOOL_MS=30000)` meant to evict it. The will-not-clear failure is structural: there is NO `alarm()`-based durable sweep. A Cloudflare DO `setTimeout` is not a free-running wall clock — CF only advances DO timers when the isolate gets execution time, so between WS frames the 30s timers STARVE and never fire (the author's own comment L100-105 flags "CF evicts ~70-140s; not designed for it"). When they don't fire, the 10 pending entries sit forever (proven by a real ~21-min idle gap in chat-34 with the cap STILL full). The only reliable clear is the WS dropping → `onClose` L93-97 `pending.clear()` — exactly what an app restart does. BlitzOS contributes by orphaning the old DO on reconnect, but its own handlers never hang (all bounded ≤20s, SDK always replies session.js L236/L240), so the leak is relay-side timer starvation, not an agent-os never-resolving handler.

**The one structural fix (relay-side, in `~/agent-socket`).** Replace the per-slot `setTimeout` with a DO `alarm()`-driven sweep. Alarms are scheduler-guaranteed and durable in CF — they survive isolate starvation. On each `tool_call`, store the pending entry's `startedAt` (not a per-slot timer) and `ctx.storage.setAlarm(now + MAX_SYNC_TOOL_MS)` if no earlier alarm is set; in `alarm()`, evict every pending entry older than `MAX_SYNC_TOOL_MS` (resolve 504) and re-arm for the next-oldest. Also make the 429 HONEST: include `pending.size` + oldest-pending-age so the agent can distinguish "genuinely busy" from "stuck cap."

```ts
// relay-do.ts — interface L34-37:
//   interface PendingRequest { resolve: (r: Response) => void; startedAt: number }
// tool-call slot, L484-491 — drop the per-slot timer, arm a durable alarm:
   const id = crypto.randomUUID()
   const promise = new Promise<Response>((resolve) => { this.pending.set(id, { resolve, startedAt: Date.now() }) })
   await this.ctx.storage.setAlarm(Date.now() + parseInt(this.env.MAX_SYNC_TOOL_MS || '30000', 10)) // coalesced; alarm() re-arms
// new method:
   async alarm(): Promise<void> {
     const ttl = parseInt(this.env.MAX_SYNC_TOOL_MS || '30000', 10); const now = Date.now(); let next = Infinity
     for (const [id, p] of this.pending) {
       if (now - p.startedAt >= ttl) { this.pending.delete(id); p.resolve(errorResponse('tool_timeout', `tool exceeded ${ttl}ms`, 504)) }
       else next = Math.min(next, p.startedAt + ttl)
     }
     if (next !== Infinity) await this.ctx.storage.setAlarm(next)
   }
// too_many_inflight honesty, L466-467:
   const oldest = Math.max(0, ...[...this.pending.values()].map(p => Date.now() - p.startedAt))
   return errorResponse('too_many_inflight', `max ${MAX_INFLIGHT} concurrent calls (in-flight ${this.pending.size}, oldest ${oldest}ms)`, 429)
// onClose L93-97 keeps clearing pending (no timers to clear now; drop the clearTimeout).
```

**The agent-os mitigation (defense-in-depth, NOT the root fix).** In `src/main/relay.mjs`, on a relay WS reconnect, explicitly `close()` the PRIOR ws BEFORE opening the new session so the orphaned DO's `onClose` fires `pending.clear()`, instead of abandoning it with a full cap (today relay.mjs reconnect mints a new sessionId without closing the old socket). GATE this on the new session being registered first, so no in-flight `tool_reply` on the old socket is lost.

**Verification test.** Relay-side: extend `/tmp/blitz-wf-debug/bug4/relay-inflight-repro.mjs` (the faithful transcription that reproduced the 429 + no-drain) to model the `alarm()` path: fill 10 never-replying slots, assert the 11th 429s, FIRE `alarm()` at `startedAt+ttl`, assert all 10 evict with 504 and a fresh call returns 200 — proving the cap self-drains WITHOUT a WS close (the property the production bug lacked). Assert the 429 body now reports in-flight=10 + oldest-age. If the relay repo has a workerd/vitest harness, port it as a DO alarm test there. agent-os side: a unit assert that the reconnect path calls `ws.close()` on the prior socket before minting a new session.

**Contract it preserves.** The `alarm()` sweep keeps the existing `too_many_inflight`/`tool_timeout` contract (same 429/504 codes, same `MAX_SYNC_TOOL_MS` budget) — only the EVICTION mechanism changes from a starvation-prone `setTimeout` to a durable alarm, so a healthy call path is byte-identical and only the stuck-cap case is fixed. Enriching the 429 body is additive. `hibernate:false` stays (the WS must stay resident; the alarm is independent of hibernation). agent-os mitigation: closing the old ws must not race a `tool_reply` still in flight — gate on the new session registering first.

---

## Items OUT of the agent-os repo

- **Bug 4's load-bearing fix (the relay inflight cap)** lives in `~/agent-socket/relay/src/relay-do.ts`, a separate repo with its own Cloudflare deploy. The agent-os change for bug 4 is a defensive mitigation in `src/main/relay.mjs` only (close the old WS on reconnect). The `alarm()`-sweep + honest-429 must ship in the relay repo.

## Open questions for the human before applying

1. **Bug 1 group semantics — confirm the resolved answer is intended.** `parallel`/`pipeline` already coalesce a thrown leaf to a null slot, so a run with N/M failed scouts returns PARTIAL results (the survivors) and reads `failed>0` in `group:done`, while each failed leaf is captured `status:'error'`. The STANDALONE synthesis leaf, by contrast, now crashes the run (leaving a typed crash result.json). Is "fan-out = partial + per-leaf error, standalone = loud crash + crash artifact" the intended product behavior? (If you instead want a fan-out's `failed>0` surfaced into the completion wake / result.json so the agent learns the run was DEGRADED without grepping leaves, that is an additional small change — say so.)

2. **Bug 1 — should we ship the Shape-C non-run tell now?** A zero-exit model that ran-but-refused soft-nulls indistinguishably from a true schema miss. Stamping `tokens===0 && sessionId===''` into the leaf separates "never ran" from "refused." Ship it, or leave the TODO?

3. **Bug 6 — confirm `resultKind`/`resultJson` stay in the LEAF record only** (the stress recommendation), keeping the success-path `result.json` envelope byte-stable. The new crash-path result.json (`ok:false`/`error`/`resultKind:'error'`) is a fresh shape and is fine. Agree?

4. **Bug 2 — confirm a `'workflow'` moment is agent-PRIVATE** (only the launcher wakes), not also visible to the supervisor `'0'`. The plan makes it private (matches the per-agent chat model). If `'0'` should also see peers' completions, that is a one-line change to `visibleTo`.

5. **Bug 5 — sidecar only, dir-namespacing deferred?** Confirm the `meta.json` sidecar is sufficient and we are NOT also moving runs under `.blitzos/workflows/a<agentId>/<runId>` (which would touch the renderer's `osWfRunMemDir` resolver). The plan defers the dir change.

6. **Bug 4 — ownership/permission to change `~/agent-socket`** and confirm `MAX_SYNC_TOOL_MS` (30s) is the desired eviction TTL for the alarm sweep (or raise it for legitimately long sync tools).
