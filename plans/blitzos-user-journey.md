# BlitzOS — New-User Journey: Onboarding → Job/Task → Planning → Execution

Status: INDEX + verified build-status (deep map done 2026-06-16/17 against branch `agent-runtime-moments-brandon-spatial-merge`, 8 subsystem readers, file:line-cited). This doc is the MAP; the four sub-specs carry the implementation detail. Every ✅/🟡/⬜ below was checked against the live tree.

The end-to-end journey a new user takes through BlitzOS: first launch, set up a job or a task, plan it, then run it while it steers itself. **The linchpin finding: there is no first-class Job/Task object anywhere in BlitzOS today (agents are uniform peers), and almost every gap downstream depends on adding it.** The encouraging half: the hard plumbing already exists (per-agent spawn + canvas placement, the boot-task duty seam, the three widget callback channels, the `/events` wake loop, `emitUserMessage` steering delivery, supervisor='0' routing for free). The refactor is mostly *framing on mature seams*, not new infrastructure.

Legend: ✅ built · 🟡 partial (primitives exist) · ⬜ not built

| Sub-spec | Scope | Headline |
|---|---|---|
| `blitzos-job-task-model.md` | the **WorkUnit** (Job/Task object), J-split, B3 job-framing | the spine; everything sequences after it |
| `blitzos-plan-widget.md` | W1 editable plan widget + E3 job-status widget | callback channels exist; build widget+prompt+return-loop on them |
| `blitzos-tick-diff-steer.md` | W2 supervisor heartbeat (Option A) | reuse `/events` + `emitUserMessage`; only the tick emitter + diff are new |
| `blitzos-job-entrypoints.md` | Phase 2 A/B shared input, A2/A3/A4, A5 menubar + [N] | mostly glue over existing primitives; A3 discovery is the hard problem |
| `blitzos-agent-autonomy-guardrails.md` (exists) | E1 continuation engine + the Phase-1 plan-authoring duty | wait.sh backgrounded ✅; continuation engine ⬜ |
| `onboarding-case-file.md` (exists) | Phase 1 onboarding (scan, profile, board, interview) | mostly built |

---

## The board (corrected)

```
╔══════════════════════════════════════════════════════════════════════╗
║                          U S E R   J O U R N E Y                       ║
╠══════════════════════════════════════════════════════════════════════╣
║  [N] NOTIFICATION 🟡  in-app only (chat/inbox/system moment); no native ║
║                       OS notification or menubar yet → job-entrypoints  ║
║  [TODO]                                                                 ║
║   W1 ⬜ Plan-widget authoring prompt        → blitzos-plan-widget.md     ║
║   W2 ⬜ Tick → diff → steer (Option A)       → blitzos-tick-diff-steer.md ║
║   ★  Job/Task WorkUnit (linchpin)           → blitzos-job-task-model.md  ║
╚══════════════════════════════════════════════════════════════════════╝
 PHASE 1 ─ ONBOARDING ───────────────────────────────────────  mostly ✅
   O1 ✅ Spawn BlitzOS   O2a ✅ Local laptop scan   O3 ✅ Summarize life
   O4 ✅ User profile (interview)   O5 🟡 Index of pointers (board/scan.json)
   O2b ⬜ Integrations(API: Drive/Gmail/GitHub) ⚠ OAuth removed 629b40d;
          browser-first reframe recommended (read the logged-in tabs)
 PHASE 2 ─ JOB/TASK SETUP (two ways to START) ──────────────  mostly ⬜
   A) macOS helper ⬜   B) BlitzOS HUD ⬜   ← ONE shared Raycast input,
      two shells (global NSPanel for A, in-app keybind HUD for B)
      A2 drag/drop 🟡 (copy-only; no symlink, no context bucket)
      A3 add browser ⬜ (generic agent-socket ext exists, ZERO BlitzOS link)
      A4 Send ⬜ · A5 menubar ⬜ · B4 chat widget ✅
   J-split ⬜ (Job→plan+exec / Task→no plan)  ← needs the WorkUnit
   J-agents 🟡 (multi-spawn + claude/codex BUILT; Job/Task role +
               supervisor relationship NOT)
 PHASE 3 ─ PLANNING (Job only) ─────────────────────  ⬜ = W1
   P1–P4 ⬜ show widget → user edits → AI updates → execute?
          (widget↔agent callback channels already exist; build on them)
 PHASE 4 ─ EXECUTION ───────────────────────────────  🟡 = W2
   E1 🟡 /goal on plan (wait.sh backgrounded ✅; continuation engine ⬜)
   E2 ⬜ tick→diff→steer (= W2; supervisor='0' routing already free)
   E3 🟡 updates: chat ✅ + widget ⬜ (update_surface path exists; no
         durable per-job status widget yet)
```

