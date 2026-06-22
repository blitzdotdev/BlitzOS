# Plan: live workflow kanban inside agent chat

Port the lab's Kanban A (`lab/kanban/src/`) into the real island chat. When an agent runs a workflow, BlitzOS shows a live board INLINE in that agent's chat. The agent never calls a "show board" tool and never knows the board exists; it just calls the existing `run_workflow`.

## Verified facts
- Wf event pipe already exists, unused in V1 renderer: `workflow-bus.mjs` (per-runId buffer + replay-then-live `subscribe`), `workflow-host.mjs:runWorkflowHosted`, `index.ts:693` `os:wf-{subscribe,snapshot}` IPC + `os:wf-event` fan-out, `preload` `window.agentOS.wf.*` bridges.
- `run_workflow` already takes `agent` (default `'0'`) → a run is tied to an agent at mint. No new agent tool.
- Per-leaf capture ALREADY exists, opt-in via `BLITZ_CAPTURE_LEAVES=1` (`agent.mjs:282-322` `captureLeaf` → `<memDir>/leaves/<nodeId>.json` = `{prompt,result,summary,sessionId,...}`). Lab sets the flag; real app does NOT → dormant. Enabling = one env line.
- "Asked"=`prompt`. "Returned"=`result` (typed). "Did"=`summary` — verified: `_leafSummary` calls `harness.parse(stdout)` which returns the final assistant prose (claude `.result`, codex `agent_message`). So `summary` IS the "Did". No runtime edit needed.
- Milestones already ride `os:action {type:'milestone'}` → NotchHost state → IslandPanel prop, hydrating via `osAgentsSnapshot`. Runs reuse this exact path — no new store module.
- Transcript (`chat.md`) is PLAIN TEXT: `appendChatMessage` writes `### role · ts`+text; `readChatMessages` returns `{role,text,ts}` — NO `parts` persisted. `parts` on the type is runtime-only. Feed keys messages by `${i}:${ts}`; appends keep prior indices stable, so a board at index N stays at N. Verified.

## Decisions (locked)
1. Placement: INLINE in the transcript as a new message-part, anchored at run start, updating in place, frozen on done.
2. Concurrent runs: stack-all, one board per run in start order.
3. TODO cards: full kanban — best-effort `dry:true` preflight in `runWorkflowHosted` for the skeleton (gated + timeout, like the lab).
4. Drill-in drawer: full parity (Asked/Did/Returned). Reuse the renderer's existing `MarkdownMessage`/`react-markdown` for "Did" (port only a small `JsonView` for "Returned").
5. ONE new IPC `os:wf-leaf {runId,nodeId}` (precedent: `os:wf-snapshot`, `os:agents-snapshot`). Returns the leaf JSON (Asked/Did/Returned). Lazy on-click.
6. Runs flow the milestone path: `osBroadcast({type:'workflow-run',...})` + hydrate in `osAgentsSnapshot`; NotchHost `onAction` adds a `workflow-run` branch (no new external store).

