# Plan: persist the in-chat workflow kanban (never ephemeral)

## Status

The in-chat kanban board is **currently HIDDEN** (`KANBAN_HIDDEN = true` in `IslandPanel.tsx`) because it is unreliable: a finished or long run shows nothing. `run_workflow` still runs and writes its journal to disk; only the board UI is off. This plan is the fix that makes boards durable so the board can be re-enabled (flip `KANBAN_HIDDEN` to false once this lands).

## Spec (user)

- Boards must **never be ephemeral**.
- The **full run history is persisted on disk**, and **read + loaded when the user clicks the tab** (including after a relaunch).
- On create, a run is held **in memory AND saved to disk**.
- Memory is only cleaned **after the user has not been at that tab for ~15 min** (kept on disk; reloaded on re-view).

Restated: **disk is the source of truth, memory is a cache.**

## Current state (verified)

- ~~**Run events ARE already on disk.** Each run writes `<ws>/.blitzos/workflows/<runId>/journal.jsonl` (full event log)...~~ **WRONG — corrected 2026-06-22 (see "Shipped" below).** `journal.jsonl` is the RESUME memo (`{i,hash,result}` per `agent()` call, `agent.mjs:124`), NOT the WfEvent stream the board reducer (`wfReduce`) consumes — replaying it through the reducer yields an EMPTY board. The board events (`run:start`/`phase`/`agent:*`/`run:done`) lived ONLY in the in-memory bus; nothing persisted them. The fix had to persist them (`events.jsonl`). `result.json` + `leaves/<nodeId>.json` ARE on disk (the drawer's data), but they are not the board's event stream.
- **The registry is memory-only + auto-dropped.** `osActions._wfRuns` (runId→run) + `_wfRunsByAgent` (agentId→runIds), and a done run is deleted `WF_RUN_KEEP_DONE_MS = 30_000` (30s) after `done`. This is the ephemerality.
- **The event bus is memory-only.** `workflow-bus.mjs` `_runs` (runId→{events,subs}) — replay-then-live, but no replay-from-disk; gone on restart.
- **No durable agent→runs index**, so on relaunch nothing knows which runs a tab owned.
- The board renders from `osAgentsSnapshot().runs` (the in-memory registry) + a live `wf-subscribe` to the bus; `applyWfRun` (`wf-run-state.mjs`) is the shared reducer both sides fold broadcasts through.

## Design

1. **Durable per-agent run index** — `<ws>/.blitzos/workflows/index.json`: `{ [runId]: {agentId, file, title, startedAt, done, ok, memDir} }`. Written on the `started` and `done` broadcasts (in `osNoteWfRun` / the `workflow-host` broadcast seam). This is the only NEW on-disk artifact; everything else (journal/result/leaves) already exists.
2. **Reconstruct a board from disk** — when a run is not in the in-memory bus (evicted or post-relaunch), rebuild its board state by replaying `<memDir>/journal.jsonl` through the SAME reducer the live bus uses (`mergeSkeleton`/`wfReduce`). A loaded board is byte-identical to a live one; the renderer cannot tell the difference.
3. **Lazy load on tab-open** — opening agent N's tab reads the index for N, lists its runs (most-recent first), and renders each board from the bus if live, else from its disk journal. Matches "loaded when the user clicks the tab on relaunch." (Paginate if an agent has very many runs.)
4. **Evict by tab-inactivity, not by done** — replace the 30s-after-done drop with: keep a run's in-memory record + bus buffer while its agent's tab was viewed within `WF_MEM_TTL_MS` (**15 min** default); a sweep drops in-memory state for tabs unviewed past the TTL. Disk is never touched by eviction; re-viewing the tab reloads from disk. The renderer reports "tab last viewed" (it already knows the active tab); the main process stamps it.

## Files / seams

- `src/main/workflow-host.mjs` — write the index entry on `started`/`done` (alongside the existing broadcast); already owns the run `memDir` + journal.
- `src/main/osActions.ts` — `osNoteWfRun` writes/updates the index; `osAgentsSnapshot().runs` (and/or a new `osLoadAgentRuns(agentId)`) merges live + disk-index runs; **remove `WF_RUN_KEEP_DONE_MS`**, add the TTL sweep keyed by last-viewed.
- `src/main/workflow-bus.mjs` — add `hydrateFromJournal(runId, memDir)` so a subscribe to an evicted/cold run replays the disk journal into the buffer first.
- `src/main/index.ts` — IPC: `os:wf-load-agent-runs {agentId}` (lazy on tab-open) + a `tab-viewed {agentId}` ping to stamp last-viewed; wire the index path.
- `src/renderer/src/notch/{NotchHost,IslandPanel}.tsx` — on tab-open, request the agent's runs; render boards from the loaded list; ping last-viewed on tab switch. Re-enable by flipping `KANBAN_HIDDEN`.
- `src/main/wf-run-state.mjs` — the reducer is reused unchanged for both live and journal-replay folding.
- A small new `src/main/wf-index.mjs` (pure read/write/merge of `index.json`) keeps the disk format in one place + unit-testable.

## Tests

- `wf-index`: write → read → merge round-trips; `started` then `done` updates the same entry; corrupt/missing file degrades to empty.
- Journal replay: a recorded `journal.jsonl` folds to the same board state as the live event stream.
- Eviction: a run past the TTL drops from memory but stays on disk; re-view reloads it identically.
- Relaunch: index + journals reconstruct an agent's boards with no live bus.

## Coordination note

Every file above is the in-flight kanban work being edited by another session (uncommitted `wf-run-state.mjs` + the NotchHost/osActions changes). Land this only after that session commits, or in lockstep with it, to avoid merge conflicts. The board stays HIDDEN until then.

---

# SHIPPED (2026-06-22) — event-sourced persistence (Option A)

The premise correction (above) forced an extra pillar the original plan missed: **the board events were never on disk**. So the fix persists the WfEvent stream itself, then reuses the LIVE render path verbatim (the board always reads the bus; we just make the bus transparently hydrate a cold run from disk). `IslandKanban` is UNCHANGED — frozen boards are byte-identical to live ones. User picked Option A (persist event stream + replay) over a reduced-board snapshot.

## On-disk layout, per run, under `<ws>/.blitzos/workflows/`
- `index.json` — `{ [runId]: {runId,agentId,file,startedAt,done,ok,memDir} }`, pruned to 200 most-recent. The per-agent run index.
- `<runId>/events.jsonl` — the full WfEvent buffer, written once when the run SETTLES. **The board's replay source.**
- `<runId>/skeleton.json` — the dry-preflight skeleton events (TODO/queued + never-ran cards), written when the preflight resolves.
- `<runId>/result.json`, `<runId>/leaves/*.json` — unchanged (final result + the drawer's Asked/Did/Returned).

## What changed
- **NEW `src/main/wf-store.mjs`** (+ `.d.mts`) — pure node disk I/O: index read/write/merge (+cap), events.jsonl write/read (corrupt-line tolerant), skeleton write/read, `listAgentRuns` (filter by agent, recent-first, cap 30, skeleton loaded). Test: `scripts/tests/test-wf-store.mjs` (22 assertions).
- **`workflow-bus.mjs`** — `hydrate(runId, events)` (seed a cold run's buffer, preserving seq, no fan-out, never double-seeds) + `subCount(runId)` (so the sweep never yanks a watched board).
- **`workflow-host.mjs`** — writes `events.jsonl` on settle (success + error) and `skeleton.json` on preflight resolve.
- **`osActions.ts`** — `osNoteWfRun` writes the index entry every transition; **dropped `WF_RUN_KEEP_DONE_MS` (the 30s vanish) + the dead `setWfRunsProvider`**; added `osLoadAgentRuns` / `osWfHydrateIfCold` / `osNoteTabViewed` / `osSweepWfMemory` (15-min tab-inactivity eviction; never evicts running or watched runs; disk untouched).
- **`index.ts`** — IPC `os:wf-load-agent-runs` + `os:tab-viewed`; hydrate-if-cold in the `os:wf-snapshot`/`os:wf-subscribe` handlers; a 5-min sweep timer.
- **`preload/index.ts`** — `wfLoadAgentRuns` + `tabViewed` bridges.
- **`NotchHost.tsx`** — on tab-activate: `wfLoadAgentRuns(id)` (merge, never clobber in-flight) + `tabViewed(id)`. **`IslandPanel.tsx`** — `KANBAN_HIDDEN` removed, board ON.
- **Docs** — `blitzos-agents.md` / `blitzos-orchestrator.md` / `agent-runtime.mjs` / `osActions.ts` orchestrator message: "board disabled" → "board appears automatically + is durable".

## Adversarial review (ultracode, 2026-06-22) + fixes

5 finder lenses → per-finding adversarial skeptics (all Opus). 3 real bugs CONFIRMED + fixed; 3 refuted (self-contradictory or pre-existing — left as-is). The first review pass mostly fell to a transient server throttle + a cyber-safeguard trip on the security lens wording; re-ran with the lens reworded as a defensive input-robustness review.

1. **MEDIUM — phantom 'workflow running' board forever after a crash.** `osNoteWfRun` writes the index entry on the first `started` (done:false). A hosted run is IN-PROCESS, so if the app dies (crash OR clean-quit) before `done`, that entry stays done:false on disk and every relaunch renders a perpetual 'running' head. **Fix:** `wf-store.reconcileOrphanRuns(dir, isLive)` — at the first tab-load per workflows dir per session, flip every done:false entry to `{done:true, ok:false}` ('workflow failed'), shielding this session's live runs (`_wfRuns.has`). Correct for both crash and clean-quit (the in-process invariant, not the crash bit, is the real discriminator — so it is NOT gated on the unclean-shutdown flag, which would miss a clean quit during a run).
2. **LOW — torn `events.jsonl` reloads a finished board as 'running'.** A non-atomic `writeFileSync` truncated mid-crash drops the final `run:done` line. **Fix:** atomic tmp+rename (the repo convention) for `events.jsonl` + `skeleton.json` + `index.json`.
3. **LOW — cold-reloaded runs leak in memory.** `osLoadAgentRuns` returned disk rows without registering them, so `osWfHydrateIfCold` seeded the bus but the sweep (iterates `_wfRunsByAgent`) could never evict them. **Fix:** `registerWfRun` folds disk-rebuilt runs into the registry so the 15-min sweep covers them (idempotent; never clobbers a live entry).

Refuted (no change): the >6000-event middle-leaf claim (pre-existing cap, matches live), and two snapshot/load race claims (unreachable on main's single thread — the verifier showed the losing interleaving is self-contradictory).

## Verified
`npm run check` (typecheck + parity + build) exit 0. Tests pass: `test-wf-store` (incl. reconcile + atomic-write), `test-wf-bus` (hydrate + subCount + run:done-past-cap), `test-wf-run-state`, `test-workflow-host`. NOT live-tested (the user runs the GUI). Finding 3's fix is in `osActions.ts` (imports electron → not headless-unit-testable); verified by typecheck + the skeptic's confirmation, not a unit test.

## Code review (2026-06-22) — the tab-open FREEZE + fixes

User reported a 1-2s UI freeze on restart → click the agent tab a workflow ran on. A 5-angle code review (line-by-line / removed-behavior / cross-file / pitfalls / efficiency+altitude, all Opus) triangulated the cause and found correctness issues. Root cause was a REGRESSION from this feature: before persistence, a restarted tab showed nothing, so none of this ran.

The freeze, three compounding costs on the tab-open path:
1. **O(n²) replay** (`IslandKanban`): the bus snapshot was replayed with `setEvents(prev => [...prev, ev])` per event — on reload the whole persisted backlog (up to 6000 events) lands at once → quadratic array copies + a full `mergeSkeleton` per event.
2. **Every board mounted at once** (`IslandPanel`): the collapse kept all boards mounted, so each run that agent ran subscribed + hydrated its full `events.jsonl` on tab-open, just to show a pill.
3. **Synchronous main-thread I/O**: `readEventsLog` (parse up to 6000 lines) × every board + `listAgentRuns` reading 30 `skeleton.json` files, all sync, blocking main.

Fixes (all green; no core-shape/applyWfRun change):
1. **IslandKanban** — microtask-COALESCE every push into one `setEvents` per flush (O(n²)→O(n)); absorbs the snapshot, the subscribe-replay, and live events uniformly.
2. **IslandPanel** — LAZY-MOUNT: mount the heavy `IslandKanban` only after a run is first expanded (add-only `mountedRuns`), then keep it mounted. Tab-open now renders N cheap pills, not N hydrating boards. The collapsed pill's stats come from the stored record (see "stats-in-record" below), so it shows "{ms} · {calls} agents · {tokens} tok" with no board mount.
3. **IslandPanel** — memoize the O(runs×messages) anchoring walk on `[runs, messages]` (was re-running every panel render).
4. **NotchHost** — the load merge clobbered a fresher live entry with the stale disk row (a `done`/skeleton broadcast can reach the renderer before main's registry read), reintroducing the "board reverts to running / loses TODO cards" class. Now merges field-wise preserving terminal `done` + non-empty skeleton.
5. **index.ts** — `os:agents-snapshot` catch fallback now includes `runs: {}` (a transient throw no longer momentarily wipes all boards).
6. **reconcileOrphanRuns** — recover the true `ok` from `events.jsonl`'s `run:done` before force-failing, so a run that settled but missed its index done-write isn't mislabeled "failed".

## Known limits (tracked)
- **>6000-event runs** persist a TRUNCATED `events.jsonl` (the bus buffer is capped at MAX_EVENTS=6000; only `run:done` is kept past it). A reloaded board for a massively-parallel run is missing its dropped middle cards. TODO in `workflow-host.mjs` (append-on-arrival is the fix when it bites). Rare; live is unaffected.
- A run still RUNNING when the app dies has no `events.jsonl`; its orphaned index entry is healed to 'workflow failed' on the next session's first tab-load. Acceptable.
- Reload reads the ACTIVE workspace's index only (V1 single-workspace). Cross-workspace historical reload is out of V1 scope.
- Minor, noted not fixed: `cacheWfMemDir`'s 1000-cap can evict a still-live run's memDir (needs >1000 runs/session); `_tabLastViewed`/`_wfReconciledDirs` not pruned on agent close (slow leak). Low severity for V1.

## stats-in-record (DONE 2026-06-22, approved) — collapsed pills show stats with no board mount
The final `{ms,calls,tokens}` is stored on the durable run record so a collapsed/never-expanded board's pill renders its stats from the cheap index load (no mount, no replay). Additive + back-compat (old entries → `stats:null` → status-only pill). Changes: optional `stats` on the run record (renderer `IslandWfRun`, main `IslandWfRun`, `WfRunRecord`, `WfIndexEntry`); `applyWfRun` sets `stats:null` on a new `started`, carries `action.stats` on `done`, preserves it across a late `started` (test added); `workflow-host` reads `{ms,calls,tokens}` off the `run:done` event and puts it on the `done` broadcast; `osNoteWfRun` writes it to `index.json`; `listAgentRuns` reads it back; `reconcileOrphanRuns` recovers it from `run:done` for a healed orphan; `IslandPanel` pill prefers live `runStats` else `r.stats`. Green: typecheck + parity + build exit 0; `test-wf-run-state` + `test-wf-store` extended.
