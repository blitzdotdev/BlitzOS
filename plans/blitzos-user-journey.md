# BlitzOS — New-User Journey: Onboarding → Job → Planning → Execution

Status: INDEX + verified build-status (deep map done 2026-06-16/17 against branch `agent-runtime-moments-brandon-spatial-merge`, 8 subsystem readers, file:line-cited). This doc is the MAP; the four sub-specs carry the implementation detail. Every ✅/🟡/⬜ below was checked against the live tree.

The end-to-end journey a new user takes through BlitzOS: first launch, start a job (or just make a normal request), plan it, then run it while it steers itself. **The linchpin finding: there is no first-class Job object anywhere in BlitzOS today (agents are uniform peers), and almost every gap downstream depends on adding it.** A **Job** is the one formalized unit of work (plan + execute + steer); everything else is a **normal request** the agent just handles in the existing chat. The encouraging half: the hard plumbing already exists (per-agent spawn + canvas placement, the boot-task duty seam, the three widget callback channels, the `/events` wake loop, `emitUserMessage` steering delivery, supervisor='0' routing for free). The refactor is mostly *framing on mature seams*, not new infrastructure.

Legend: ✅ built · 🟡 partial (primitives exist) · ⬜ not built

| Sub-spec | Scope | Headline |
|---|---|---|
| `blitzos-job-task-model.md` | the **Job** object, B3 job-framing | the spine; everything sequences after it |
| `blitzos-plan-widget.md` | W1 editable plan widget + E3 job-status widget | callback channels exist; build widget+prompt+return-loop on them |
| `blitzos-tick-diff-steer.md` | W2 supervisor heartbeat (Option A) | host-side diff of USER+agent world; P0 = snapshot widget content into props (srcdoc/app/native) |
| `blitzos-job-entrypoints.md` | Phase 2 A/B shared input, A2/A3/A4, A5 menubar + [N] | mostly glue over existing primitives; A3 discovery is the hard problem |
| `blitzos-agent-autonomy-guardrails.md` (exists) | E1 continuation engine + the Phase-1 plan-authoring duty | wait.sh backgrounded ✅; continuation engine ⬜ |
| `onboarding-case-file.md` (exists) | Phase 1 onboarding (scan, profile, board, interview) | mostly built |

---

## Build status (host-side slices landed on branch `blitzos-journey-build`, 2026-06-17)

All committed + headless-tested (8 suites green, `npm run typecheck` + `npm run build` green). The spine of the journey (Job → plan → execute → steer) plus the Phase-2 Shell A entry point are built. What remains is visual / runtime / needs-sign-off, not more headless code.

| Slice | Status | Commit | Headless test |
|---|---|---|---|
| Job model (Option 1: Job on per-agent `meta.json`) + `start_job` / `set_job_status` tools | ✅ | 671e355 | `test-job-model` |
| W1 editable plan widget + the two-step (`setProps` + tiny `sendMessage` + `get_surface`) return channel | ✅ | c74787f | `test-plan-widget` |
| E1 continuation engine (plan.md-gated Stop hook + spin-guard) | ✅ | c08e069 | `test-continue-hook`, `test-plan-doc`, `test-plan-continuation` |
| W2 tick → diff → steer; a `srcdoc`/`native` props-edit wakes supervisor '0'; echo + bulk self-reaction guards | ✅ | 26a824d | `test-tick-diff` |
| P0 cooperative path (the plan widget pushes its content via `blitz.setProps` → the tick diffs it → steer) | ✅ | in 26a824d | `test-tick-diff` #10/#14a |
| Phase-2 Shell A: standalone job launcher (global ⌥Space bar → `start_job`) | ✅ | 94238ec | `test-launcher` |

Each committed slice above is detailed in **Implementation log + decisions I made** near the end of this doc: how it was built, the calls I made where the spec left a blank (so you can override them), and the full not-yet-built list.

---

## The flow

