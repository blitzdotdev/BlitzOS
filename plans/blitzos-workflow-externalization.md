# BlitzOS — Deep workflow externalization (live viz + enrichment)

Status: DESIGN, decisions locked 2026-06-18. Parent: `blitzos-user-journey.md` (Pass 2 item 1). Builds on `blitzos-blitzscript.md` (the runtime) + the perception/tick core.

## What this is
When a Deep workflow runs, BlitzOS draws it LIVE on the canvas: the workflow graph, every agent leaf's lifecycle, and the final result, as widgets. **Generic-live-first:** a shipped generic widget renders the run from t=0 off a live event stream; a fresh enrichment agent then rewrites that widget into a bespoke view, compile-gated. No agent is ever in the per-event loop. The widget is event-sourced, so mount time never matters.

## Locked decisions
- Generic-live-first, agent enriches (not bespoke-from-scratch).
- Host auto-triggers the viz on `run_workflow` (the agent does not ask for it).
- Deep workflows run IN-PROCESS in main (resolves the open Bash-vs-host-tool fork toward a host tool) so the runtime's progress events are visible to BlitzOS.
- Fresh enrichment agent, NOT a session fork: `claude -p --model opus --effort low` (opus 4.8, low reasoning for speed), focused context injected.
- Two generic widgets to try, both transparent (nodes/edges read as placed on the canvas): a kanban post-it board + a React-node-graph view.
- Enrichment edits the generic widget's source directly, compiles it, and posts via `update_surface` ONLY on a clean compile.

## Event schema (host-stamped telemetry; NOT part of the deterministic journal)
`nodeId` = the `agent()` invocation index (`ctx.jIndex`): stable, positional, resume-safe.
```ts
type WfEvent =
  | { seq; ts; type:'run:start';   runId; name; description }
  | { seq; ts; type:'phase';       phaseId; title }
  | { seq; ts; type:'group:start'; groupId; kind:'parallel'|'pipeline'; phaseId?; size }
  | { seq; ts; type:'group:done';  groupId; ok; failed }
  | { seq; ts; type:'agent:start'; nodeId; label; phaseId?; groupId?; index?; model; harness }
  | { seq; ts; type:'agent:done';  nodeId; status:'ok'|'error'|'null'; ms; tokens; rolloutPath?; preview }
  | { seq; ts; type:'log';         phaseId?; groupId?; message }
  | { seq; ts; type:'error';       nodeId?; message }
  | { seq; ts; type:'run:done';    ok; ms; calls; tokens; preview }
```

## Widget subscribe API
```ts
// widget bridge, inside the sandboxed iframe:
blitz.workflow.subscribe(runId, (ev: WfEvent) => void): () => void  // backlog first, then live
blitz.workflow.snapshot(runId): WfEvent[]                            // sync backlog pull
```
The host BUFFERS every event per runId and replays the full backlog on subscribe. Any widget (generic at t=0, or enriched swapped in mid-run) reconstructs identical state. This is also why an `update_surface{html}` reload is safe: the new widget re-subscribes and replays.

## The two generic widgets (same data, two renderers)
Both consume `WfEvent`, both transparent/frameless over the canvas, both styled from the `--blitz-*` tokens (`widget-ui-kit.ts`).
- **`wf-kanban.jsx`** — columns = phases; each `agent()` leaf = a post-it. States: not-started = grayed out; running = border glow + a live status line; done = a summary note (preview + ms + tokens). Plain React, no new lib.
- **`wf-graph.jsx`** — agent leaves = nodes, structural relations = edges (phase sequence + group fan-out), auto-laid-out, rebuilding as events arrive. `@xyflow/react` + `dagre` (layout); React Flow panes styled transparent.

## Host auto-trigger flow (`run_workflow`)
1. Orchestrator calls `run_workflow {file}` (the in-process replacement for `bash blitz run`).
2. Host assigns `runId`, makes a buffered bus, installs `setProgressSink` to publish into it.
3. Host instantiates the chosen generic widget (a per-run COPY of the source) bound to `runId`, places it via `place_widget`. Live from t=0.
4. Host runs `runWorkflow` in-process; events stream to the bus, the widget lights up.
5. Host spawns the fresh enrichment agent in parallel.
6. `run:done` writes `result.json` (already does) and the widget shows the final state.

