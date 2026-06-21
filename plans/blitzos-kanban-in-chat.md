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
