# Plan: live workflow kanban inside agent chat

Port the lab's Kanban A (`lab/kanban/src/`) into the real island chat. When an agent runs a workflow, BlitzOS shows a live board INLINE in that agent's chat. The agent never calls a "show board" tool and never knows the board exists; it just calls the existing `run_workflow`.

## Verified facts
- Wf event pipe already exists, unused in V1 renderer: `workflow-bus.mjs` (per-runId buffer + replay-then-live `subscribe`), `workflow-host.mjs:runWorkflowHosted`, `index.ts:693` `os:wf-{subscribe,snapshot}` IPC + `os:wf-event` fan-out, `preload` `window.agentOS.wf.*` bridges.
- `run_workflow` already takes `agent` (default `'0'`) → a run is tied to an agent at mint. No new agent tool.
- Per-leaf capture ALREADY exists, opt-in via `BLITZ_CAPTURE_LEAVES=1` (`agent.mjs:282-322` `captureLeaf` → `<memDir>/leaves/<nodeId>.json` = `{prompt,result,summary,sessionId,...}`). Lab sets the flag; real app does NOT → dormant. Enabling = one env line.
- "Asked"=`prompt`. "Returned"=`result` (typed). "Did" = the leaf's final assistant text — NOT `summary` (`_leafSummary` is a stringified parse), so add one field to `captureLeaf` (see runtime edit).
- Milestones already ride `os:action {type:'milestone'}` → NotchHost state → IslandPanel prop, hydrating via `osAgentsSnapshot`. Runs reuse this exact path — no new store module.

## Decisions (locked)
1. Placement: INLINE in the transcript as a new message-part, anchored at run start, updating in place, frozen on done.
2. Concurrent runs: stack-all, one board per run in start order.
3. TODO cards: full kanban — best-effort `dry:true` preflight in `runWorkflowHosted` for the skeleton (gated + timeout, like the lab).
4. Drill-in drawer: full parity (Asked/Did/Returned). Reuse the renderer's existing `MarkdownMessage`/`react-markdown` for "Did" (port only a small `JsonView` for "Returned").
5. ONE new IPC `os:wf-leaf {runId,nodeId}` (precedent: `os:wf-snapshot`, `os:agents-snapshot`). Returns the leaf JSON (Asked/Did/Returned). Lazy on-click.
6. Runs flow the milestone path: `osBroadcast({type:'workflow-run',...})` + hydrate in `osAgentsSnapshot`; NotchHost `onAction` adds a `workflow-run` branch (no new external store).

## File plan
- `blitzscript/agent.mjs`: in `captureLeaf` add `did` = the leaf's final assistant text (extracted from `leafStdout`, best-effort). ~3 additive lines. Then "Did" reads straight from the leaf JSON — no rollout resolution.
- `workflow-host.mjs`: in `runWorkflowHosted` run a best-effort `dry:true` preflight → `skeleton`; broadcast `{type:'workflow-run',agentId,runId,file,title,started:true,skeleton,memDir}` via `osBroadcast`; on `run:done` broadcast `{...done:true,ok}`.
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

## Open (resolve before coding)
1. Transcript anchoring: confirm the message-part path in `IslandPanel`/`messageParts.ts`/`MarkdownMessage.tsx` can host a live-updating board at a stable ordinal without re-anchoring on every transcript push. No lab precedent; verify first.

Status: plan only, no code. Next: resolve open 1.
