# BlitzOS — Tick Diff Steer Supervisor Heartbeat

Status: SPEC FOR REVIEW (no code written). W2, Phase 4 E2. This doc is the Option A contract for the tick -> diff -> steer supervisor heartbeat. Decisions already made: BlitzOS only ticks, diffs, and emits a perception moment; the agent owns every steering judgment, with zero per-task, stuck, or threshold heuristics in the OS. Also already decided: the A/B job entry points share one Raycast-like input component with two shells, the global non-activating NSPanel and the in-app HUD, both with prompt, dropped files/folders, add-browser-window, and Send. This spec builds on `plans/blitzos-job-task-model.md`, it does not redefine the Job/WorkUnit spine.

## Current state (verified)

- The doctrine is Option A-shaped already. `CLAUDE.md:11` says BlitzOS has "zero per-task code" and that "the agent as swappable policy" decides action; `CLAUDE.md:59` says "keep BlitzOS perception content-agnostic" and "No per-task detection" belongs in BlitzOS. W2 must keep that boundary: the OS emits content-agnostic diff facts, the supervisor agent decides whether to steer.
- The central dependency is still the Job object from the spine doc, not this doc. `plans/blitzos-job-task-model.md:3` says "there is NO first-class Job object today; agents are uniform peers" and "B3 / W1 / W2 / E1 all reference the Job object." `plans/blitzos-job-task-model.md:37` flags Job persistence as a core sign-off decision. W2 can wake on status diffs before W1 exists, but plan-aware steering needs the Job's `agentId`, `planPath`, and lifecycle from that spine.
- The event stream and supervisor routing already exist. `os-tools.mjs:556-568` defines `/events`, calls `waitForEvents`, and returns `{ events, latest, reminder }`; `perception-core.mjs:622-638` long-polls visible moments. `perception-core.mjs:52-60` routes `message` and `action` privately, then returns `sid === '0'` for all other triggers. A `trigger:'tick'` moment with no `agentId` therefore wakes supervisor `'0'` without a new routing rule.
- The registration pattern W2 should mirror is verified. `perception-core.mjs:41-43` exposes `setWorkspaceProvider(fn)`, and `perception-core.mjs:180-182` exposes `setMomentTap(fn)`. The W2 seam must follow this dependency inversion because `perception-core.mjs` is the shared perception kernel and must not import IPC-bound `osActions.ts`.
- The coalescer cadence and anti-spam rule already exist. `perception-core.mjs:16` sets `BATCH_MS = 15000`; `perception-core.mjs:505-521` runs the 2s `sweepTimer`. `perception-core.mjs:225-227` states "Content-only churn" is not a wake reason and returns on `!p.hasUser`. The tick needs the same load-bearing empty-diff early return.
- Canvas geometry diffing exists, but it is not W2. `osActions.ts:612-617` says tool-driven ops and human gestures become canvas perception, and bulk transitions suppress the differ. `osActions.ts:628-633` implements `consumeEcho`; `osActions.ts:678-702` defines `diffCanvasOps`, consuming open/move/resize/close echoes before `ingestCanvasOps`. This is surface geometry, reactive on `os:state`, not a periodic agent/job heartbeat.
- Steering delivery is built end to end. `osActions.ts:832-836` appends a user message to an agent's chat and calls `emitUserMessage`; `perception-core.mjs:558-571` emits `trigger:'message'` with `agentId`, which `visibleTo` routes privately. `electron-os-tools.ts:70-73` already binds `steer` to `osUserMessage`, while `osActions.ts:816-825` shows `osSay` only appends an agent message and does not emit a wake.
- The serializer footgun is real. `os-tools.mjs:95-99` says the agent-facing state omits `html` and `props`; `os-tools.mjs:111-120` projects surface fields without props. Therefore the tick payload must ride `/events` as `moment.diff`, not `list_state`. The current tick emitter uses `diff` at `perception-core.mjs:486-495`, and `redactMoment` preserves tick `diff` at `perception-core.mjs:98-99`.
- Agent status is available host-side. `workspace-host.mjs:459-467` writes chat status records, `workspace-host.mjs:487-512` updates status from activity, and `workspace-host.mjs:518-545` folds the status map into chat hub props. In this checkout, the research has drift: `chatStatusSnapshot()` now exists at `workspace-host.mjs:482-485` and is exported at `workspace-host.mjs:1042-1044`.
- W2 host seams are already visible in this checkout and should be reviewed against this spec. `perception-core.mjs:323-325` defines `setTickSource`; `perception-core.mjs:473-497` defines `emitTick`; `perception-core.mjs:500-521` gates ticks from the existing 2s sweeper with `TICK_MS`. `osActions.ts:181-186` registers a provider with `surfaces`, `agentStatus`, `terminals`, and `workspace`.

