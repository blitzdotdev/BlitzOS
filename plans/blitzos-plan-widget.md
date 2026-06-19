# BlitzOS — Plan Widget

Status: SPEC FOR REVIEW (no code written). Scope: W1, the interactive, user-editable plan widget with Submit/Reject, plus E3's job-status widget half. This doc builds on `plans/blitzos-job-task-model.md`, it does not redefine the Job object.

## Settled Decisions This Doc Assumes

- W2 uses Option A: BlitzOS only ticks, diffs, and emits perception. The AGENT owns steering judgment. `CLAUDE.md:11` states "The agent supplies intelligence; BlitzOS supplies the loop", and `CLAUDE.md:59` says "No per-task detection" belongs in BlitzOS.
- A and B share one Raycast-like input component with two shells: global non-activating NSPanel for A, in-app keybind HUD for B. Same affordances: prompt, drag-drop files/folders, add-browser-window, Send.
- The spine is the missing work-unit primitive. `plans/blitzos-job-task-model.md:3` says there is "NO first-class Job object today", and says B3, W1, W2, and E1 reference the Job object. Any persistence or architectural primitive below is a decision needing user sign-off.

## Current state (verified)

- There is still no first-class Job binding for W1. The current persisted runtime record is agent/terminal metadata, not a Job: `terminal-manager.mjs:156-165` writes `kind`, `title`, `autonomy`, and `status: 'running'`, with no Job status, plan path, or plan surface field. The chat surface already has the right join key: `types.ts:51-55` defines `role?: string` and `agentId?: string`, quoted as "the agent/thread this surface belongs to".
- The boot-task seam exists, but it is duty text, not a work-unit lifecycle. `agent-runtime.mjs:75-78` calls it an "Optional per-session STANDING DUTY" whose text is owned by the provider, and `agent-runtime.mjs:225-228` re-reads `bootTaskProvider` per launch. Today the mapper is still agent-centric: `index.ts:1059-1064` calls `setBootTaskProvider` and returns onboarding duty for agent `'0'`.
- Agent to widget live updates are built. `os-tools.mjs:356-361` lets `/update_surface` patch `props`; `SurfaceFrame.tsx:590-596` says "Live prop changes reach the widget without reloading it" and posts `{ type: 'blitz:props', props: widgetProps() }`.
- Widget self-state is built. `widget-bridge.ts:77` exposes `setProps: function (patch)`, and `SurfaceFrame.tsx:577-581` handles `m.op === 'setprops'` by calling `updateSurfaceProps(surface.id, patch)`. This is the correct place for in-progress plan edits.
- Widget to agent wake via chat is built. `widget-bridge.ts:73` exposes `sendMessage: function (text, sessionId)`, and `SurfaceFrame.tsx:494-498` routes it to `window.agentOS.sendMessage`, falling back to `surface.props?.agentId || '0'`. W1 must pass the Job agent id, not rely on fallback.
- Widget to agent structured action is built but size-limited. `App.tsx:1614-1617` describes postMessages with `{__blitz:'action', surfaceId, ...}` as the callback half of interactive surfaces, and `App.tsx:1631-1636` forwards only when `JSON.stringify(d).length <= 4000`. `preload/index.ts:279-282` sends `os:surface-action`, `osActions.ts:418-424` strips the envelope and calls `emitSurfaceAction`, and `perception-core.mjs:536-547` emits `trigger: 'action'` with `action`.
- The size-safe readback path is built. `os-tools.mjs:399-407` defines `/get_surface` as "Fetch ONE surface in full (layout + props; html still omitted)", which is the agent's read after a tiny submit wake.
- JSX widgets are built. `widget-jsx.ts:32-49` compiles JSX/TSX through `compileInto`, and `widget-jsx.ts:81-89` writes compile errors into `props.lastError`. `SurfaceFrame.tsx:560-566` separately folds runtime failures into `props.lastError`.
- The shared kit already has the generic controls W1 needs. `widget-ui-kit.ts:112-131` defines `<blitz-edit>` as an inline editable field that fires `change` and `input`; `widget-ui-kit.ts:133-150` defines `<blitz-toggle>` for per-decision yes/no. `widget-ui-kit.ts:161-164` also exposes imperative `.edit` and `.toggle` helpers.
- The authoring prompt in this working tree already contains the editable-plan idiom. `widget-catalog.mjs:263-268` introduces "Editable / interactive widgets" and names the plan widget as the classic case. `widget-catalog.mjs:295-306` documents the recommended return channel: first `setProps`, then a tiny `sendMessage`, then the agent reads with `get_surface`. `widget-catalog.mjs:308-315` documents the direct `__blitz:'action'` channel and its 4000 byte cap.
- A draft plan widget exists in the catalog, but the journey is incomplete without the Job binding. `widgets/widgets.json:119-124` registers `"name": "plan"`, `"lang": "jsx"`, and describes the W1 return loop. `widgets/plan.jsx:8-18` documents the props contract and the two-step return channel; `widgets/plan.jsx:51-64` re-seeds from `onProps`; `widgets/plan.jsx:89-95` calls `setProps` then `sendMessage`; `widgets/plan.jsx:140-161` renders decision toggles, comments, Approve, and Send back.
- The proven round-trip precedent exists outside the plan widget. `widgets/remix.html:166` wraps `window.blitz.sendMessage`, `widgets/remix.html:180-185` sends command messages, and `widgets/remix.html:212-221` re-renders from `window.blitz.ready` plus `window.blitz.onProps`.