## The enrichment agent
- `claude -p --model opus --effort low`, a detached one-shot (not a managed terminal, so no auto-restart loop). It does its one job and exits. (Confirm the exact opus-4.8 model id at build.)
- Reaches the canvas through the localhost control API (`~/.blitzos/session.json` url + token, the same path a Stop-hook uses).
- Edits the per-run widget source file directly, runs the compile-check CLI, and `update_surface`s the new srcdoc ONLY on a clean compile. A reload is fine (event-sourced replay catches it up).
- Context injected (the 5 access requirements, minus the fork): an `externalize.md` duty (design tokens + graph patterns + the event schema + the subscribe contract) + the script path + the `runId` + pointers to `journal.jsonl` and the per-leaf rollout dirs.

## Verified pipeline facts (build on reality, not assumptions)
- React 19 + npm libs already run in the `sandbox="allow-scripts"` srcdoc via a runtime Sucrase transform + an esm.sh importmap; no CSP blocks the CDN. [`widget-jsx-core.mjs`, `widgets/runtime/registry.json`]
- The importmap is a closed allowlist baked into the renderer bundle (static import at `widget-jsx.ts:10`). Adding a lib = edit `registry.json` + `npm run build`. `@xyflow/react`/`dagre`/`elkjs`/`d3` are not in it yet.
- Transparent bg is NOT supported today: `UI_KIT` forces an opaque body (`widget-ui-kit.ts:39`) and `.window`/`.window-body` are opaque except `.browser`/`.note`. Needs a new frameless-transparent surface treatment. [`SurfaceFrame.tsx`, `styles.css`]
- A widget's content is a real `.jsx` file in the workspace folder, editable + re-postable via `update_surface{html, lang}`. `update_surface{html}` RELOADS the widget (in-widget state lost), safe here only because of event-sourced replay. [`workspace.mjs`, `os-tools.mjs:354`]
- No widget lint today (tsconfig scopes to `src/` only; no eslint). The gate = a ~15-line CLI around `compileJsxSource` (syntax-only, no types). To build. [`tsconfig.json:21`, `widget-jsx-core.mjs:41`]
- Design tokens live in `widget-ui-kit.ts` (`UI_KIT`, the `--blitz-*` set); `plan.jsx` is the reference authoring pattern (kicker, token vars, web components).

## Build order
**A. Foundation (runtime + host)**
1. Enrich the progress sink to emit the full `WfEvent` schema (today: `agent` start only): add `agent:done`, `group:start`/`group:done`, `run:start`/`run:done`, host-stamped `seq`+`ts`; thread a `groupId` through `ctx` (AsyncLocalStorage) from `parallel()`/`pipeline()`. [`agent.mjs`, `runtime.mjs`]
2. `run_workflow` host tool + in-process `runWorkflow` + a buffered per-runId event bus. [`os-tools.mjs`, `electron-os-tools.ts`, `osActions.ts`, new bus module]
3. `blitz.workflow.subscribe`/`snapshot` in the widget bridge + main→iframe event streaming. [`widget-bridge.ts`, `SurfaceFrame.tsx`, an IPC channel]

**B. Generic widgets**
4. Frameless-transparent surface treatment. [`SurfaceFrame.tsx`, `styles.css`]
5. Registry: add `@xyflow/react` + `dagre` to `registry.json`, then `npm run build`.
6. `widgets/wf-kanban.jsx` + `widgets/wf-graph.jsx`, registered in `widgets/widgets.json`.

**C. Auto-trigger + enrichment**
7. Host auto-instantiates the generic widget on `run_workflow` (per-run copy, bound to runId).
8. `scripts/compile-widget.mjs` (the syntax compile gate).
9. The enrichment agent spawn + `externalize.md` duty doc.

## Open micro-decisions
- Default generic widget: kanban or graph? Lean: build both, default to graph (the "workflow tree" native), kanban selectable.
- Drill-in: inline `preview` in `agent:done` (v1) vs a host read-API for the full rollout-on-click (later). Lean v1 inline.
- Frameless: drop the window frame entirely (pure nodes on canvas) or keep a minimal frame? Lean frameless.

## Cross-references
- `blitzos-blitzscript.md` — the runtime these events come from (the `setProgressSink` seam, `agent()`/`parallel()`/`pipeline()`).
- `blitzos-user-journey.md` — Pass 2 item 1 (the parent).
- Verified anchors: `widget-jsx-core.mjs`, `widgets/runtime/registry.json`, `widget-ui-kit.ts`, `workspace.mjs`, `perception-core.mjs`.
