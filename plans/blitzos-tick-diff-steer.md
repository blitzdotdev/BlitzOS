# BlitzOS — W2 (E2): Tick → Diff → Steer supervisor heartbeat (Option A)

Status: SPEC FOR REVIEW. Terse companion to `plans/blitzos-user-journey.md` (E2); verified on `agent-runtime-moments-brandon-spatial-merge`.

## Option A boundary (load-bearing)

BlitzOS only ticks, diffs the desktop's agent/terminal/surface state vs the prior tick, and emits the material diff as a `trigger:'tick'` perception moment. The AGENT owns ALL steering judgment; ZERO per-task/stuck/threshold heuristics live in the OS.

## What to reuse (verified)

The `/events` wake channel and `emitUserMessage` steering delivery are reused VERBATIM. Supervisor='0' routing is already FREE: a `trigger:'tick'` moment with no `agentId` falls through `visibleTo` to '0'.

Key refs: registration-seam to mirror `setWorkspaceProvider`/`setMomentTap` (`perception-core.mjs:41`/`:166`); the 2s sweepTimer (`perception-core.mjs:294`); materiality rule `if (!p.hasUser) return` (`perception-core.mjs:213`); `emitUserMessage` (`perception-core.mjs:341`); `visibleTo` (`perception-core.mjs:52-60`); `redactMoment` (`perception-core.mjs:83`); `diffCanvasOps` geometry-only (`osActions.ts:663`) + its echo/bulk suppression. chatStatus writers `setChatStatus`/`noteAgentActivity` (`workspace-host.mjs:462`/`:480`); reader `chatStatus` (`:472`) NOT exported. `props` stripped from `list_state` (`os-tools.mjs ~:101`), so the tick payload MUST ride `moment.diff` on `/events`, never `list_state`.

## New pieces (terse)

- `emitTick()` + `setTickSource(fn)` seam (third inversion seam; provider injected, caught on throw).
- Diff payload `{agentStatus[{id,from,to}], terminals[{id,status,exitCode?}], surface deltas (open/close, offstage↔onstage)}` with a load-bearing EMPTY-DIFF EARLY-RETURN: `if (!material(diff)) { lastTickSnapshot = next; return }` (mirrors `:213`).
- Materiality (content-agnostic, transition-shape only): `working → {waiting,stopped,error}`, `* → error`, terminal exit, agent add/close, surface open/close/offstage-flip are material; `working → working`/`working → watching`/ramp-up are NOT. No timers, no task inspection.
- Host-side `chatStatusSnapshot()` accessor (export `chatStatus`+snapshot; `osAgentStatus()` wraps it).
- `redactMoment` tick branch: `if (m.trigger === 'tick') return m` (pure metadata, passes intact like `connector`).
- Steer call-site: relay-safe `/steer {agent,text}` → `osUserMessage` → append + `emitUserMessage` (wakes only N).
- Echo/bulk self-reaction guard: arm a per-agent steer-echo + reuse `canvasBulkAt`-style window so the next tick absorbs the supervisor-caused `→ working`.

## Sign-off decisions

1. NEW perception primitive: `setTickSource`+`emitTick`+`trigger:'tick'`. Recommend: add it (same shape as the two seams).
2. Cadence: ride the 2s sweep sub-gated by `TICK_MS` (recommended, no 3rd timer) vs a dedicated interval. `TICK_MS≈10s`.
3. Widen workspace-host public API with `chatStatusSnapshot()`. Recommend: yes (canonical, durable diff source).
4. Add relay-safe `/steer {agent,text}`. Recommend yes: `/say` does NOT wake the target; only `osUserMessage`/`emitUserMessage` does, and `/user_say` is relay-blocked.

Decoupling: W2 ships BEFORE W1 on status/terminal/surface deltas alone; plan-awareness is a later enrichment.

Risks: layering (inject, never import), spam (the empty-diff early-return), self-reaction (steer-echo + bulk suppression).

Sequencing: (5) host reader → (1) seam+`emitTick` → (2)+(3) diff+materiality+early-return → (4) cadence → (6) redact branch → (8) echo guard → (7) `/steer`; W1 plan-awareness deferred.

Cross-references: `plans/blitzos-user-journey.md` (index, E2); `plans/blitzos-job-task-model.md` (steering target / on-plan); `plans/blitzos-plan-widget.md` (W1 plan artifact); `plans/blitzos-agent-autonomy-guardrails.md` (E1 self-drive, complementary); `agent-os/CLAUDE.md` "Agent runtime" (doctrine).