## What to build

- Treat the W1 widget as a reusable JSX library widget with a stable data contract. The minimum props shape is `mode:'edit'|'status'`, `agentId`, `jobId` once the spine exists, `stages:[{id,title,detail,status}]`, `decisions`, `comments`, and `decision`. The existing draft in `widgets/plan.jsx:8-18` is the correct contract seed; implementation should harden its visual and behavioral states, not invent a second plan protocol.
- Keep the widget controlled and self-persisting. Every edit to a stage title/detail, reorder/remove, per-decision toggle, and comments box writes back through `blitz.setProps`. This matches `widget-catalog.mjs:270-274`, which says the "source of truth" for user changes is `props`.
- Use Submit and Reject as return actions, not final authority. On Submit/Reject the widget writes the full edited state with `setProps({ stages, decisions, comments, decision })`, then wakes the owning Job agent with a tiny `sendMessage('plan approve'|'plan reject', agentId)`. This is the recommended no-core-edit return channel because the edited plan rides in props and is read via `/get_surface`.
- The agent return loop is: wake on `trigger:'message'`, call `get_surface {id}`, check `props.lastError`, reconcile the edited plan into that Job's `plan.md`, then update the widget props. The plan-authoring duty and `plan.md` status convention are owned by `plans/blitzos-agent-autonomy-guardrails.md`; that doc says the agent writes `.blitzos/onboarding/plan.md` with `status: proposed` and presents a "FULLY EDITABLE plan widget" at `plans/blitzos-agent-autonomy-guardrails.md:45-52`.
- E3 is the same surface after approval. The agent flips `props.mode` from `edit` to `status` via `update_surface {props}`, then drives each stage `status` as work moves. This reuses the verified live props path, avoids replacing widget HTML, and keeps one durable Job surface across planning and execution.
- Tie the widget to the Job through the spine, not through a local convention. The widget can run today as a plain `srcdoc` with `props.agentId`; the durable binding is `Job.planSurfaceId` plus `Job.agentId` from `plans/blitzos-job-task-model.md:18-26`. Adding a first-class `role:'plan'` surface remains a sign-off decision from `plans/blitzos-job-task-model.md:35-42`.
- Keep the authoring prompt as part of the product surface. If this doc is applied to a branch without the current prompt additions, extend `WIDGET_AUTHORING_MD` with the editable-plan idiom, the two-step return channel, the direct action channel, and the cap warning. In the current tree, preserve and review the sections at `widget-catalog.mjs:263-323` rather than duplicating them elsewhere.

## Return Channel Decision

- Recommended: two-step `setProps` plus tiny `sendMessage`. Evidence: `setProps` is own-surface durable state (`SurfaceFrame.tsx:577-581`), `sendMessage` can route to the Job agent (`SurfaceFrame.tsx:494-498`), and `get_surface` reads full props (`os-tools.mjs:399-407`). This requires no core edit.
- Alternative needing user sign-off: raise or parameterize the direct action cap in `App.tsx:1631-1636` and submit the whole plan as one `__blitz:'action'` payload. This is a core renderer security edit, and it still needs explicit handling for silent drops and payload growth.