## What to build

Build or preserve W2 as one host-side heartbeat contract, not a second agent loop:

1. `setTickSource(fn)` remains the only ingress from host state into perception. The provider returns `{ agentStatus, terminals, surfaces, workspace }`, matching the existing `osActions.ts:181-186` shape. This is a DECISION THAT NEEDS USER SIGN-OFF because it adds a perception primitive and a public host-to-kernel seam.
2. `emitTick()` snapshots the provider, diffs against a module-level `lastTickSnapshot`, and emits exactly one `trigger:'tick'` moment only when the diff is material. `perception-core.mjs:479-485` already seeds baseline, advances baseline, and returns on `!diff.material`; keep that behavior as the W2 spam guard.
3. The diff payload rides `moment.diff` on `/events`, never `list_state`. Minimum payload: `agents`, `terminals`, and `surfaces`, as in `perception-core.mjs:494`. The agent can pull full content later with targeted tools; relay-safe tick metadata should cross intact via the `redactMoment` branch at `perception-core.mjs:98-99`.
4. Materiality stays content-agnostic. Agent status materiality should include `working -> waiting`, `working -> stopped`, `working -> error`, and any `* -> error`; it should exclude `working -> working`, `working -> watching`, and routine `starting -> working`. The current code states this rule at `perception-core.mjs:422-425`.
5. Terminal materiality is exit-oriented. `perception-core.mjs:431-435` emits when an `exitCode` appears; `osActions.ts:574-583` maps terminal spawn, data, stop, and exit into chat status writers. That is enough to wake the supervisor on crash or completion without interpreting task semantics.
6. Surface materiality needs sign-off. The prompt asks W2 to include surface open/close plus offstage/onstage deltas. The current implementation assigns open/close/move/resize to `trigger:'canvas'` and only diffs props edits in tick, see `perception-core.mjs:438-455`. DECISION THAT NEEDS USER SIGN-OFF: either keep canvas as owner of surface open/close/geometry and let tick own props/offstage plan-widget deltas, or move open/close/offstage/onstage into tick and add double-wake protection.
7. Cadence should ride the existing sweeper unless rejected. `perception-core.mjs:500-521` uses `TICK_MS = max(2000, BLITZ_TICK_MS || 10000)` and runs from the unref'd sweep timer. A dedicated interval, like the unrelated 60s heartbeats, should be a sign-off decision because it adds another always-on scheduler.
8. Steering should use `/steer {agent,text}` rather than `/say`. `os-tools.mjs:587-599` defines `/steer`; `electron-os-tools.ts:70-73` maps it to the waking `osUserMessage` path. `/say` at `os-tools.mjs:572-583` is agent-to-user chat and does not wake the target agent. If `/steer` is kept, this is the relay-safe sibling tool for supervisor policy.
9. Echo and bulk suppression are mandatory. Canvas uses `consumeEcho` and `canvasBulkAt` at `osActions.ts:628-640`. W2 should keep the current stronger tick guards: `absorbTickEcho` one-shot sets at `perception-core.mjs:376-383`, `resetTickBaseline()` at `perception-core.mjs:391-393`, tool-origin surface absorption at `osActions.ts:772`, spawn absorption at `osActions.ts:920`, and close absorption at `osActions.ts:946`.
10. W2 can ship decoupled from W1. Agent status and terminal exits already produce enough material diffs to wake supervisor `'0'`. Plan-awareness is an enrichment once the Job record and W1 plan widget bind a job's plan surface and executor agent, per `plans/blitzos-job-task-model.md:18-29` and `plans/blitzos-plan-widget.md`.

## Sequencing

