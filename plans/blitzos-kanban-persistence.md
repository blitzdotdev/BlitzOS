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

- **Run events ARE already on disk.** Each run writes `<ws>/.blitzos/workflows/<runId>/journal.jsonl` (full event log) + `result.json` + `leaves/<nodeId>.json` (`workflow-host.mjs`). So the board's data is durable today.
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