```
┌────────────────────────────────────────────────────┐
│ ONBOARDING  ·  first launch                        │
│ scan machine → profile → board → interview         │
└────────────────────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────┐
│ START  ·  one Raycast input, two shells            │
│ A) macOS helper (global)   B) in-app HUD (keybind) │
│ prompt + drop files + add windows  →  Send         │
└────────────────────────────────────────────────────┘
                           │
                           ▼
                    « is it a Job? »
                           │
                           ├────►  no: a normal request, the
                           │       agent just handles it in
                           │ yes   chat. no plan, no loop.
                           ▼
┌────────────────────────────────────────────────────┐
│ PLANNING  ·  W1                                    │
│ job agent writes an editable plan widget;          │
│ user edits → AI updates → approve?                 │
│ (reject loops back here)                           │
└────────────────────────────────────────────────────┘
                           │ submit
                           ▼
┌────────────────────────────────────────────────────┐
│ EXECUTION  ·  E1                                   │
│ /goal runs the approved plan until it is done      │
└────────────────────────────────────────────────────┘
                           │ diff                ▲ steer
                           ▼                     │
┌────────────────────────────────────────────────────┐
│ W2 SUPERVISOR  ·  every ~N seconds                 │
│ diff the world (user + agent state),               │
│ steer the job, or let it keep running              │
└────────────────────────────────────────────────────┘
                           │ done
                           ▼
                       ┌────────┐
                       │  DONE  │
                       └────────┘
```

---

## The linchpin: the Job object

Verified: nothing in state, store, persistence, or the 38-tool registry models a unit of work. The only lifecycle object is `interview.json` (a 2-state machine); the only behavior switch is which free-form duty STRING the one `setBootTaskProvider` seam injects (`index.ts:654`, special-cased to agent '0'). So **B3 job-framing, W1's widget binding, W2's steering target, E1's continuation arming, and the A4 Send payload all reference an object that does not exist yet.** Build it first. A **Job** is the one formalized unit (it triggers Planning + Execution + steering); everything else is a **normal request** the agent just handles in the existing chat (no Job, no plan, no continuation). Full spec, including the record shape and the Job-vs-normal-request line, is in `blitzos-job-task-model.md`.

**The decision that gates the whole refactor (needs your sign-off, touches core persistence):**
- **Option 1 (recommended for v1):** store the Job on the existing per-agent `meta.json` (`.blitzos/terminals/<id>/meta.json`), 1:1 agent:job. Smallest diff, reuses agent lifecycle + restart survival.
- **Option 2:** a dedicated `.blitzos/jobs/<id>.json` with `agentIds[]`, decoupled. Clean for v2 multi-agent jobs, but a third persistence path to keep in sync.
- My lean: **Option 1 with a migration-ready record shape** (name it `Job`, abstract the reader/writer, store `agentId` now so it can become `agentIds[0]` later) so v2 is a mechanical swap, not a rewrite.

---

## W3: Session-summary widget (rolling 2-minute summary)

A widget that keeps the agent's context continue-able, with two panes refreshed every 2 minutes:
- **Top (summary):** a cumulative summary of everything so far, compressed.
- **Bottom (raw):** the last 2 minutes of activity verbatim ("as it is").

Each cycle, fold the current bottom (the 2 minutes that just elapsed) into the top summary, then refill the bottom with the freshest 2-minute raw window. The top grows a rolling summary while the bottom always holds the exact most-recent tokens, so the agent (or a fresh session) can continue without losing recent fidelity or older gist. Coarser cadence than W2's ~10s steering tick; it feeds on the same perception stream (the bottom pane = the recent moments across all surfaces, so it wants the P0 all-surface perception too). Build it as a `srcdoc`/jsx widget the agent drives via `update_surface` (widget mechanics: `blitzos-plan-widget.md`).

---

## Phase-by-phase: built vs to build

**Phase 1: Onboarding (mostly ✅).** The Case File flow (`onboarding-case-file.md`): scan → profile → board → interview are built. **O2b is the one correction: partial → ⬜.** No API integration path exists; the OAuth/integrations subsystem was removed 2026-06-16 (629b40d) for browser-first auth. Reconcile by reframing O2b as "open and read the user's already-logged-in Drive/Gmail/GitHub tabs" (no tokens), the architecture-aligned option. O5 stays 🟡 (board.json + scan.json are the pointer set; no queryable index artifact).

