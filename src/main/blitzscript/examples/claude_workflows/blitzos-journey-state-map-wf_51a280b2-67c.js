export const meta = {
  name: 'blitzos-journey-state-map',
  description: 'Map current BlitzOS state vs the desired user-journey to spec the refactor',
  phases: [
    { title: 'Map', detail: '8 Opus readers deeply map built-vs-needed across BlitzOS subsystems' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'

const READER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subsystem','summary','built','partial','missing','refactorNotes','docCorrections','keyFiles','openQuestions'],
  properties: {
    subsystem: { type: 'string' },
    summary: { type: 'string', description: '3-5 sentence overview of current state vs the journey' },
    built: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['capability','evidence'], properties: {
      capability: { type: 'string' }, evidence: { type: 'string', description: 'file:line refs + short quote' }, notes: { type: 'string' } } } },
    partial: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['capability','exists','missing'], properties: {
      capability: { type: 'string' }, exists: { type: 'string', description: 'what exists + file:line' }, missing: { type: 'string' }, notes: { type: 'string' } } } },
    missing: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['capability','journeyRef','hookPoint'], properties: {
      capability: { type: 'string' }, journeyRef: { type: 'string', description: 'board item e.g. A1, W2, P1, O2b' }, hookPoint: { type: 'string', description: 'exact file/function where it would integrate' }, notes: { type: 'string' } } } },
    refactorNotes: { type: 'string', description: 'concrete: files to touch, new modules, sequencing, risks, enough to write a spec' },
    docCorrections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['boardItem','correctStatus','reason'], properties: {
      boardItem: { type: 'string' }, currentStatus: { type: 'string', description: 'what plans/blitzos-user-journey.md currently marks it' }, correctStatus: { type: 'string', description: 'built | partial | todo' }, reason: { type: 'string' } } } },
    keyFiles: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const JOURNEY = `
DESIRED USER JOURNEY (BlitzOS) — map CURRENT code against THIS. 4 phases + 2 build items.

PHASE 1 ONBOARDING: O1 spawn BlitzOS; O2 data scraping (O2a local laptop scan; O2b integrations API: Google Drive / Work Gmail / GitHub repos); O3 summarize user life; O4 build user profile; O5 build index of pointers to info.

PHASE 2 JOB/TASK SETUP = two ways to START a job or task (A and B are ENTRY POINTS, not import-source vs spawn):
  A) macOS helper: a Raycast-like dynamic-island utility window OUTSIDE BlitzOS. A1 the helper window (can spawn jobs/tasks); A2 drag&drop files/folders into job/task context (symlink vs copy/mirror); A3 add OPEN browser windows to context by clicking "add" inside the window, via an auto-installed ~/agent-socket Chrome extension that talks to BlitzOS (Connect to Chrome/Edge; Safari = open question); A4 hit Send -> kicks off the job in BlitzOS; A5 optional Mac menubar widget showing status without opening BlitzOS.
  B) BlitzOS direct: B1 user talks to BlitzOS directly to initiate; B2 a NEW built-in Electron interface (NOT today's canvas chat widget): keybind-toggled HUD on the rail, NOT the canvas; B3 BlitzOS orchestrates -> spawns a job agent -> places it on the infinite canvas; B4 a dedicated chat widget for that agent.
  J-split (orthogonal to A/B): Job -> planning + exec; Task -> no planning (act directly: look user context, create widgets without planning, create connections). J-agents: spawn agent(s) (v2 = multiple), claude/codex backends.

PHASE 3 PLANNING (Job path only) = build item W1: P1 show plan widget; P2 user edits; P3 AI updates; P4 execute? (Y->execute / N->loop back). The plan widget is INTERACTIVE + user-EDITABLE with Submit/Reject buttons; an authoring PROMPT guides the job agent to produce it.

PHASE 4 EXECUTION = build item W2: E1 use /goal on plan (continuation: do-not-stop-until-done); E2 on a TICK/heartbeat, BlitzOS diffs its state and the SUPERVISOR AGENT decides steer-or-next (Option A DECIDED: BlitzOS only ticks+diffs+emits the diff as perception; the AGENT owns the steering judgment; NO per-task heuristics in the OS); E3 the job agent gives updates in its chat AND in a widget.

[N] NOTIFICATION (cross-cutting): the system surfaces status to the user (chat lines, system moments, a menubar widget, OS notifications).

BUILD ITEMS: W1 = editable plan widget + authoring prompt (Phase 3). W2 = tick->diff->steer heartbeat (Phase 4 E2), Option A.
`

const COMMON = `
Repo root: ${ROOT}. READ-ONLY research; do NOT edit any files.
READ THE ACTUAL FILES IN FULL for your subsystem (use Read, not only grep) so the map is precise. Cite file:line for EVERY claim with short quotes. Where a capability is MISSING, name the exact file/function where it would hook in. Be exhaustive and concrete — this feeds a detailed refactor SPEC, not a summary.
There is an existing doc plans/blitzos-user-journey.md that marks board items as built(✅)/partial(🟡)/todo(⬜); VERIFY those marks for items in your scope and return any corrections in docCorrections with evidence.
If a journey item conflicts with current architecture, say so plainly with evidence (e.g. O2b integrations vs the browser-first auth removal). Return ONLY the structured object.
`