---

## The linchpin: the Job/Task WorkUnit

Verified: nothing in state, store, persistence, or the 38-tool registry models a unit of work. The only lifecycle object is `interview.json` (a 2-state machine); the only behavior switch is which free-form duty STRING the one `setBootTaskProvider` seam injects (`index.ts:654`, special-cased to agent '0'). So **B3 job-framing, the J-split, W1's widget binding, W2's steering target, E1's continuation arming, and the A4 Send payload all reference an object that does not exist yet.** Build it first. Full spec, including the record shape and the Job-vs-Task reduction (it collapses to "which duty string + whether continuation arms"), is in `blitzos-job-task-model.md`.

**The decision that gates the whole refactor (needs your sign-off, touches core persistence):**
- **Option 1 (recommended for v1):** store the WorkUnit on the existing per-agent `meta.json` (`.blitzos/terminals/<id>/meta.json`), 1:1 agent:work-unit. Smallest diff, reuses agent lifecycle + restart survival.
- **Option 2:** a dedicated `.blitzos/work/<id>.json` with `agentIds[]`, decoupled. Clean for v2 multi-agent jobs, but a third persistence path to keep in sync.
- My lean: **Option 1 with a migration-ready record shape** (name it `WorkUnit`, abstract the reader/writer, store `agentId` now so it can become `agentIds[0]` later) so v2 is a mechanical swap, not a rewrite.

---

## Phase-by-phase: built vs to build

**Phase 1 — Onboarding (mostly ✅).** The Case File flow (`onboarding-case-file.md`): scan → profile → board → interview are built. **O2b is the one correction: partial → ⬜.** No API integration path exists; the OAuth/integrations subsystem was removed 2026-06-16 (629b40d) for browser-first auth. Reconcile by reframing O2b as "open and read the user's already-logged-in Drive/Gmail/GitHub tabs" (no tokens), the architecture-aligned option. O5 stays 🟡 (board.json + scan.json are the pointer set; no queryable index artifact).

**Phase 2 — Job/Task setup (mostly ⬜).** A and B are entry points, not import-vs-spawn, and they **share ONE Raycast-like input with two shells** (global non-activating NSPanel for A, in-app keybind HUD for B; same affordances: prompt + drag-drop + add-browser-window + Send). The Send path is glue over existing primitives (`osSpawnAgent → osIngestPaths → create_surface{web} → osSay`); the new parts are the input component, a first-ever `globalShortcut`, A2's symlink mode + context bucket, and A3. **A3 is the hard one:** the `~/agent-socket` Chrome extension has zero BlitzOS link and only mints its own relay session, and discovery is blocked (a sandboxed extension cannot read `~/.blitzos/session.json`, and the control server binds an ephemeral port). Full spec + the recommended discovery reframe: `blitzos-job-entrypoints.md`. The J-split + J-agents semantics depend on the WorkUnit (`blitzos-job-task-model.md`).

**Phase 3 — Planning (⬜, = W1).** No plan widget exists (16 library widgets, none is "plan"; no `role:'plan'` surface; no Submit/Reject). But the widget↔agent callback plumbing already exists in three verified forms (`sendMessage`→`message`, `__blitz:'action'`→`action` capped 4000B, `setProps`), and the agent→widget update-in-place direction is fully built. So W1 is "author one widget + pick a return channel + write the authoring idiom," not from zero. Spec: `blitzos-plan-widget.md`. The agent's plan-authoring DUTY is in `blitzos-agent-autonomy-guardrails.md` (Phase 1).

