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

## Cross-references
- `plans/blitzos-job-task-model.md`: the Job spine (read first)
- `plans/blitzos-plan-widget.md`: W1 + E3 widget
- `plans/blitzos-tick-diff-steer.md`: W2 supervisor heartbeat
- `plans/blitzos-job-entrypoints.md`: Phase 2 A/B + A5/[N]
- `plans/blitzos-agent-autonomy-guardrails.md`: E1 continuation + the Phase-1 plan-authoring duty
- `plans/onboarding-case-file.md`: Phase 1 onboarding
- `agent-os/CLAUDE.md` "Agent runtime (perception → moments → wake)": the doctrine W2 and the continuation engine must honor
