# BlitzOS — The Plan Widget (W1) and the Job-Status Widget (E3)

Status: SPEC FOR REVIEW (no code). Terse companion to `plans/blitzos-user-journey.md` (the fuller index).

W1 = the user-editable plan widget (inline-editable stages, per-decision multiple-choice toggles, reorder/remove a stage, a comments box, Submit/Reject). E3 = the SAME widget morphs edit->live-status during execution. Key finding: the widget<->agent callback plumbing ALREADY EXISTS, so W1 is "author one widget + pick a return channel + write the authoring idiom," not from zero.

## Current state (verified)

Three widget->agent callback channels exist:
- `blitz.sendMessage(text, sessionId)` -> a `trigger:'message'` moment (widget-bridge.ts:73); routed with a `props.agentId` fallback. Good "wake the right agent" trigger; poor large-payload carrier.
- `__blitz:'action'` raw postMessage -> a `trigger:'action'` moment, full payload on the moment's `action` field, CAPPED 4000B then silently dropped (App.tsx:1598-1600).
- `blitz.setProps(patch)` -> durable own-surface state (SurfaceFrame.tsx:577); survives reload/restart.

Agent->widget update-in-place (E3) is FULLY built: `update_surface{props}` -> `blitz:props` re-post without reload (SurfaceFrame.tsx:592-596). `get_surface {id}` returns a widget's full props (os-tools.mjs), the only way to read a srcdoc widget. Authoring guide = `widgetAuthoringMd()` (widget-catalog.mjs). Kit ships `<blitz-input>`/`<blitz-button>` (widget-ui-kit.ts:94-110); no editable-row/toggle/reorder element.

## What to build

- The plan widget: a jsx library widget (controlled inputs for stage title/detail, per-decision toggles, reorder/remove, comments box, Submit/Reject); persists in-progress edits via `blitz.setProps`; registered in `widgets/widgets.json`; spawned carrying `props.agentId`.
- The return loop: on Submit/Reject, `setProps` the full edited plan + a tiny `sendMessage('plan submitted', props.agentId)`; agent wakes, `get_surface` reads the full plan, reconciles into `plan.md`, flips status.
- The authoring-prompt extension: add the editable-plan idiom + the (currently undocumented) `__blitz:'action'` channel and its cap to `widgetAuthoringMd()`.
- The E3 morph: on approval flip `props.mode` edit->status via `update_surface{props}`; drive each stage `status` as work moves. ONE durable surface across plan->execute, never an html rewrite.

## Sign-off decisions

- RETURN CHANNEL (recommended): the no-core-edit two-step: widget `setProps` the full edited plan + a tiny `sendMessage` carrying `props.agentId`, agent reads via `get_surface`, reconciles into `plan.md`. Alternative needing sign-off: raise the App.tsx:1600 4000-byte cap for a one-shot `__blitz:'action'` submit (a deliberate renderer-security limit).
- A `role:'plan'` first-class surface: decided in `plans/blitzos-job-task-model.md` (touches core types), not here; the widget works as a plain srcdoc carrying `props.agentId` for v1.
- Optional kit elements `<blitz-edit>`/`<blitz-toggle>` so "generic interaction patterns" is literally true; jsx builds both in React, so this is polish.

## Sequencing

Author the jsx plan widget -> wire the two-step return+reconcile -> extend the authoring guide + point the Phase-1 duty at it -> E3 mode flip + bind the surface id onto the Job -> optional kit elements.

Risks: the 4000B cap is invisible (avoided by the two-step); `props.lastError` lands silently so the agent MUST `get_surface` after each update; the widget->agent moment is PRIVATE per `agentId` (a missing `props.agentId` wakes primary '0', not the job agent).

## Cross-references

- `plans/blitzos-user-journey.md` (the fuller index).
- `plans/blitzos-agent-autonomy-guardrails.md` (owns the plan-AUTHORING DUTY + the `plan.md` proposed/approved status convention).
- `plans/blitzos-job-task-model.md` (the Job binding: `agentId`, `planSurfaceId`, plus the `role:'plan'` surface decision).
- `plans/blitzos-tick-diff-steer.md` (W2 supervisor that visualizes the status widget); `plans/blitzos-job-entrypoints.md` (the Send payload that mints the job).
