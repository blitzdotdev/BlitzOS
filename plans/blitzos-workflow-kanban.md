# Workflow kanban in chat — research (not impl yet)

Goal: when the model runs a blitzscript workflow (`run_workflow`), a generic LIVE kanban board auto-appears IN the
island chat and updates as the run progresses. Make the kanban great; drop the graph view for now.

## What already exists (REUSE — verified)
- The event stream is board-ready. `run_workflow` runs IN-PROCESS (`workflow-host.mjs`); the runtime emits 9
  `WfEvent`s — run:start / phase / group:start / group:done / agent:start / agent:done / log / error / run:done —
  stamped `seq`+`ts`+`runId` (`blitzscript/progress.mjs`, `workflow-bus.mjs`). Hierarchy: run → phase (flat,
  `phaseId === title`) → optional group (parallel/pipeline, `groupId`+`size`) → leaf agent (`nodeId`, stable + resume-safe).
- Status is fully derivable: queued = `group.size − started`; running = `agent:start`; done/error/empty = `agent:done.status`.
  Proven by the existing `widgets/wf-kanban.jsx` `reduceEvents` (a clean pure reducer → `{name, status, stats, groups, nodes}`).
- Buffered bus with BACKLOG REPLAY (`subscribe` replays all prior events, dedup by `seq`) → a board mounting MID-RUN
  reconstructs full state. Completion → `result.json` at `.blitzos/workflows/<runId>/`.
- The host→renderer pipe is FULLY INTACT, just consumer-less: `os:wf-subscribe`/`os:wf-event`/`os:wf-snapshot` IPC
  (`index.ts`) + preload `subscribeWorkflow`/`onWfEvent`/`snapshotWorkflow`. An island component can subscribe with
  ZERO main/preload changes.
- Only the TOP-LEVEL hosted run is observable (events with `runId == null` are dropped — nested `workflow()` + plain
  `blitz run` CLI runs are invisible). Fine for v1.

## What's DEAD (do not revive)
- The viz was a srcdoc widget (`wf-kanban.jsx`/`wf-graph.jsx`) on the CANVAS — V1 cut the canvas, so nothing renders
  it now. `SurfaceFrame` + the widget pipeline are gone; `workflow-enrichment.mjs` is a no-op. The only live surfacing
  today is the agent's plain `say` text lines.
- So build a NATIVE island React kanban (port `reduceEvents` + `useSyncExternalStore` over `onWfEvent`), NOT a srcdoc
  widget. Do not reintroduce a canvas.

## Decided (user, 2026-06-20)
1. EMBEDDING = inline LIVE bubble in the transcript (where the run started; updates in place, freezes on done, scrolls
   with history). Host `say`s a ```blitz-board {runId,title} fence at run start — mirrors the ```blitz-ui choice card.
2. COLUMNS = phase swimlanes × status: rows = phases (ordered from the `phase` events; the no-phase bucket = "Setup"),
   columns = To do / Running / Done. Shows structure + flow at once.
3. PERSISTENCE = yes, mirror the attachment snapshot: live from the bus during the run, FREEZE on run:done.

## Resulting build shape (for the impl plan)
- Render path is ONE reducer fed by either source — port `widgets/wf-kanban.jsx` `reduceEvents` to a native module
  (`workflowBoard.ts`): events[] → `{name, phases[], nodes[], groups[], status, stats}`. Pivot into phase rows ×
  status cols at render.
- New island component `<WorkflowKanban runId>` (notch/): on mount, `subscribeWorkflow(runId)` (backlog replay + live)
  via the intact preload pipe; reduce; render swimlanes. Dedup by `seq`. Uses the no-zustand store pattern if shared.
- Parse: add `parseBlitzBoard` to `messageParts.ts` (mirror `parseBlitzUiChoicePart`) → a new `{type:'board',runId,title}`
  message part; render it in `MarkdownMessage.tsx` as the live `<WorkflowKanban>`. This is the one LIVE part (the others
  are static) — keep the answered-card collapse logic unaffected.
- Auto-trigger: `runWorkflowHosted` (workflow-host.mjs) `say`s the board fence once at run start (host-driven, agent
  not involved), and on `run:done` writes the run's buffered events to `.blitzos/workflows/<runId>/board.json`.
- Persistence read: `<WorkflowKanban>` uses live bus events if present; else falls back to a new `os:wf-board-get`
  IPC → `board.json` (after restart / once the bus cleared the run). Same reducer renders both → identical board.
- Scope: kanban only (defer wf-graph), NATIVE React, top-level hosted run only. Data subscribe = ZERO main changes;
  only the freeze (host write + one read IPC) is net-new main-side.