**Phase 2: Job setup (mostly ⬜).** A and B are entry points, not import-vs-spawn, and they **share ONE Raycast-like input with two shells** (global non-activating NSPanel for A, in-app keybind HUD for B; same affordances: prompt + drag-drop + add-browser-window + Send). On Send, a **Job** is started (which triggers Planning); a plain message that is not started as a Job stays a normal chat request. The Send path is glue over existing primitives (`osSpawnAgent → osIngestPaths → create_surface{web} → osSay`); the new parts are the input component, a first-ever `globalShortcut`, A2's symlink mode + context bucket, and A3. **A3 is the hard one:** the `~/agent-socket` Chrome extension has zero BlitzOS link and only mints its own relay session, and discovery is blocked (a sandboxed extension cannot read `~/.blitzos/session.json`, and the control server binds an ephemeral port). Full spec + the recommended discovery reframe: `blitzos-job-entrypoints.md`. The Job model + J-agents semantics depend on the Job object (`blitzos-job-task-model.md`).

**Phase 3: Planning (⬜, = W1).** No plan widget exists (16 library widgets, none is "plan"; no `role:'plan'` surface; no Submit/Reject). But the widget↔agent callback plumbing already exists in three verified forms (`sendMessage`→`message`, `__blitz:'action'`→`action` capped 4000B, `setProps`), and the agent→widget update-in-place direction is fully built. So W1 is "author one widget + pick a return channel + write the authoring idiom," not from zero. Spec: `blitzos-plan-widget.md`. The agent's plan-authoring DUTY is in `blitzos-agent-autonomy-guardrails.md` (Phase 1).

**Phase 4: Execution (🟡, = W2).** E1's prerequisite is done (wait.sh runs in the background so the agent yields), but the continuation engine (a `plan.md`-gated Stop hook + stage-status convention + spin-guard) has zero code; `plan.md` itself is spec-only. E2 (W2) reuses the `/events` wake channel, the `emitUserMessage` steering delivery, and free supervisor='0' routing verbatim; only the tick emitter + the diff are new. The tick diffs a UNIFIED host-side snapshot of **widget content (the user-action half) + agent state** (so a user edit to the `srcdoc` plan widget steers the implementing agent). **P0: capture widget content by snapshotting it into `props` via the widget bridge** for `srcdoc`/`app`/`native` only (`web`/browsers are out of scope, being removed); the diff runs host-side because `props` are stripped from the agent's `list_state`. **Option A is the rule: BlitzOS ticks + diffs + emits the diff as perception; the agent owns all steering judgment, zero per-task heuristics in the OS.** Spec: `blitzos-tick-diff-steer.md` (E2/W2) and `blitzos-agent-autonomy-guardrails.md` (E1 continuation). E3's widget half is ⬜ by convention only (the `update_surface{props}` live-update path is built; there is just no durable per-job status widget yet, which the W1 widget morphs into).

**[N] Notification (🟡).** Status reaches the user in-app only (the chat status pill, the action-items inbox badge, a crash chat line) and requires the BlitzOS window to be focused. No native OS notification, no menubar/Tray, no dock badge anywhere. The outward fabric (A5 Tray + a `notify.ts` + a dock badge, fired on a content-agnostic whitelist) is specced in `blitzos-job-entrypoints.md`.

---

## Sequencing (the whole refactor)

1. **Decide Job persistence (Option 1 vs 2)** and the related primitives (`role:'plan'` surface, `start_job` tool). These need sign-off; they gate everything. → `blitzos-job-task-model.md`
2. **Land the Job** record + reader/writer + the generalized boot-task mapper (falling through to onboarding unchanged) + the `start_job` + transition tools. This unlocks Jobs and B3-as-job; normal requests are unchanged.
3. **W1 plan widget** on top (binds `Job.planSurfaceId`/`planPath`), plus the prerequisite prose fixes from the guardrails doc.
4. **E1 continuation engine** armed on a Job's `approved → running`. → `blitzos-agent-autonomy-guardrails.md`
5. **W2 tick → diff → steer** (ships decoupled: status/terminal/surface deltas alone wake the supervisor; plan-awareness is a later enrichment). → `blitzos-tick-diff-steer.md`
6. **Entry points** (A/B shared input, A4 Send, A2/A3) and **outward surfaces** (A5/[N]) once the Job gives the Send a payload to mint. → `blitzos-job-entrypoints.md`
7. **O2b reframe** (browser-first read of logged-in tabs) and the E3 job-status widget, both low-risk, any time after the Job lands.
8. **W3 session-summary widget** (rolling 2-min summary + raw window) on the perception stream, any time after the event stream + all-surface perception (P0) are in place.

## Decisions needing sign-off (consolidated)