const READERS = [
  { key: 'onboarding', title: 'P1 onboarding + data scraping (O1-O5, O2b)', prompt: `Map the ONBOARDING + DATA-SCRAPING subsystem.
Read: src/main/onboarding.ts, scripts/onboarding-scan.mjs, src/main/onboarding-board.mjs, src/main/blitzos-interview.md, src/renderer/src/onboarding/config.ts and OnboardingFlow.tsx, plans/onboarding-case-file.md, widgets/widgets.json, src/main/browser-import.ts.
Map O1 spawn, O2a local scan (Calendar / AddressBook contacts join / mdfind doc census / doc authors / web-first SaaS detection), O3 context.md, O4 profile.md + the P2 interview, O5 board.json/scan.json as the "index of pointers".
CRITICAL O2b: the OAuth/integrations subsystem was removed 2026-06-16 (commit 629b40d) for browser-first auth. Verify what data-import paths exist NOW (local scan only? browser-first? MCP connectors?), and state concretely what satisfying O2b would take and which reconciliation (browser-first reframe / MCP read-only / re-introduce a scoped connector) is most architecture-aligned, with evidence.` },

  { key: 'agent-runtime', title: 'Agent runtime + lifecycle (B3, J-agents, E1)', prompt: `Map the AGENT RUNTIME + LIFECYCLE subsystem.
Read: src/main/agent-runtime.mjs (buildBootstrap, prepareAgentLaunch, setBootTaskProvider, backends), src/main/terminal-manager.mjs (spawnTerminal, auto-restart, established/resume), src/main/index.ts (launchAgent, setBootTaskProvider wiring, osResumeAgentsOnBoot), src/main/os-tools.mjs (spawn_agent / kick brain tools), src/main/onboarding.ts (interviewBootTask, RESIDENT_INITIATIVE_BOOT_TASK), plans/blitzos-agent-autonomy-guardrails.md.
Map: agent spawn flow, backends (claude default, codex), what "agent '0'" (primary) is vs spawned peers, the boot-task duty seam (re-read per launch), multi-agent state ("v2"), and the E1 /goal continuation status: what is DONE (wait.sh backgrounded) vs TODO (plan.md-gated Stop hook, stage-status convention, spin-guard, permission-mode gate). This is the foundation for B3 (spawn a job agent) and J-agents.` },

  { key: 'perception', title: 'Perception / moments / wake / diff (E2, W2)', prompt: `Map the PERCEPTION -> MOMENTS -> WAKE loop and any state diffing (the foundation W2 must build ON).
Read FULLY: src/main/perception-core.mjs (INJECT sensors, ingestSignals, flush, BATCH_MS, sweep timer, waitForEvents long-poll, visibleTo, emitUserMessage, moment shape), src/main/events.ts, src/main/osActions.ts (INJECT injection points, the 350ms drain, diffCanvasOps), src/main/os-tools.mjs (the /events tool).
Confirm/correct the W2 overlap claims: the wake channel (/events long-poll) to reuse; the existing cadence (15s batch + 2s sweep); diffCanvasOps diffs only surface GEOMETRY reactively (no agent/task/progress diff, no periodic whole-state diff); emitUserMessage as the per-agent steering-delivery seam; visibleTo routing (only agent '0' sees desktop/canvas moments).
For W2 concretely: where exactly would a periodic tick emitter hook in? What os:state + agent-status sources are available to diff (enumerate them with file:line)? What is the moment shape a trigger:'tick' would carry? Name the materiality/coalescing rules to mirror so a quiet desktop does not spam wakes.` },

  { key: 'widgets', title: 'Widget system (W1 plan widget, E3)', prompt: `Map the WIDGET system — CRITICAL for W1 (the interactive, editable plan widget with Submit/Reject).
Read: src/main/widget-tools.mjs (makeWidgetToolHandlers, the blitz.tool subset), src/main/os-tools.mjs (place_widget, new_app, customize_widget, say and any widget tools), widgets/widgets.json (the manifest) and a representative set of the widget .html/.jsx files it lists, plans/jsx-widgets.md, and the renderer code that RENDERS widgets (srcdoc iframe sandbox, jsx widgets, native note) in src/renderer/src/components (SurfaceFrame and any widget host).
ANSWER PRECISELY: (1) Can a sandboxed widget contain interactive controls (buttons, inputs, toggles) that call BACK to the agent? Is there a widget->agent message/callback channel (e.g. blitz.tool, postMessage bridge)? Cite it. (2) How is a widget authored by the agent today (which tool, what payload, srcdoc vs jsx vs library template)? (3) What is the exact GAP to build an editable plan widget that round-trips edited content + Submit/Reject back to the job agent and updates in place (E3 widget updates)? Name files/functions to touch.` },

  { key: 'control-plane', title: 'Control plane, surfaces, state, persistence (J-split, integration)', prompt: `Map the CONTROL PLANE + SURFACE MODEL + STATE/PERSISTENCE — where a first-class Job/Task object and new entry points would integrate.
Read: src/main/osActions.ts (the control plane), src/main/os-tools.mjs (ENUMERATE the full tool registry makeOsTools exposes), src/renderer/src/store.ts (the surface descriptor shape, zustand state, actions), src/main/workspace.mjs + workspace-host.mjs (persistence, workspace.json schema, the isRuntime predicates, parkOffstage / placement), and the stage/canvas placement (stage-core.mjs / stages-core.mjs if present).
Map: the surface kinds and descriptor fields; the complete os-tools registry (one line each); what persists in workspace.json vs runtime-only surfaces; how surfaces are placed on the canvas/stage. State plainly: is there ANY existing notion of a "job" or "task" work-unit in state? Where would a first-class Job/Task object live (store + persistence + os-tools), and what fields/lifecycle would it need to support the J-split (Job=plan+exec, Task=no-plan)?` },

  { key: 'entrypoints', title: 'Entry points: agent-socket, browser, HUD, menubar (A, B, A5)', prompt: `Map the ENTRY POINTS for Phase 2 A (macOS helper) and B (BlitzOS HUD), plus the menubar (A5).
Read: src/main/agentSocket.ts (relay paste URL, tool binding), src/main/control-server.ts (localhost HTTP control API), src/main/webcontents-view-host.ts (browser surfaces), src/renderer/src/components/Sidebar.tsx (the rail), src/renderer/src/App.tsx (keybinds, titlebar, modes, any HUD), and the agent-socket Chrome extension — check BOTH the repo (vendor/agent-socket-sdk) AND ~/agent-socket (i.e. /Users/minjunes/agent-socket) on disk for the extension source. Also search for Electron Tray / Notification usage (menubar).
ANSWER: (1) What exists today to TRIGGER a job from outside BlitzOS (the local control server? agent-socket?)? (2) Does the agent-socket Chrome extension support an "add this tab to context" action, or only "connect this tab"? What would A3 need? (3) Is there any keybind-toggled HUD / global hotkey / overlay in the app today, or is the rail purely the Sidebar? What would B2 (new HUD interface) build on? (4) Is there any macOS menubar (Tray) presence for A5? Name hook points for the macOS helper window and the HUD launcher.` },

  { key: 'job-task-model', title: 'Job/Task work-unit model + plan.md lifecycle (J-split core)', prompt: `Map the WORK-UNIT model — the foundation for formalizing Job vs Task.
Read: src/main/onboarding.ts (interview.json + plan.md / initiative.md state, the interview->resident handoff), src/main/agent-runtime.mjs (boot-task duty, how a standing task is represented), plans/blitzos-agent-autonomy-guardrails.md (the plan.md status convention: proposed/approved/incomplete/blocked + stage status + spin-guard), and grep the codebase for any "job"/"task" work-unit modeling (terms: job, task, plan.md, initiative, status, stage).
ANSWER: (1) Does anything today model a unit of work with a lifecycle (proposed -> approved -> running -> done)? The closest is plan.md / the interview->initiative handoff — describe it precisely with file:line. (2) How is "the agent's standing duty" represented and injected (boot-task seam)? (3) For the J-split, what would a first-class Job/Task object need (fields, lifecycle states, persistence, link to its agent + plan widget + chat widget), and how does Task=no-planning differ structurally from Job=plan+exec? This must be detailed enough to spec.` },

  { key: 'notifications', title: 'Notification / status fabric (N, A5, E3)', prompt: `Map the NOTIFICATION + STATUS fabric (cross-cutting [N], A5 menubar, E3 widget updates).
Read: src/main/workspace-host.mjs (setChatStatus, noteAgentActivity), src/main/index.ts + the journal/crash path (the trigger:'system' crash announce to the human + agent), src/main/perception-core.mjs (the 'message'/'system'/'action' moment triggers, emitUserMessage), src/main/os-tools.mjs (the say tool), and search for Electron Notification / Tray / nativeNotification usage.
ANSWER: (1) How does status reach the USER today (chat lines via say? system moments? anything native)? Cite file:line. (2) Is there ANY native OS notification or menubar/Tray surface? (3) For [N], A5 (menubar status), and E3 (job updates in a widget AND chat), what's the concrete gap and where would each hook in? Distinguish agent-facing perception (moments to the agent) from human-facing notification (UI/native to the user).` },
]

phase('Map')
log(`Mapping ${READERS.length} BlitzOS subsystems against the desired user journey (Opus 4.8 readers)`)

const findings = await parallel(READERS.map((r) => () =>
  agent(`${JOURNEY}\n\n${COMMON}\n\nYOUR SUBSYSTEM: ${r.title}\n\n${r.prompt}`, {
    label: r.key,
    phase: 'Map',
    schema: READER_SCHEMA,
  })
))

const out = findings.map((f, i) => (f ? { reader: READERS[i].key, ...f } : { reader: READERS[i].key, failed: true }))
const ok = out.filter((f) => !f.failed).length
log(`Map complete: ${ok}/${READERS.length} readers returned structured findings`)
return { readers: READERS.map((r) => r.key), findings: out }