## File plan
- `workflow-host.mjs`: add a `broadcast` seam to `wireWorkflowHost` deps (keeps the module Electron-free, like `spawnEnrichment`). In `runWorkflowHosted` run a best-effort `dry:true` preflight → `skeleton`; broadcast `{type:'workflow-run',agentId,runId,file,title,started:true,skeleton,memDir}`; on `run:done` broadcast `{...done:true,ok}`.
- `index.ts`: set `process.env.BLITZ_CAPTURE_LEAVES='1'` at boot; add `ipcMain.handle('os:wf-leaf',...)` → read `<ws>/.blitzos/workflows/<runId>/leaves/<nodeId>.json` and return it. Extend `osAgentsSnapshot` to include `runs` per agent (open runs).
- `osActions.ts`: add `osReadLeaf(runId,nodeId)`; expose a runs provider for the snapshot if cleaner than inline.
- `preload/index.ts`: add `window.agentOS.wf.leaf(runId,nodeId)`; reuse `subscribe`/`snapshot`/`onWfEvent`.
- `notch/types.ts`: add `IslandMessagePart` variant `{type:'workflow-board', runId, skeleton, done?, ok?}` + a `runs` slice on the snapshot.
- `notch/wfReduce.ts`: port `lab/reduce.js` verbatim (`reduce`,`toBoard`,`mergeSkeleton`).
- `notch/wfShared.tsx`: port `shared.jsx` helpers (`fmtMs`,`fmtTok`,`summarize`,`cardHead`,`Output` + small `JsonView`); `useLeaf` → `window.agentOS.wf.leaf`. Markdown reuses `MarkdownMessage`.
- `notch/IslandKanban.tsx`: port `ModelA.jsx` (dynamic widths, `labelBreaks` wrapping, hidden scrollbar). Subscribe on mount, freeze+unsubscribe on `run:done`.
- `notch/IslandLeafDrawer.tsx`: port `LeafDrawer.jsx` (Asked/Did/Returned scrim overlay).
- `notch/{NotchHost,IslandPanel}.tsx`: `NotchHost` `onAction` branch for `workflow-run` (mirror the milestone branch → state → props); `IslandPanel` renders one `IslandKanban` per run as a message-part at its start ordinal + the drawer overlay.
- `notch/wf.css`: slice the `.kb-*`/`.kc-*`/`.dr-*` rules from `lab/models.css`, tokens → `tokens.css`.

## Out of scope (V1)
Model B; Run/Replay toolbar (live-only, past runs frozen in transcript); per-agent history view (stack-all is the history).

## Resolved: transcript anchoring (option 1)
The board is NOT a persisted chat.md entry and NOT a `parts` field. It's a separate LIVE REGION interleaved into the feed render by NotchHost's `runs[agentId]` state (milestone-style). IslandPanel renders `<IslandKanban>` at the position of the run's start (nearest agent message after `startedAt`, or at the run's own timestamp), reconstructed at render time. Re-anchoring on re-hydrate is acceptable. No chat.md format change, no persistence-layer edit, no `parts` persistence. The board subscribes to the live wf bus by runId.

Status: plan complete, all questions resolved. Next: implement.

---

# Implementation record (review log)

This section records what was actually built, the adversarial review, and the fixes — so a later reviewer can verify without re-deriving. Authored during the same session as the plan above.

## Commit `d1a5952` — first implementation (on `wip-stt-kanban`)

What shipped, file by file, and where it deviated from the file plan above:

### Main
- **`src/main/workflow-host.mjs`** — added a `broadcast` seam to `wireWorkflowHost` deps (keeps the module Electron-free, same pattern as `spawnEnrichment`). In `runWorkflowHosted`: ran a best-effort `dry:true` preflight (8s timeout) → `skeleton`, broadcast `{type:'workflow-run',agentId,runId,file,started:true,skeleton,memDir}`, and on the background run's settle broadcast `{...done:true,ok}`. **Deviation from plan:** the preflight was `await`ed BEFORE kicking off the real run — this is the root of bug B1 (see review).
- **`src/main/osActions.ts`** — added `osNoteWfRun(action)` (in-process run registry: `_wfRuns` Map + `_wfRunsByAgent` Map, 30s keep-done window) + `wfRunsForAgent` + `setWfRunsProvider` (reserved/unused). `osBroadcast` gained a `workflow-run` branch calling `osNoteWfRun`. `osAgentsSnapshot` return type + body extended with `runs: Record<string, IslandWfRun[]>`. Added `osReadLeaf(runId, nodeId)` resolving `<activeWorkspace>/.blitzos/workflows/<runId>/leaves/<nodeId>.json`. Added `IslandWfRun` exported type.
- **`src/main/index.ts`** — set `process.env.BLITZ_CAPTURE_LEAVES = '1'` at boot (capture was dormant). Wired `broadcast: (action) => osBroadcast(action)` into `wireWorkflowHost`. Added `ipcMain.handle('os:wf-leaf', ...)` calling `osReadLeaf`. Added `osReadLeaf` to the import line.
- **`src/main/workflow-host.d.mts`** — added `broadcast?` to `WorkflowHostDeps`.