## Sequencing

1. Get user sign-off on the Job spine decisions that W1 depends on: persistence location, `start_job`, `Job.agentId`, `Job.planSurfaceId`, and any `role:'plan'` surface primitive.
2. Adopt or harden the existing `widgets/plan.jsx` template as the W1 library widget. Verify controlled edits, reorder/remove, decision toggles, comments, Submit, Reject, `mode:'status'`, and `props.lastError` behavior.
3. Lock the two-step return channel as the default. If the user chooses the one-shot direct action alternative, make that a separate signed core change.
4. Wire the Job agent's Phase-1 plan-authoring duty to spawn the plan widget with `props.agentId`, `jobId`, initial stages, decisions, and a known surface id recorded on the Job.
5. Implement the return loop in the agent duty: on plan submit/reject, read `get_surface`, reconcile into `plan.md`, update Job status, and push normalized props back with `update_surface`.
6. Implement the E3 status morph: on approval, keep the same surface, set `mode:'status'`, then update stage status through execution.
7. Verify with a real JSX compile and round-trip: spawn widget, edit props, submit, confirm the intended agent gets the private message, confirm `get_surface` contains full edited props, update status props, and re-read `props.lastError`.

## Risks

- The direct `__blitz:'action'` channel silently drops payloads above 4000 bytes at `App.tsx:1631-1636`; a multi-stage edited plan can exceed that. The two-step route avoids the cap.
- `props.lastError` is observable only after a read. `widget-jsx.ts:81-89` and `SurfaceFrame.tsx:560-566` write errors into props, so the agent must call `get_surface` after JSX updates.
- The wake is private to one agent. `perception-core.mjs:55-60` says message/action moments are visible only to the targeted agent id, so a missing `props.agentId` wakes primary `'0'` instead of the Job agent.
- Agent-pushed props can overwrite local edits if the Job agent updates from stale state. The widget should keep props as the single source of truth and the agent should read before write.
- The draft widget exists, but the user journey is not complete until the Job record owns `planSurfaceId`, status, and plan path. Without that spine, W1 is only a reusable surface.
- E3 must not become OS-side steering. Updating a visible status widget is content display. Judging whether progress is good, stuck, or needs steering belongs to the agent under the settled W2 Option A doctrine.

## Open decisions

- DECISION NEEDING USER SIGN-OFF: Job persistence and binding from `plans/blitzos-job-task-model.md`: extend agent `meta.json` vs dedicated `.blitzos/jobs/<id>.json`, and store `agentId`, `planSurfaceId`, and `planPath`.
- DECISION NEEDING USER SIGN-OFF: add a first-class `role:'plan'` surface primitive. The widget can run as plain `srcdoc` for v1, but a role touches the surface model.
- DECISION NEEDING USER SIGN-OFF: keep the recommended two-step return channel, or raise/parameterize the `__blitz:'action'` cap for one-shot plan submit.
- Product decision, no core sign-off unless it changes persistence: keep `widgets/plan.jsx` as the canonical visual template or let agents fork it per Job while preserving the same props and return contract.
- Product decision: whether to add a reorder-specific kit primitive later. `<blitz-edit>` and `<blitz-toggle>` already exist; reorder/remove can stay inside the plan widget unless repeated widgets need it.

## Cross-references

- `plans/blitzos-user-journey.md`, the index for Onboarding -> Job setup -> Planning -> Execution.
- `plans/blitzos-job-task-model.md`, the spine for the Job object, `agentId`, `planSurfaceId`, lifecycle, and sign-off decisions.
- `plans/blitzos-tick-diff-steer.md`, W2 supervisor heartbeat. This doc assumes Option A: perception only, agent-owned steering.
- `plans/blitzos-job-entrypoints.md`, Phase 2 A/B entry points, A5 menubar, notifications, and the Send payload that creates a Job.
- `plans/blitzos-agent-autonomy-guardrails.md`, E1 continuation engine and the agent's Phase-1 plan-authoring duty. This doc owns widget mechanics and the return loop only.
- `plans/onboarding-case-file.md`, Phase 1 onboarding context that feeds the resident and first Job proposal.