1. **Job persistence:** Option 1 (agent meta) vs Option 2 (dedicated record). Lean Option 1, migration-ready. → job-task-model
2. **`role:'plan'` surface:** a new surface-role primitive for the W1 widget binding (decides three-serializer vs both-isRuntime-predicate handling). → job-task-model / plan-widget
3. **`start_job` tool** vs extending `spawn_agent` (it stays the bare-peer / normal-request primitive; affects the agent-socket contract across all three transports). → job-task-model
4. **W1 return channel:** the no-core-edit two-step (setProps + tiny sendMessage + `get_surface`) vs raising the App.tsx 4000-byte cap. Lean the two-step. → plan-widget
5. **W2 new perception primitive** (`setTickSource` + `emitTick` + `trigger:'tick'`), its cadence, the host-side `chatStatusSnapshot()` accessor, and a `/steer` tool vs wiring wake into `/say`. → tick-diff-steer
6. **A2/A3 core touches:** `ingestPaths` symlink mode + Job context association; the A3 extension discovery mechanism (recommended: the "hand BlitzOS a URL to open the logged-in tab" reframe). → job-entrypoints
7. **Onboarding interview as the FIRST Job** (unify the two duty strings) vs keeping it a special path. Lean: generalize the mapper first with onboarding unchanged, unify later. → job-task-model

## Implementation log + decisions I made (build of 2026-06-17)

A record of HOW each landed slice was built, the calls I made on my own where the spec left a blank (flagged so you can override them), and what is deferred. All committed on `blitzos-journey-build`, headless-tested (8 suites + typecheck + build green). You answered two of the seven sign-off decisions directly (Option 1 persistence; Option A for W2); for the rest I took the recommended option, noted per slice.

### 1. Job model — `src/main/job-model.mjs` (671e355)
HOW: a Job is a `job` object on the existing per-agent `.blitzos/terminals/<id>/meta.json` (Option 1, 1:1 agent:job). `JOB_STATUSES = ['proposed','approved','running','done','blocked']`; a Job always plans before it executes. `makeJob(spec)` builds a `proposed` job WITHOUT writing it, so `start_job` stamps it onto the meta BEFORE the terminal launches (the first bootstrap already carries the planning duty). `dutyForJobStatus` maps proposed|approved → `JOB_PLAN_DUTY`, running → `JOB_EXECUTE_DUTY`, done|blocked → null. `wireJobModel({getTerminalsDir})` is the DI seam. Tools `start_job {goal,title?,contextRefs?}` + `set_job_status {agent,status?,planSurfaceId?}` registered once in `os-tools.mjs` for all three transports.
DECISIONS I MADE: the five-state lifecycle and the always-plan-first rule; `start_job` as a NEW tool with `spawn_agent` left as the bare-peer primitive (sign-off 3); `JOB_PLAN_DUTY` as a five-step protocol (author widget, bind `planSurfaceId`, write `plan.md`, present + ask approve/edit/reject, reconcile on edit). The blocker fix after adversarial review: inject the planning duty by stamping the job pre-launch, NOT a post-spawn re-exec (the re-exec was a silent no-op since a just-born agent has no `claudeSessionId`).
DEFERRED: v2 multi-agent jobs (the record is migration-ready); unifying onboarding-as-first-Job (sign-off 7: I generalized the boot mapper but left onboarding on its own duty).

### 2. W1 editable plan widget — `widgets/plan.jsx`, `widget-ui-kit.ts` (c74787f)
HOW: a lean functional `srcdoc` widget (edit mode + read-only status mode). Return channel = the no-core-edit TWO-STEP: push the full plan via `blitz.setProps`, then a tiny `blitz.sendMessage` carrying `props.agentId`; the agent reads the plan back via `get_surface`. Dodges the 4000-byte `__blitz:'action'` cap. Added `<blitz-edit>` + `<blitz-toggle>` kit elements + the authoring idiom doc.
DECISIONS I MADE: the two-step channel over raising the App.tsx 4000-byte cap (sign-off 4); the widget is `srcdoc`, never `native`; the tiny shell-parseable `plan.md` grammar shared with E1. Fixed a stale-closure bug (functional updaters + a ref).
DEFERRED: E3's durable status widget is this same widget in status mode (no separate build).