### Preload
- **`src/preload/index.ts`** — added `wfLeaf(runId, nodeId)` bridge → `os:wf-leaf` IPC. Added `runs` to the `agents()` snapshot return type.

### Renderer (`src/renderer/src/notch/`)
- **`wfReduce.ts`** (NEW) — verbatim TS port of `lab/kanban/src/reduce.js`: `reduce`, `toBoard` (dropped — unused by Model A), `mergeSkeleton`, `WfModel`/`WfNode` types.
- **`wfShared.tsx`** (NEW) — ported `fmtMs`, `fmtTok`, `summarize`, `firstSentence`, `cardHead`, `JsonView`, `Output` from `shared.jsx`. `useLeaf` rewritten to call `window.agentOS.wfLeaf` (the bridge) instead of fetch. Markdown NOT ported (reuses `MarkdownMessage` per decision #4).
- **`IslandKanban.tsx`** (NEW) — port of `ModelA.jsx`: dynamic column widths (0.95/1.35/1.5 fr for todo/doing/done, empty → 0.4), `labelBreaks` (`<wbr>` after `:`/-/_), hidden scrollbar, the spark animation. Subscribes via `wfSnapshot` + `onWfEvent` + `wfSubscribe`; folds events through `mergeSkeleton(events, skeleton)`; sets `done` on `run:done`. Owns the drawer state (`openNodeId`) internally and renders `IslandLeafDrawer` when a card is clicked.
- **`IslandLeafDrawer.tsx`** (NEW) — port of `LeafDrawer.jsx`: Asked/Did/Returned scrim drawer. "Did" rendered via `MarkdownMessage` (the renderer's shared component). Calls `useLeaf`.
- **`wf.css`** (NEW) — sliced `.kb-*`/`.kc-*`/`.dr-*` from `lab/models.css` (Model A + drawer only; Model B dropped). Self-contained `--kb-*` vars (Nani palette). Added `.isl-wf-board*` for the inline board block.
- **`types.ts`** — added `IslandWfRun` interface + `runs: IslandWfRun[]` to `IslandPanelProps`.
- **`NotchHost.tsx`** — added `runs` state, `WfRunAction` type, `workflow-run` branch in the `onAction` listener (started → append run; done → mark done), hydrates `runs` from `snap.runs` on open. Passes `runs={activeRuns}` to `IslandPanel`.
- **`IslandPanel.tsx`** — imports `wf.css`, `IslandKanban`, `IslandLeafDrawer`. Renders the runs as inline boards at the TOP of the feed (stack-all, start order) — NOT anchored to a transcript ordinal (see "Resolved: anchoring" below for why this differs from the original file-plan wording). Each board has a head row (status dot + "workflow running/done/failed" + filename).

### Deviations from the file plan (as written)
- The plan said "render one `IslandKanban` per run as a message-part at its start ordinal". The implementation renders boards at the TOP of the feed, not at a reconstructed ordinal. This matches the locked "Resolved: anchoring (option 1)" decision (re-anchoring acceptable, live region not a persisted message-part), but the file-plan line above was never updated to match. The "Resolved" section is authoritative.
- The plan's `notch/types.ts` line mentioned an `IslandMessagePart` variant `{type:'workflow-board',...}`. NOT implemented — the board is a live region, not a message-part (per the anchoring resolution). The `runs` slice on the snapshot + `IslandWfRun` type is what was actually added.

## Verification status at `d1a5952`
- `npm run check` PASSED (typecheck + parity + build). New code confirmed present in the bundles (`grep` for `kb-grid`/`osReadLeaf`/`osNoteWfRun`/`BLITZ_CAPTURE_LEAVES` in `out/`).
- Live render NOT verified — the running BlitzOS instance predates the build; `npm run dev` hit the single-instance lock and focused the old window.

## Adversarial review of `d1a5952` (findings)

### Bugs (fixed in the working tree after the review — see below)
- **B1 — Dry preflight blocks the real run by up to 8s.** `runWorkflowHosted` `await`ed the preflight (8s timeout) before kicking off the real run. Every `run_workflow` returned up to 8s late; the agent could stall/time out.
- **B2 — Path traversal in `osReadLeaf`.** `join(root, '.blitzos', 'workflows', runId, 'leaves', nodeId + '.json')` with `runId`/`nodeId` from the renderer (a privilege boundary). `../` in either escapes the dir. `join` does not jail.
- **B3 — Skeleton arrives late; board never gets TODO cards.** WITHDRAWN on re-analysis: the `started` broadcast carries the skeleton, and the board mounts when `started` arrives, so the skeleton IS present at mount (the broadcast is after the preflight await). The real cost was just B1's latency.
- **B4 — Cross-workspace drawer breakage.** `osReadLeaf` resolved the leaf under `osActiveWorkspaceDir()` (the CURRENTLY active workspace). A run's `memDir` is under the workspace active when it RAN. Switch workspaces → drawer reads the wrong workspace → "no output". The run record carries `memDir` (absolute) but `osReadLeaf` ignored it.
- **B5 — `useLeaf` fires for EVERY done card on every render (N IPC calls).** `DoneCard` called `useLeaf(runId, n.nodeId, true)` unconditionally. A 30-leaf run = 30 IPC fetches the moment all cards land in Done, and again on re-render. Thundering herd.

### Concerns (NOT fixed — see "Outstanding" below)
- **C1 — `started` broadcast carries the full `skeleton` array** through the `os:action` IPC channel. For a 500-leaf skeleton that's a large one-shot payload. Acceptable but noted.
- **C2 — 30s `WF_RUN_KEEP_DONE_MS` window.** A done run is dropped from the registry 30s after `done`. Reopen the island 31s later → the frozen board vanishes from the feed (the `IslandKanban` unmounts since `runs[agentId]` no longer has it). The agent's `say` about the result stays in `chat.md`, but the board is gone. Either keep longer, persist, or accept ephemerality.
- **C3 — `setWfRunsProvider` is dead code.** Exported, never called. Remove or wire.
- **C4 — Drawer `openNode` is internal to `IslandKanban`.** When the run is removed from the registry (C2) or the island closes, `IslandKanban` unmounts and the open drawer slams shut under the user.
- **C5 — Global `onWfEvent` listener per board.** Each mounted `IslandKanban` registers its own global `onWfEvent` listener filtering by `runId`. N concurrent runs = N global listeners each receiving ALL runs' events. Wasteful, not broken.
- **C6 — `wfSubscribe` + `wfSnapshot` + `onWfEvent` race window.** The effect calls `wfSnapshot().then(register onWfEvent)` and `wfSubscribe()` after. Between the snapshot resolving and `onWfEvent` registering, a live event could be sent by main and received by NO listener → lost event → card stuck. `bus.subscribe` already replays backlog synchronously, so `wfSnapshot` is redundant; registering `wfSubscribe` FIRST closes the window. NOT yet fixed.

### Nitpicks (NOT fixed)
- `wf.css` `.dr-empty` is defined twice (a drawer status-dot `background` class and a text `font-style` class). The second silently overrides shared properties. Rename one.
- The `.dr-card .isl-msg` / `.dr-card .isl-msg-text` CSS override assumes `MarkdownMessage` renders with those classes. Verified: the wrapper is `.isl-msg.isl-md-msg` (so `.dr-card .isl-msg` matches), but `.isl-msg-text` does NOT exist — that rule is a no-op. The text-part class is `isl-msg-part`. The "Did" markdown will render but won't be tidied by the no-op rule.

## Fixes applied in the working tree (uncommitted, AFTER `d1a5952`)

All five fixes typecheck clean (`tsc --noEmit` exit 0). NOT yet built or live-verified. Files modified: `workflow-host.mjs`, `osActions.ts`, `index.ts`, `preload/index.ts`, `wfShared.tsx`, `IslandKanban.tsx`, `IslandLeafDrawer.tsx`, `IslandPanel.tsx`.

- **B1 fix — `workflow-host.mjs`:** broadcast `started` immediately with an empty skeleton (board mounts, real run kicks off with NO delay), THEN run the preflight IN PARALLEL and re-broadcast `{started:true, skeleton}` when it resolves (the board re-renders with TODO cards). The real run is started first; the preflight never blocks it.
- **B2 fix — `osActions.ts`:** `osReadLeaf` now validates `runId`/`nodeId` against `/^[\w.-]+$/` (blocks `../` traversal). The runtime mints `runId` as `wf_<base36>` and `nodeId` as a numeric jIndex, so the charset is generous and safe.
- **B4 fix — `osActions.ts` + `index.ts` + `preload/index.ts` + `wfShared.tsx` + `IslandKanban.tsx` + `IslandLeafDrawer.tsx` + `IslandPanel.tsx`:** `osReadLeaf(memDir, runId, nodeId)` now resolves the leaf under `memDir` (the run's absolute memory dir, trusted — main minted it via `workflowMemDir`), NOT the active workspace. `memDir` is threaded: IPC `os:wf-leaf` takes `(memDir, runId, nodeId)`; preload `wfLeaf(memDir, runId, nodeId)`; `useLeaf(memDir, runId, nodeId, terminal)`; `IslandKanban` takes `memDir` prop; `IslandLeafDrawer` takes `memDir` prop; `IslandPanel` passes `r.memDir`. Drawer now correct across workspace switches.
- **B5 fix — `IslandKanban.tsx` + `wfShared.tsx`:** `DoneCard` no longer calls `useLeaf`. The card face uses the event's `n.preview` via `summarize` (the same fallback the lab's fixture path used). The full leaf record is fetched lazily ONLY when the drawer opens (`IslandLeafDrawer` calls `useLeaf`). A 30-leaf run no longer fires 30 IPCs on completion. `cardHead` is now only used in the drawer path (removed from `IslandKanban`'s import).

## Outstanding (not fixed; for a follow-up)

- **C2** (30s vanishing) — decide: keep done runs longer, persist them, or accept ephemerality. The plan said "re-anchoring on re-hydrate is acceptable" but a 30s vanishing is shorter than a reasonable island-close/reopen.
- **C6** (subscribe race) — reorder the `IslandKanban` effect: `wfSubscribe` first (it replays backlog synchronously via `bus.subscribe`), drop the redundant `wfSnapshot`, then register `onWfEvent`. Closes the lost-event window.
- **C3** (dead `setWfRunsProvider`) — remove or wire.
- **C5** (N global listeners) — acceptable for V1; revisit if concurrent runs get common.
- **CSS nits** — rename the duplicate `.dr-empty`; fix the `.dr-card .isl-msg-text` no-op (target `.isl-msg-part` or drop).

## End-to-end data flow (for the reviewer)

1. Agent calls `run_workflow`. `os-tools.mjs` mints a `runId` and calls `ops.runWorkflow` → `runWorkflowHosted`.
2. `runWorkflowHosted` ensures the bus run, mints `memDir`, broadcasts `{type:'workflow-run', started:true, skeleton:[], memDir}` immediately, kicks the real run off in the background, and (in parallel) runs the dry preflight → re-broadcasts `{started:true, skeleton}` when it resolves. On the run settling it broadcasts `{done:true, ok}`.
3. `osBroadcast` → `osNoteWfRun` records the run in-process AND fans the action to the renderer via `os:action`.
4. `NotchHost`'s `onAction` listener handles `workflow-run`: appends to `runs[agentId]` (started) or marks done. Hydrate on open comes from `osAgentsSnapshot` (which now includes `runs`).
5. `IslandPanel` renders one `IslandKanban` per run at the top of the feed.
6. `IslandKanban` subscribes to the wf bus by `runId` (snapshot + live events), folds events through `mergeSkeleton(events, skeleton)`, renders the board. On `run:done` it freezes.
7. Clicking a card opens `IslandLeafDrawer`, which calls `useLeaf` → `wfLeaf(memDir, runId, nodeId)` → `os:wf-leaf` IPC → `osReadLeaf(memDir, runId, nodeId)` → reads `<memDir>/leaves/<nodeId>.json` (written by `agent.mjs:captureLeaf` under `BLITZ_CAPTURE_LEAVES=1`). Asked=`leaf.prompt`, Did=`leaf.summary` (via `MarkdownMessage`), Returned=`leaf.result` (via `JsonView`/`Output`).
8. The agent itself does nothing different — it just calls `run_workflow` and `say`s progress. It never knows the board exists.

## Key invariants a reviewer should check
- The agent never calls a "show board" tool (no prompt change, no new syscall). `run_workflow` is unchanged from the agent's view.
- `workflow-host.mjs` stays Electron-free (the `broadcast` seam is a DI dep, like `spawnEnrichment`).
- `wfReduce.ts` is pure + idempotent (replayed from seq 0 → identical state).
- `os:wf-leaf` resolves the run's `memDir` in MAIN by `runId` (`osWfRunMemDir` → durable `_wfMemDirs`); the renderer supplies only `runId`/`nodeId` (also validated). No filesystem path crosses the boundary; correct across workspace switches.
- Capture is default-ON, disable with `BLITZ_CAPTURE_LEAVES=0`/`''`/`false` (uses `??`, and the gate checks the disables explicitly since `'0'` is truthy); best-effort + guarded (never breaks a run).
- `applyWfRun` (`wf-run-state.mjs`) is the ONE upsert rule both main + renderer fold through — a late skeleton-bearing `started` never un-finishes a done run.
- No `chat.md` format change, no `parts` persistence — the board is a live region, not a transcript message.

## Round 2 — second-review fixes (uncommitted, after the in-tree B1–B5 fixes)

A follow-up adversarial review found 5 more issues; all confirmed against the code and fixed. Green gate (`npm run check`) passes; `test-wf-run-state.mjs` (new) + `test-workflow-host.mjs` (extended) pass.

1. **Second-`started` inconsistency (blocker).** After the B1 fix the skeleton arrives in a SECOND `started` broadcast. Main (`osNoteWfRun`) overwrote with `done:false`; the renderer (`NotchHost`) de-duped and dropped it. Net: live boards never got TODO cards, and a fast run could show as perpetually running. Fix: extracted ONE pure rule `applyWfRun` (`src/main/wf-run-state.mjs` + `.d.mts`) — `started` UPSERTS (refresh skeleton/file/memDir, never reset `done`/`ok`/`startedAt`); both `osNoteWfRun` and `NotchHost` fold through it, so they can't drift again. Tests: `test-wf-run-state.mjs` (the started→done→started-skeleton regression) + `test-workflow-host.mjs` (the broadcast sequence).
2. **`os:wf-leaf` trusted a renderer `memDir`.** The B4 fix threaded an absolute path from the renderer (a privilege boundary), validating only `runId`/`nodeId`. Fix: main records `runId→memDir` durably (`_wfMemDirs`, survives the 30s registry cleanup) and `os:wf-leaf` resolves it by `runId` (`osWfRunMemDir`); `memDir` removed from `wfLeaf`/`useLeaf`/`IslandKanban`/`IslandLeafDrawer`/`IslandPanel`.
3. **`useLeaf` stale state + queued cards fetchable.** It never cleared `leaf` on a runId/nodeId change or `{ok:false}`, and `terminal = status!=='running'` made queued TODO cards fetch a non-existent leaf → previous card's Asked/Did/Returned lingered. Fix: clear on every change; `terminal` = done/error/empty only.
4. **Subscribe race (C6).** `onWfEvent` was registered only after `wfSnapshot` resolved, so a live event in that window was lost (card stuck running). Fix: register the listener FIRST, then snapshot + subscribe (seq-dedup handles overlap).
5. **Capture opt-out miswired.** `|| '1'` + `!env` meant `'0'`/`''` never disabled (`'0'` is truthy). Fix: `?? '1'` at boot + explicit `'0'`/`'false'`/`''` check at the gate; comments corrected.