1. Confirm the Job/WorkUnit decision in `plans/blitzos-job-task-model.md`, especially persistence and `agentId` ownership. W2 needs the steering target but must not define the work-unit model.
2. Approve the W2 perception primitive: `setTickSource`, `emitTick`, `trigger:'tick'`, and `moment.diff`. If the target branch lacks the current seams, add them near `flushCanvas`; if it has them, review for conformance.
3. Approve surface delta ownership: canvas-only for open/close/geometry with tick props/offstage, or tick-owned open/close/offstage/onstage. This choice changes wake volume and self-reaction handling.
4. Expose or keep a host status snapshot accessor. The current `chatStatusSnapshot()` is the right shape, and avoids scraping chat surface props that the agent serializer strips.
5. Register the tick provider in every transport that serves `/events`, using dependency injection only.
6. Add or keep the redact branch so pure-metadata ticks cross the relay intact while page-derived content still requires consent.
7. Add or keep `/steer`, wired to the same `emitUserMessage` delivery path as human user input.
8. Add headless tests around no-provider, first-tick seed, empty diff, material status edge, terminal exit, props/offstage surface delta, workspace scoping, redaction, and `/steer` visibility.

## Risks

- Layering: `perception-core.mjs` cannot import `osActions.ts` or `workspace-host.mjs`; use `setTickSource` as the only dependency seam.
- Spam: the empty-diff early return is load-bearing. A quiet desktop must emit zero tick moments.
- Self-reaction: a supervisor steer, widget update, spawn, close, or workspace switch can cause the next snapshot to differ. Use one-shot per-delta absorption for tool-origin changes and baseline reset for bulk transitions.
- Workspace scoping: `perception-core.mjs:195-198` stamps workspace in `emit`, and `visibleTo` filters workspace at `perception-core.mjs:52-60`. Keep tick moments in that funnel so background workspaces do not wake the active supervisor.
- Serializer blindness: `props` are stripped from `list_state`, so the supervisor must read `moment.diff` from `/events` and pull any full surface content explicitly.
- Policy leakage: materiality can classify transition shape, not task semantics. No "stuck", "off plan", or per-domain heuristics in the OS differ.
- Source drift: the research maps cite older lines for `setMomentTap`, `emitUserMessage`, `diffCanvasOps`, and chat status export. This spec cites the current source lines verified in this checkout.

## Open decisions

1. DECISION THAT NEEDS USER SIGN-OFF: accept `setTickSource` plus `emitTick` plus `trigger:'tick'` as a new core perception primitive.
2. DECISION THAT NEEDS USER SIGN-OFF: surface delta ownership. The prompt requested open/close plus offstage/onstage in tick; current source keeps open/close/move/resize in canvas and props edits in tick.
3. DECISION THAT NEEDS USER SIGN-OFF: cadence. Default 10s via `BLITZ_TICK_MS` on the existing 2s sweep, or a dedicated interval.
4. DECISION THAT NEEDS USER SIGN-OFF: keep `/steer` as the supervisor tool, or attempt to extend `/say`. Recommendation: keep `/steer`, because `/say` does not wake the target agent.
5. DECISION THAT NEEDS USER SIGN-OFF: tick relay shape. Recommendation: pure metadata, ids, change kinds, titles, status edges, and counts only; full content is pulled separately.
6. DECISION THAT NEEDS USER SIGN-OFF: supervisor identity. Today `visibleTo` makes `'0'` the only desktop watcher; a future supervisor distinct from primary chat needs a new visibility class or configured supervisor id.
7. DECISION THAT NEEDS USER SIGN-OFF: WorkUnit target binding belongs in `plans/blitzos-job-task-model.md`, not here. W2 consumes `agentId` and plan/status paths once the spine lands.

## Cross-references

- `plans/blitzos-user-journey.md`: index and phase map.
- `plans/blitzos-job-task-model.md`: the Job/WorkUnit spine and steering target.
- `plans/blitzos-plan-widget.md`: W1 editable plan widget and E3 status widget, whose props/offstage edits can become tick material.
- `plans/blitzos-job-entrypoints.md`: Phase 2 A/B shared input, A5 menubar, and notifications.
- `plans/blitzos-agent-autonomy-guardrails.md`: E1 continuation engine and the agent's Phase 1 plan-authoring duty.
- `plans/onboarding-case-file.md`: Phase 1 onboarding context.
- `CLAUDE.md`: Option A doctrine for content-agnostic perception and swappable agent policy.