### 3. E1 continuation engine — `agent-runtime.mjs`, `plan-doc.mjs` (c08e069)
HOW: a `plan.md`-gated Stop hook keeps a RUNNING Claude job driving until its plan is done. `installContinuationHook` returns null unless `isClaude && readJob(id).status==='running'`; `buildClaudeCommand` merges the hook into `--settings`. `plan-doc.mjs` parses `<ws>/.blitzos/jobs/<id>/plan.md` into `{status,stages,complete,blocked}`; the grammar is tiny so the SHELL hook can parse the SAME doc with no JS runtime.
DECISIONS I MADE: `SPIN_GUARD_LIMIT = 3` (three consecutive no-change continues then stop + flag `stuck`); the `plan.md` path + front-matter `status:` + checklist grammar; arm ONLY for Claude jobs in `running`.
DEFERRED: a Codex-equivalent continuation (returns null for Codex by design); spin-counter cleanup on re-arm.

### 4. W2 tick → diff → steer — `perception-core.mjs`, `osActions.ts` (26a824d)
HOW: a host heartbeat off the existing `sweepTimer`. `setTickSource(fn)` feeds a unified snapshot each tick (surfaces incl. `props` from `cached`, per-agent status, terminals, workspace); `emitTick` diffs against the prior tick and emits ONE content-FREE `trigger:'tick'` moment of only what changed, to supervisor '0' over the existing `/events` loop. `/steer {agent,text}` → `emitUserMessage`.
MATERIALITY (my design): agent status EDGES only (`working` → `waiting|stopped|error`; `*` → `error` always); a surface `props` EDIT (the user-action half); open/close/move/geometry are NOT diffed here (the `canvas` moment owns them); an empty diff emits nothing.
DECISIONS I MADE: `TICK_MS = max(2000, BLITZ_TICK_MS || 10000)` (10s default, sign-off 4); the self-reaction guard is a per-delta one-shot `absorbTickEcho` + `resetTickBaseline` for bulk, which REPLACED a fragile `Date.now()` window after adversarial review proved the window self-woke ~70% of the time at 10s; `/steer` as a new tool (sign-off 6); flags+ids only with content pulled via `get_surface` (sign-off 7).
P0: the COOPERATIVE path is done (the plan widget pushes content via `setProps`, the tick diffs the `props` delta, the supervisor wakes; `test-tick-diff` #10/#14a). The GENERIC auto-serializer (a MutationObserver in the widget bridge for non-cooperative widgets) is deferred (it lives in the sandboxed iframe, renderer/runtime).

### 5. Shell A standalone launcher — `src/main/launcher.ts` (94238ec)
HOW: a frameless transparent always-on-top NSPanel (the onboarding drag-helper recipe but `focusable:true`), toggled by the first `globalShortcut` in the tree. Self-contained inline HTML (`data:` URL); Send → `ipcRenderer.invoke('launcher:start-job')` → `electronOps.startJob({goal})`, which mints a Job whose planning agent authors the plan widget. `wireLauncher({startJob,focusMain})` DI seam; a guarded `agentOS.launcher` preload bridge; fully isolated from the renderer.
DECISIONS I MADE: default keybind ⌥Space (`Alt+Space`), `BLITZ_LAUNCHER_HOTKEY` override (the canonical launcher chord, also why Raycast had to go); v1 scope = prompt + Send only; a standalone isolated window over wiring into App.tsx (to protect your WIP); a taken chord is logged-not-fatal.
IN PROGRESS (your 2026-06-17 feedback): the bar hid on blur, which defeated attaching, so keep-open-while-gathering + A2 drag-drop attachment chips (passed as `contextRefs`) are being built; A3 add-browser-tab is the next piece (needs an in-browser "add" affordance).

### Cross-cutting
- DECISIONS YOU MADE (not my fill-ins): Option 1 persistence; Option A for W2 (the OS ticks/diffs/emits, the agent owns all steering, zero per-task heuristics in the OS).
- TWO production bugs adversarial review caught + I fixed pre-commit: the `start_job` re-exec no-op; the W2 timing-window self-wake.
- `.d.mts` discipline: every new `.mjs` export has a hand-written declaration sibling (typecheck enforces it).

### Not yet built (visual / runtime / sign-off remainder)
- P0 generic auto-serializer (MutationObserver in `widget-bridge` for non-cooperative widgets): renderer/iframe runtime.
- Shell B in-app HUD (the same UI behind an in-app keybind): renderer, touches `App.tsx` (your WIP).
- A2 drag-drop file context + A3 add-browser-tab: IN PROGRESS (see Shell A above).
- A5 Tray + [N] notifications + dock badge: native OS surfaces, runtime/visual.
- W3 session-summary widget: open cadence design (a new 2-minute host primitive vs a pure agent-duty on the existing wake stream).
- E3 job-status widget: subsumed by W1's status mode.
- O2b: out of scope (browsers being removed).

## Pass 2 TODO (post-spine backlog)

Pass 1 (the slices in "Build status" + "Implementation log" above) is the journey spine + Shell A, built and headless-tested. Pass 2 is the next wave; items get appended here as they are scoped.

1. **Workflows framework + the independent verifier (its first consumer).** A general BlitzOS feature: an agent gets a REPL and authors dynamic-workflow programs (the `agent()` / `parallel()` / `pipeline()` orchestration shape) to fan out parallel, independent LLM calls. The **E1 job verifier** (an independent LLM that checks a worker truly finished its plan, the stronger gate over the deterministic `plan.md` Stop hook) is ONE invocation: `workflow('verify-job', …)` that semantically CHUNKS the worker's session (parallel, so it beats a single context window), verifies each chunk, then a META LLM verifies each chunk-verdict and reduces to a final verdict (map-reduce + verify-the-verifier). Build the FRAMEWORK first; the verifier is its first consumer, NOT a bespoke `verifier.mjs`. Must work across `claude -p` / `codex exec` / any generic harness, with sufficient context + grep access to the worker's raw session. Researched plumbing (2026-06-17): harness-agnostic session source = `<ws>/.blitzos/terminals/<id>/transcript.jsonl` (raw pty, both claude+codex) or the tape `<root>/.blitzos/tape/` (chunk THAT, not `~/.claude`; Codex persists no Claude-style JSONL); completion gate = `set_job_status status:"done"` (`electron-os-tools.ts:93`, all transports); a POSIX Stop-hook reaches the host via `~/.blitzos/session.json` local url+token, not `relay-url`. RESOLVED 2026-06-17 -> detailed spec `plans/blitzos-blitzscript.md` ("blitzscript": JS, NO sandbox, `llm()` = a local `claude -p` / `codex exec` leaf on the user's machine, memory on the BlitzOS fs; depth-1 ENFORCED; the verifier + supervisor are workflows ON TOP). The per-agent **orchestrators** toggle replaces the Job model.

2. **Attach any macOS app to the live BlitzOS island (the native sidecar).** When the user toggles the blitz island (⌥Space) any app can be ATTACHED to the BlitzOS process open in the island, so BlitzOS can drive it for the current task. UX: an avatar of the app appears somewhere in the currently-focused app — the user CLICKS it to attach, or DRAG-DROPS that avatar into the island. Attach semantics by app kind:
   - **A browser tab is the special case (agent-socket).** On attach, parse WHICH tab the user had selected at that moment and establish an agent-socket connection to that exact tab, so BlitzOS drives it. (The `~/agent-socket` Chrome extension is installed during onboarding.) This IS the Pass-1 A3 "add-browser-tab" discovery, reframed: the island hands BlitzOS the live tab.
   - **Any other app -> computer use (osascript).** Attach means "use THIS app to do the task": BlitzOS drives it via the computer-use helper (osascript / accessibility) + the capture+input-synth approach (the native-app-embedding path).
   Lives in the native sidecar (`plans/blitzos-dynamic-island.md`) + the computer-use helper + agent-socket. The attached app/tab becomes a tool the blitzscript a workflow authors can drive. Subsumes Pass-1 A3.

3. _(more to come)_

## Cross-references
- `plans/blitzos-job-task-model.md`: the Job spine (read first)
- `plans/blitzos-plan-widget.md`: W1 + E3 widget
- `plans/blitzos-tick-diff-steer.md`: W2 supervisor heartbeat
- `plans/blitzos-job-entrypoints.md`: Phase 2 A/B + A5/[N]
- `plans/blitzos-agent-autonomy-guardrails.md`: E1 continuation + the Phase-1 plan-authoring duty
- `plans/onboarding-case-file.md`: Phase 1 onboarding
- `agent-os/CLAUDE.md` "Agent runtime (perception → moments → wake)": the doctrine W2 and the continuation engine must honor