**Phase 4 — Execution (🟡, = W2).** E1's prerequisite is done (wait.sh runs in the background so the agent yields), but the continuation engine (a `plan.md`-gated Stop hook + stage-status convention + spin-guard) has zero code; `plan.md` itself is spec-only. E2 (W2) reuses the `/events` wake channel and the `emitUserMessage` steering delivery verbatim, and supervisor='0' routing is already free (a `trigger:'tick'` moment with no agentId falls through `visibleTo` to '0'); only the tick emitter + the state diff are new. **Option A is the rule: BlitzOS ticks + diffs + emits the diff as perception; the agent owns all steering judgment, zero per-task heuristics in the OS.** Spec: `blitzos-tick-diff-steer.md` (E2/W2) and `blitzos-agent-autonomy-guardrails.md` (E1 continuation). E3's widget half is ⬜ by convention only (the `update_surface{props}` live-update path is built; there is just no durable per-job status widget yet, which the W1 widget morphs into).

**[N] Notification (🟡).** Status reaches the user in-app only (the chat status pill, the action-items inbox badge, a crash chat line) and requires the BlitzOS window to be focused. No native OS notification, no menubar/Tray, no dock badge anywhere. The outward fabric (A5 Tray + a `notify.ts` + a dock badge, fired on a content-agnostic whitelist) is specced in `blitzos-job-entrypoints.md`.

---

## Sequencing (the whole refactor)

1. **Decide WorkUnit persistence (Option 1 vs 2)** and the related primitives (`role:'plan'` surface, `start_job`/`start_task` tools). These need sign-off; they gate everything. → `blitzos-job-task-model.md`
2. **Land the WorkUnit** record + reader/writer + the generalized boot-task mapper (falling through to onboarding unchanged) + the transition tools. This unlocks the J-split, B3-as-job, and the Task path.
3. **W1 plan widget** on top (binds `WorkUnit.planSurfaceId`/`planPath`), plus the prerequisite prose fixes from the guardrails doc.
4. **E1 continuation engine** armed on a Job's `approved → running`. → `blitzos-agent-autonomy-guardrails.md`
5. **W2 tick → diff → steer** (ships decoupled: status/terminal/surface deltas alone wake the supervisor; plan-awareness is a later enrichment). → `blitzos-tick-diff-steer.md`
6. **Entry points** (A/B shared input, A4 Send, A2/A3) and **outward surfaces** (A5/[N]) once the WorkUnit gives the Send a payload to mint. → `blitzos-job-entrypoints.md`
7. **O2b reframe** (browser-first read of logged-in tabs) and the E3 job-status widget, both low-risk, any time after the WorkUnit lands.

## Decisions needing sign-off (consolidated)

1. **WorkUnit persistence:** Option 1 (agent meta) vs Option 2 (dedicated record). Lean Option 1, migration-ready. → job-task-model
2. **`role:'plan'` surface:** a new surface-role primitive for the W1 widget binding (decides three-serializer vs both-isRuntime-predicate handling). → job-task-model / plan-widget
3. **`start_job`/`start_task` tools** vs extending `spawn_agent` (affects the agent-socket contract across all three transports). → job-task-model
4. **W1 return channel:** the no-core-edit two-step (setProps + tiny sendMessage + `get_surface`) vs raising the App.tsx 4000-byte cap. Lean the two-step. → plan-widget
5. **W2 new perception primitive** (`setTickSource` + `emitTick` + `trigger:'tick'`), its cadence, the host-side `chatStatusSnapshot()` accessor, and a `/steer` tool vs wiring wake into `/say`. → tick-diff-steer
6. **A2/A3 core touches:** `ingestPaths` symlink mode + WorkUnit context association; the A3 extension discovery mechanism (recommended: the "hand BlitzOS a URL to open the logged-in tab" reframe). → job-entrypoints
7. **Onboarding interview as the FIRST WorkUnit** (unify the two duty strings) vs keeping it a special path. Lean: generalize the mapper first with onboarding unchanged, unify later. → job-task-model

## Cross-references
- `plans/blitzos-job-task-model.md` — the WorkUnit spine (read first)
- `plans/blitzos-plan-widget.md` — W1 + E3 widget
- `plans/blitzos-tick-diff-steer.md` — W2 supervisor heartbeat
- `plans/blitzos-job-entrypoints.md` — Phase 2 A/B + A5/[N]
- `plans/blitzos-agent-autonomy-guardrails.md` — E1 continuation + the Phase-1 plan-authoring duty
- `plans/onboarding-case-file.md` — Phase 1 onboarding
- `agent-os/CLAUDE.md` "Agent runtime (perception → moments → wake)" — the doctrine W2 and the continuation engine must honor
