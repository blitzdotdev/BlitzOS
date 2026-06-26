export const meta = {
  name: 'blitzos-journey-audit',
  description: 'Audit current BlitzOS code vs the desired new-user journey; author refactor specs and update the journey doc',
  phases: [
    { title: 'Discover', detail: '10 parallel read-only subsystem maps' },
    { title: 'Synthesize', detail: 'canonical built-vs-todo + doc split + corrections' },
    { title: 'Author', detail: 'write 3 refactor specs + rewrite the journey doc concise' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'

const JOURNEY = `BlitzOS desired NEW-USER JOURNEY (the north star to map current code against):
(1) ONBOARDING: spawn BlitzOS; scrape local laptop and (the board says) API integrations Drive/Gmail/GitHub (NOTE: the OAuth/integrations subsystem was REMOVED 2026-06-16, auth is now browser-first, so flag this tension, do not assume integrations exist); summarize user life; build a user profile plus an index of pointers to info.
(2) JOB/TASK SETUP, two entry points to START a job or a task:
   A) a macOS Raycast-like "helper" window (search-bar / dynamic-island, OUTSIDE BlitzOS): drag and drop files/folders into the job context (symlink vs copy/mirror), add OPEN browser windows into context by clicking "add" inside the window (brokered by an auto-installed ~/agent-socket Chrome extension that talks to BlitzOS), hit SEND to kick off a job; an optional Mac menubar widget shows status.
   B) talk to BlitzOS directly through a NEW in-app interface (NOT today's canvas chat widget): a built-in Electron HUD on the rail (keybind show/hide, NOT on the canvas); BlitzOS spawns a job agent on the canvas plus a dedicated chat widget.
   Orthogonal to A/B: JOB (gets Planning) vs TASK (no planning, act directly: look user context, create widgets, create connections).
(3) PLANNING (Job path only): the job agent authors an INTERACTIVE, user-EDITABLE plan widget with Submit/Reject; user edits in place, AI reconciles, on approve go to Execution (reject loops back).
(4) EXECUTION: /goal-style continuation on the approved plan; a TICK / heartbeat wakes BlitzOS every N seconds, diffs the BlitzOS state (surfaces plus agents plus task/terminal progress), and emits the diff as PERCEPTION so a SUPERVISOR agent decides whether to steer a running job/task agent. DECISION already made: Option A, BlitzOS supplies perception, wake, and the diff; the AGENT owns the steering judgment, with NO per-task heuristics baked into the OS. The job agent reports updates in its chat plus a widget.`

const pre = (area, files, searches, extra) => `Repo root: ${ROOT}. You are mapping the CURRENT, ACTUAL state of ONE BlitzOS subsystem: ${area}.

${JOURNEY}

Your job: read the REAL code and report what EXISTS today in this subsystem, precisely, so we can write a concrete refactor spec. Do NOT propose designs. Do NOT edit files. Ground every claim in code you actually read.

Focus files (Read these fully, follow imports, do not settle for excerpts): ${files}
Also grep for these identifiers: ${searches}
${extra ? '\nSPECIAL FOCUS: ' + extra + '\n' : ''}
Return STRUCTURED MARKDOWN with EXACTLY these sections:
## ${area}
**Overview** (2-3 lines: what this subsystem does today)
**Key files** (path:line, the real entry points)
**BUILT** (bullets, each with file:line evidence and a <=15-word description)
**PARTIAL** (bullets, what half-exists and precisely what is missing inside it, file:line)
**MISSING / TODO** (bullets, things the journey needs that are ABSENT here; if a concept like a first-class "Job/Task" object or "steer" simply does not exist, say so plainly)
**Seams for the journey** (where new code would attach: name the function and file:line and the hook)
**Constraints / gotchas** (load-bearing facts a spec author must not violate; quote short real snippets)

Be exhaustive within this subsystem, concise per line. Quote real identifiers and exact line numbers. If uncertain write [unverified], never guess a line number. No em dashes anywhere (use colons, commas, parentheses, or the word 'to').`

const DISCOVER = [
  { key: 'control-plane', label: 'map:control-plane', prompt: pre(
    'the control plane and the shared tool registry (the agent syscalls), across all three transports',
    'src/main/osActions.ts, src/main/os-tools.mjs, src/main/electron-os-tools.ts, src/main/control-server.ts, src/main/agentSocket.ts, src/preload/index.ts, preview/backend.mjs',
    'makeOsTools, electronOps, serverOps, create_surface, open_window, spawn_agent, place_widget, new_app, say, os:action, os:state, osControlSurface',
    'Enumerate EVERY tool in makeOsTools with a one-line contract. Note which tools exist for surfaces vs widgets vs agents vs workspace. This is the syscall surface every journey feature will use.') },
  { key: 'surfaces-browser', label: 'map:surfaces-browser', prompt: pre(
    'the surface model and real browser surfaces (web/app/srcdoc/native), downloads, popups',
    'src/renderer/src/components/SurfaceFrame.tsx, src/renderer/src/components/BrowserNav.tsx, src/main/webcontents-view-host.ts, src/main/guest-capabilities.ts, src/main/popup-policy.mjs',
    'WebContentsView, did-attach-webview, will-download, download, onOpenTab, persist:agentos, kind, weblink, tabs',
    'For journey A3 (add an open browser window to a job context) and downloads to a workspace folder: how does a web surface embed, how are downloads streamed to the workspace, and how would an external browser tab map into a BlitzOS surface or context.') },
  { key: 'widgets', label: 'map:widgets', prompt: pre(
    'the widget system (library widgets, srcdoc/jsx, the blitz.tool subset, how widgets render and call back)',
    'widgets/widgets.json, src/main/widget-tools.mjs, src/renderer/src/components/NoteWidget.tsx, plans/jsx-widgets.md',
    'makeWidgetToolHandlers, blitz.tool, customize_widget, new_app, srcdoc, postMessage, widget, manifest',
    'For W1 (an interactive user-editable plan widget with Submit/Reject) and E3 (a job-status widget): how is a widget authored and registered, how does a sandboxed widget send data BACK to the agent/OS (the blitz.tool / postMessage channel), and what interactive primitives exist today.') },
  { key: 'agent-runtime', label: 'map:agent-runtime', prompt: pre(
    'the agent runtime: spawning agents/terminals, backends, the bootstrap and boot-task duty seam, agent 0 vs spawned agents, session persistence and resume',
    'src/main/agent-runtime.mjs, src/main/terminal-manager.mjs, src/main/index.ts, src/main/os-tools.mjs',
    'setBootTaskProvider, getBootTask, prepareAgentLaunch, buildBootstrap, spawnAgent, spawnTerminal, osKickBrain, launchAgent, backend, claude, codex, resume, session',
    'For entry point B (spawn a job agent and place a dedicated chat widget) and for the Job/Task model: exactly how an agent is spawned and placed, what identifies agent 0, how the boot-task duty string is injected and re-read, and whether multiple concurrent job agents are supported today.') },
  { key: 'perception', label: 'map:perception', prompt: pre(
    'the perception to moments to wake loop (sensors, coalescer, /events long-poll, moment shape, cadence, visibility, the canvas-geometry diff, the per-agent message seam)',
    'src/main/perception-core.mjs (READ FULLY), src/main/osActions.ts (INJECT, the drain, diffCanvasOps), src/main/os-tools.mjs (the /events tool)',
    'INJECT, waitForEvents, ingestSignals, flush, BATCH_MS, CANVAS_SETTLE_MS, sweepTimer, emitUserMessage, visibleTo, diffCanvasOps, trigger, moment, setChatStatus, noteAgentActivity',
    'This is the loop W2 (tick to diff to steer) MUST extend. Be exact about: every cadence constant with its value and line; the full moment object shape; the precise function to call to EMIT a moment into the stream; how an agent is woken (pull long-poll); the visibleTo routing (who sees which triggers); the per-agent private message moment path (emitUserMessage) since steering delivery will reuse it; and state PLAINLY whether ANY periodic diff of AGENT or TASK state exists today (it likely does not).') },
  { key: 'onboarding', label: 'map:onboarding', prompt: pre(
    'onboarding (the Case File flow): the scan, the profile, the board seed, the interview, the artifacts, FDA/unlock, the boot-task wiring',
    'src/main/onboarding.ts, src/main/onboarding-board.mjs, scripts/onboarding-scan.mjs, src/main/blitzos-interview.md, plans/onboarding-case-file.md',
    'interviewBootTask, RESIDENT_INITIATIVE_BOOT_TASK, scan.json, context.md, board.json, profile.md, interview.json, mdfind, integration, FDA, TCC, unlock, web',
    'Map O2 Data Scraping PRECISELY: what sources are actually scanned (local files, Calendar, AddressBook, web detection) and what "integration" means in the scan output. Confirm whether ANY real API integration (Drive/Gmail/GitHub) exists vs browser-first. Map O5 "index of pointers to info" to the real artifacts (board.json, context.md, scan.json). Map O3/O4 to context.md/profile.md.') },
  { key: 'agent-socket-extension', label: 'map:agent-socket-ext', prompt: pre(
    'the agent-socket integration and the Chrome extension (how a browser tab connects to an agent, the relay, the SDK, and whether any auto-install exists)',
    'src/main/agentSocket.ts, vendor/agent-socket-sdk/package.json, vendor/agent-socket-sdk (dist), and the skill at skills/ matching agent-socket-connect; ALSO check OUTSIDE the repo: run `ls -la ~/agent-socket` and if it exists read its README and any manifest.json / src that defines the Chrome extension',
    'agentsocket, Connect this tab, session URL, relay, AGENT_SOCKET_RELAY, manifest, extension, content script, background',
    'Journey entry point A claims an "auto-installed ~/agent-socket Chrome extension" that lets the user click "add" in a browser window to add it to a job context. Determine, grounded in real files: (a) does the extension exist and what does it do TODAY (the current flow is connecting a tab so an agent can DRIVE it), (b) is there ANY auto-install mechanism today, (c) what would "add THIS window to the current job context" require beyond what exists. Look both in the repo and at ~/agent-socket.') },
  { key: 'state-persistence', label: 'map:state-persistence', prompt: pre(
    'state and persistence: the .blitzos journal, the workspace.json schema, what persists per surface and per agent, hydrate/rehydrate, cross-workspace addressing, the kernel fault model',
    'src/main/workspace.mjs, src/renderer/src/store.ts',
    'workspace.json, state.json, .blitzos, hydrate, persist, nodes, stageFields, isRuntime, findSurfaceWorkspace, relocateSurface, markClean, heartbeat, lastClean',
    'For a NEW first-class Job/Task object we must know: the exact persisted node/surface schema, what fields are saved vs runtime-only, how an agent identity persists across restart, the 60s heartbeat/journal, and the best place a job/task lifecycle RECORD could live (a new file under .blitzos, or a node, or workspace.json field).') },
  { key: 'navigation-hud-chrome', label: 'map:nav-hud-chrome', prompt: pre(
    'navigation modes and the app shell/HUD: the rail/dock (Sidebar), the titlebar, the sandwich compositor, the CURRENT chat widget, keybinds, and where a NEW HUD launcher (entry point B) would live',
    'src/renderer/src/store.ts, src/renderer/src/App.tsx, src/renderer/src/components/Sidebar.tsx, src/renderer/src/components/PrimarySpace.tsx, src/main/sandwich.ts',
    'mode, desktop, canvas, locked, titlebar, shell-drag, Sidebar, dock, rail, chat, keybind, Shift, consent-card, HUD, globalShortcut',
    'Entry point B is a NEW keybind-toggled HUD on the rail, NOT the canvas and NOT today chat widget. Map: how the CURRENT chat widget works and where it lives, what the Sidebar/rail is and how it renders, how global keybinds/shortcuts are registered (renderer key handlers vs Electron globalShortcut), and the precise seam where a HUD overlay (part of the L1 UI window, above the canvas) would attach.') },
  { key: 'autonomy-goal', label: 'map:autonomy-goal', prompt: pre(
    'the autonomy/continuation layer: the served agent doctrine, the bootstrap fragments (wait.sh / waitLoop), /goal, the plan.md-gated continuation engine, and how E1 (/goal on plan) is meant to work',
    'plans/blitzos-agent-autonomy-guardrails.md, src/main/agent-runtime.mjs (buildBootstrap, the waitLoop/keepChecking fragments, wait.sh), src/main/blitzos-interview.md, and find and read the served doctrine file blitzos-agents.md',
    'wait.sh, waitLoop, keepChecking, /goal, Stop hook, RESIDENT_INITIATIVE, autonomy loop, run_in_background, plan.md, permission-mode',
    'Cross-check W1 and E1. For W1: the autonomy-guardrails Phase 1 specs an editable plan widget, summarize EXACTLY what it specs and whether ANY of it is built. For E1: the continuation engine (its Phase 2), what is DONE (wait.sh backgrounded 2026-06-16) vs what is TODO (the plan.md-gated Stop hook, the stage-status convention, the spin-guard). Quote the served doctrine lines that make the agent default-quiet/reactive.') },
]

phase('Discover')
log('Mapping 10 BlitzOS subsystems against the desired user journey (read-only)')
const reports = await parallel(DISCOVER.map((d) => () => agent(d.prompt, { label: d.label, phase: 'Discover', agentType: 'Explore' })))

phase('Synthesize')
log('Synthesizing the canonical built-vs-todo, the doc split, and corrections')
const reportBlob = DISCOVER.map((d, i) => `### REPORT [${d.key}]\n${reports[i] || '(this map failed to return)'}`).join('\n\n---\n\n')

const synth = await agent(`You are the SYNTHESIS step of a BlitzOS audit. Below are 10 subsystem maps of the CURRENT code. Also Read the current draft doc at ${ROOT}/plans/blitzos-user-journey.md (it is a first-pass capture that may contain errors).

${JOURNEY}

THE 10 SUBSYSTEM MAPS:
${reportBlob}

Produce ONE coherent reference that 4 doc-writers will consume. Sections:

## 1. CANONICAL BUILT-vs-TODO
For EVERY journey item below assign a glyph (BUILT / PARTIAL / TODO), a <=20-word justification, and the single best file:line evidence. Items:
Onboarding: O1 spawn, O2a local scan, O2b API integrations, O3 summarize, O4 profile, O5 index-of-pointers.
Setup-A (macOS helper): A1 helper window, A2 drag/drop files, A3 add-browser-window via extension, A4 send to kick off, A5 menubar status.
Setup-B (HUD): B1 talk-direct, B2 new HUD on rail with keybind, B3 spawn job agent and place, B4 dedicated chat widget.
Job/Task: J-split (a Job vs Task object/routing), J-agents (concurrent multi-agent v2, the backends).
Planning: P1 show plan widget, P2 user edits, P3 AI updates, P4 the execute? gate, P5 go-to-execute.
Execution: E1 /goal-on-plan continuation, E2 tick to diff to steer, E3 updates in chat plus widget.
Cross: N notification fabric.

## 2. CROSS-CUTTING MISSING FOUNDATIONS
The net-new primitives the journey needs (a first-class Job/Task record, a supervisor relationship, a tick emitter, a status widget, the HUD launcher, the native helper app, the extension "add to context" action, the editable plan widget). For each: what it is, what it builds ON (file:line seam), its dependencies, and a rough build ordering.

## 3. DOC SPLIT (these filenames are LOCKED for cross-links)
For EACH doc below give a section-by-section OUTLINE, the key design decisions/forks, and the exact code seams (file:line) the spec must reference:
- plans/blitzos-job-task-model.md : the Job/Task first-class object, entry point B (HUD), Job-vs-Task routing.
- plans/blitzos-macos-helper.md : entry point A, the native helper, the agent-socket extension "add to context", drag/drop, send, menubar status.
- plans/blitzos-tick-diff-steer.md : W2, tick to state-diff (incl agents) to supervisor wake to steer, built on the perception loop, the Option A boundary.
Also decide: does W1 (the editable plan widget, Planning) need its OWN doc or is it adequately specced in plans/blitzos-agent-autonomy-guardrails.md Phase 1? Recommend clearly; if it needs its own doc name it plans/blitzos-plan-widget.md and outline it.

## 4. MAIN DOC CONCISION PLAN
For ${ROOT}/plans/blitzos-user-journey.md: what to KEEP (the ASCII board with corrected glyphs, the open-questions), what to MOVE OUT into the sub-plans, and the exact set of cross-links. It must stay a concise overview.

## 5. CORRECTIONS
Everything in the current draft doc that is WRONG vs the code (a status glyph, a file ref, the O2b framing, anything). One line per correction with the fix.

Ground every claim in the reports. Where reports conflict or are uncertain, say so explicitly. No em dashes anywhere (use colons, commas, parentheses, or 'to').`, { label: 'synthesize', phase: 'Synthesize', agentType: 'general-purpose' })

phase('Author')
log('Writing 3 refactor specs and rewriting the journey doc')

const map = {}
DISCOVER.forEach((d, i) => { map[d.key] = `### REPORT [${d.key}]\n${reports[i] || '(failed)'}` })
const pick = (keys) => keys.map((k) => map[k] || '').join('\n\n')

const writerRules = `RULES (hard):
- This is a CONCRETE REFACTOR SPEC, detailed enough to implement from. Structure: a Status line at top; a 1-paragraph intent; "## Current state" (with file:line refs, what exists vs what is absent); "## Target"; "## Refactor steps" (NUMBERED, each names the file and function to ADD or MODIFY and the data shape touched); "## Data shapes" (concrete TS-ish shapes); "## Open decisions"; "## Cross-references".
- Ground EVERY file:line reference in the provided reports OR verify it yourself with Read/Grep. NEVER invent a line number. If you cannot ground a claim, mark it [unverified].
- NO em dashes anywhere. Use colons, commas, parentheses, or the word 'to'. This is a hard user style rule.
- Match the house style of the existing docs in plans/ (dense, technical, terse bullets, heavily file-referenced).
- Thorough on substance, zero filler. Do not restate the whole journey, link to it.`

const writers = [
  {
    path: `${ROOT}/plans/blitzos-job-task-model.md`,
    label: 'write:job-task-model',
    scope: 'the Job/Task FIRST-CLASS object (its state shape, lifecycle states, where it persists, who owns it), entry point B (the in-app HUD launcher: a keybind-toggled overlay on the L1 rail, NOT the canvas chat widget), how B spawns a job agent and places it plus a dedicated chat widget by building on the existing spawnAgent / terminal-manager / widget / state seams, and the Job-vs-Task routing (Job goes to Planning, Task acts directly with no planning). Reference the macOS helper doc for entry point A (both entry points feed the SAME job pipeline you define here).',
    reports: ['control-plane', 'agent-runtime', 'state-persistence', 'navigation-hud-chrome', 'widgets', 'surfaces-browser'],
    links: 'plans/blitzos-user-journey.md (parent overview), plans/blitzos-macos-helper.md (entry point A), plans/blitzos-tick-diff-steer.md (execution autonomy), plans/blitzos-agent-autonomy-guardrails.md (planning + continuation)',
  },
  {
    path: `${ROOT}/plans/blitzos-macos-helper.md`,
    label: 'write:macos-helper',
    scope: 'entry point A: the native Raycast-like helper window (pick an architecture and justify it: a separate Developer-ID-signed native helper in the mold of BlitzComputerUse.app vs an extra Electron window, referencing the computer-use-helper precedent), the agent-socket Chrome extension flow as it exists today PLUS the new "add this browser window to the current job context" action and the auto-install question, drag and drop of files/folders into the job context (symlink vs copy/mirror), SEND to kick off a job into the SAME job pipeline defined in blitzos-job-task-model.md, and the optional Mac menubar status widget.',
    reports: ['agent-socket-extension', 'surfaces-browser', 'control-plane', 'navigation-hud-chrome', 'state-persistence'],
    links: 'plans/blitzos-user-journey.md (parent overview), plans/blitzos-job-task-model.md (the job pipeline both entry points feed), plans/blitzos-computer-use-helper.md (the native-helper precedent)',
  },
  {
    path: `${ROOT}/plans/blitzos-tick-diff-steer.md`,
    label: 'write:tick-diff-steer',
    scope: 'W2: the tick/heartbeat emitter (where it lives near the coalescer, its cadence, and a materiality threshold so a quiet desktop does not spam wakes), extending the state diff from canvas-geometry-only (diffCanvasOps) to ALSO cover agents plus task/terminal progress, emitting a new trigger:tick moment INTO the existing /events stream (name the emit function), the supervisor wake (agent 0 via visibleTo today, multi-agent v2 later), steering DELIVERY by REUSING the per-agent message-moment seam (emitUserMessage) rather than any new injection, the Option A boundary (BlitzOS supplies perception, wake, and the diff; the agent owns the steer judgment; no per-task heuristics in the OS), and a spin-guard. Tie E1 (/goal continuation) in by reference, do not respec it.',
    reports: ['perception', 'agent-runtime', 'control-plane', 'autonomy-goal', 'state-persistence'],
    links: 'plans/blitzos-user-journey.md (parent overview), plans/blitzos-job-task-model.md (what a job/task agent is), plans/blitzos-agent-autonomy-guardrails.md (the E1 continuation engine)',
  },
]

const authored = await parallel(writers.map((w) => () => agent(`You are the WRITER for ${w.path}.

${JOURNEY}

SYNTHESIS (the canonical built-vs-todo is section 1; YOUR doc outline and seams are in section 3; corrections in section 5):
${synth}

RAW SUBSYSTEM REPORTS relevant to your doc:
${pick(w.reports)}

${writerRules}

YOUR DOC SCOPE: ${w.scope}

Cross-link (use these exact relative paths) to: ${w.links}

Write the COMPLETE markdown refactor spec to ${w.path} using the Write tool (overwrite if it exists). Then return: the path, a 5-line summary of what the spec covers, and a bullet list of any [unverified] claims you had to make. Your returned text is data for the orchestrator, not a user message.`, { label: w.label, phase: 'Author', agentType: 'general-purpose' })))

const mainDoc = await agent(`You are the WRITER updating the MAIN overview doc ${ROOT}/plans/blitzos-user-journey.md.

${JOURNEY}

FIRST: Read the current ${ROOT}/plans/blitzos-user-journey.md.

SYNTHESIS (use section 1 for the corrected glyphs, section 4 for the concision plan, section 5 for corrections):
${synth}

Three detailed sub-plan specs now exist and must be linked: plans/blitzos-job-task-model.md, plans/blitzos-macos-helper.md, plans/blitzos-tick-diff-steer.md. The planning/continuation detail lives in plans/blitzos-agent-autonomy-guardrails.md.

REWRITE ${ROOT}/plans/blitzos-user-journey.md as a CONCISE overview (the user explicitly asked for concise):
- KEEP the ASCII board, but update EVERY status glyph to match synthesis section 1.
- KEEP a short phase-by-phase built-vs-todo: 1 to 2 lines per phase, each linking to the relevant sub-plan for the detail. Do NOT duplicate the detailed prose now living in the sub-plans, MOVE it out and link.
- KEEP the W2 overlap verdict table and the Option A decision (these are the load-bearing decisions), but tighten them.
- KEEP the open-questions list, applying synthesis section 5 corrections.
- ADD a "## Refactor specs" section linking the 3 sub-plans with a one-line scope each.
- Apply ALL corrections from synthesis section 5 (wrong glyphs, the O2b framing, any wrong file ref).
- NO em dashes anywhere (colons, commas, parentheses, or 'to'). Hard rule. Scrub any that exist in the current draft.

Write the full updated doc with the Write tool. Return: the path, a 5-line summary of the changes you made, and any corrections you applied from section 5.`, { label: 'write:main-doc', phase: 'Author', agentType: 'general-purpose' })

return { synthesis: synth, authored: authored.filter(Boolean), mainDoc }