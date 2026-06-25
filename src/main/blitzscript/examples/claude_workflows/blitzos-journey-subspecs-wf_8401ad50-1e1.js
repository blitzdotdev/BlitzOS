export const meta = {
  name: 'blitzos-journey-subspecs',
  description: 'Author the 4 linked BlitzOS refactor sub-specs from the verified map',
  phases: [
    { title: 'Spec', detail: '4 Opus writers author the linked refactor sub-spec docs' },
  ],
}

const PLANS = '/Users/minjunes/superapp/teenybase/agent-os/plans'
const MAP = '/tmp/map'

const SHARED = `
You are authoring ONE plan/spec document for the BlitzOS user-journey refactor. The verified research (8 subsystem readers, file:line-cited) lives as JSON at ${MAP}/<reader>.json — READ the ones named for your doc, and VERIFY any line reference you cite by opening the actual source file (the research has occasional minor line drift, e.g. diffCanvasOps is at osActions.ts:663 not :662). Do NOT write any code; write only your one spec document. Do NOT edit any other file.

THE DESIRED JOURNEY (for context): Onboarding -> Job/Task setup (two entry points A macOS-helper + B in-app-HUD) -> Planning (Job only) -> Execution. Build items: W1 = editable plan widget + authoring prompt; W2 = tick->diff->steer heartbeat.

DECISIONS ALREADY MADE (state them, do not relitigate):
- Option A for W2: BlitzOS only ticks + diffs + emits the diff as a perception moment; the AGENT owns all steering judgment. ZERO per-task / stuck / threshold heuristics in the OS (CLAUDE.md doctrine: perception is content-agnostic, the agent is swappable policy).
- A/B simplification: A and B share ONE Raycast-like input component with TWO shells (a global non-activating NSPanel for A, an in-app keybind HUD for B); same affordances (text prompt + drag-drop files/folders + add-browser-window + Send).

THE CENTRAL FINDING (the spine of the whole refactor): there is NO first-class Job/Task work-unit object anywhere in BlitzOS today — agents are uniform peers. This object is the linchpin; B3 job-framing, the J-split, W1's widget binding, W2's steering target, E1's continuation arming, and the A4 Send payload all depend on it. It is specced in plans/blitzos-job-task-model.md (the spine). Your doc must build on / link to it, not redefine it.

HOUSE STYLE (match the existing blitzos plan docs): start with '# BlitzOS — <Title>' then a 'Status: SPEC FOR REVIEW (no code written). ...' line; dense, concrete prose; '##' sections; EVERY capability claim anchored with file:line and a short quote; a 'Current state (verified)' section, a 'What to build' section, a 'Sequencing' list, a 'Risks' list, an 'Open decisions' list, and a 'Cross-references' list. Be concise and high-density (no padding), but complete enough to drive a concrete implementation. IMPORTANT PROSE RULE: do NOT use em dashes anywhere; use commas, colons, or parentheses instead. Any change that touches CORE state/persistence or adds an architectural primitive must be written as a DECISION THAT NEEDS USER SIGN-OFF (per CLAUDE.md: ask before structural/architectural core changes), not as a settled prescription.

SIBLING DOCS (cross-link by these exact paths; some are being written concurrently, some already exist):
- plans/blitzos-user-journey.md (the index; exists)
- plans/blitzos-job-task-model.md (the spine: the Job/Task WorkUnit)
- plans/blitzos-plan-widget.md (W1 editable plan widget + E3 job-status widget)
- plans/blitzos-tick-diff-steer.md (W2 supervisor heartbeat)
- plans/blitzos-job-entrypoints.md (Phase 2 A/B entry points + A5 menubar + [N] notifications)
- plans/blitzos-agent-autonomy-guardrails.md (exists; owns the E1 continuation engine AND the agent's Phase-1 plan-authoring DUTY)
- plans/onboarding-case-file.md (exists; Phase 1 onboarding)
`

const WRITERS = [
  {
    key: 'job-task-model',
    file: `${PLANS}/blitzos-job-task-model.md`,
    prompt: `Write plans/blitzos-job-task-model.md — the SPINE of the refactor: the first-class Job/Task work-unit ("WorkUnit") almost everything else depends on.
READ: ${MAP}/job-task-model.json, ${MAP}/control-plane.json, ${MAP}/agent-runtime.json. VERIFY refs in the real sources: terminal-manager.mjs (the per-agent meta.json), onboarding.ts (interview.json state machine + watchInterviewDone + the two boot-task duty strings), agent-runtime.mjs (setBootTaskProvider / prepareAgentLaunch re-read per launch / buildBootstrap duty fragment), index.ts:654 (the provider wiring), osActions.ts (osSpawnAgent), workspace-host.mjs (addAgent), os-tools.mjs (spawn_agent takes only {title}), types.ts (Surface.agentId join field).
SPEC: (1) the WorkUnit record + its lifecycle (proposed -> approved -> running -> done/blocked), generalizing the binary interview.json machine. (2) Job vs Task: a Job arms Planning (Phase 3 plan widget) + the E1 continuation engine; a Task skips planning and runs an act-now duty (today's RESIDENT_INITIATIVE_BOOT_TASK is essentially the Task duty). The ONLY structural difference is which boot-task duty string is injected and whether the plan-gated continuation is armed. (3) Persistence: present BOTH Option 1 (lighter: extend the existing agent meta.json with workMode/workStatus/goal/planSurfaceId, 1:1 agent:work-unit) and Option 2 (heavier: a dedicated .blitzos/work/<id>.json with agentIds[], decoupled, needed for v2 multi-agent jobs); recommend one and FLAG it as needing sign-off (it touches core persistence). (4) Duty-selection-by-mode through the existing setBootTaskProvider seam (generalize the id==='0' special-case to map agentId -> WorkUnit -> duty by mode+status). (5) Status-transition tools (e.g. set_work_status / propose_plan) added to the single os-tools registry, so BlitzOS — not only the agent — can react (fire handoffs, arm/disarm continuation, surface status). (6) The WorkUnit<->surfaces join (agentId, planSurfaceId, chatSurfaceId). Cover B3-as-job-wrapper and J-agents semantics (multi-peer spawn is already built; the missing part is the Job/Task role + supervisor relationship). Note where W1/W2/E1 plug in but LINK to their docs instead of speccing them. Flag the three-serializer footgun and the isRuntime-parity guard as risks.`,
  },
  {
    key: 'plan-widget',
    file: `${PLANS}/blitzos-plan-widget.md`,
    prompt: `Write plans/blitzos-plan-widget.md — W1 (the interactive, user-editable plan widget with Submit/Reject) plus E3's job-status widget half.
READ: ${MAP}/widgets.json (primary), ${MAP}/job-task-model.json (the WorkUnit/agentId binding), and SKIM plans/blitzos-agent-autonomy-guardrails.md (its Phase 1 owns the agent's plan-AUTHORING DUTY and the plan.md status convention; THIS doc owns the WIDGET mechanics + return loop — cross-link, do not duplicate). VERIFY refs: SurfaceFrame.tsx (blitz:props live update :592-596; setprops :577), widget-bridge.ts (sendMessage :73, setProps :77), App.tsx:1598-1600 (the __blitz:'action' channel AND its 4000-byte cap), os-tools.mjs (update_surface, get_surface returns props, spawn_widget/save_widget), widget-ui-kit.ts (<blitz-input>/<blitz-button> :94-110), widget-catalog.mjs (WIDGET_AUTHORING_MD), widgets/remix.html (proven round-trip), widget-jsx.ts (jsx compile + props.lastError).
KEY FINDING to build on: the widget->agent CALLBACK plumbing ALREADY EXISTS in three forms (blitz.sendMessage -> trigger:'message'; __blitz:'action' -> trigger:'action', capped 4000B; blitz.setProps for own-state) and the agent->widget update-in-place direction is FULLY built. So W1 is "build the widget + prompt + return-loop on existing channels," not from zero.
SPEC: (1) the plan widget itself (recommend jsx: controlled inputs for inline-editable stages, per-decision toggles, reorder/remove a stage, a free-form comments box, Submit/Reject). (2) The RETURN CHANNEL — the one real decision: recommend the two-step (widget blitz.setProps({edited, comments, decision}) then a tiny blitz.sendMessage('plan submitted') so the agent reads the full edited plan via get_surface{id} and reconciles into plan.md), which sidesteps the 4000-byte cap and reuses everything; present the alternative (raise the App.tsx:1600 cap for a one-shot __blitz:'action' submit — a 1-line CORE edit, flag for sign-off). (3) optional new kit elements <blitz-edit>/<blitz-toggle> so "BlitzOS supplies generic interaction patterns" is literally true. (4) the authoring PROMPT: extend WIDGET_AUTHORING_MD with the editable-plan idiom + the chosen return channel (the __blitz:'action' channel is currently UNDOCUMENTED), wired via the job agent's boot-task duty (link job-task-model + autonomy-guardrails). (5) E3: the SAME widget morphs editable-plan -> live status on approval, driven by update_surface{props}; tie it to the job's agentId. Risks: the 4000B cap, props.lastError lands silently (agent must get_surface after each update), the widget->agent moment is PRIVATE per agentId (a plan widget for job agent N must sendMessage with N's id).`,
  },
  {
    key: 'tick-diff-steer',
    file: `${PLANS}/blitzos-tick-diff-steer.md`,
    prompt: `Write plans/blitzos-tick-diff-steer.md — W2 (Phase 4 E2): the tick -> diff -> steer supervisor heartbeat, Option A.
READ: ${MAP}/perception.json (primary), ${MAP}/agent-runtime.json (the steering-delivery seam), ${MAP}/job-task-model.json (what "on-plan" means once a WorkUnit exists). VERIFY refs: perception-core.mjs (the setWorkspaceProvider :41 / setMomentTap :166 registration pattern to mirror; visibleTo :52-60; emitUserMessage :341; the 2s sweepTimer :294; BATCH_MS :16; redactMoment :83; the materiality rule "if (!p.hasUser) return" :213), osActions.ts (diffCanvasOps — CONFIRM it is :663, plus consumeEcho/canvasBulkAt echo+bulk suppression), workspace-host.mjs (setChatStatus :462 / noteAgentActivity :480 writers; the chatStatus reader :472 is NOT exported on the public API; the chat status folded into os:state props :550), os-tools.mjs (/events :560, /say :576).
KEY FINDINGS to build on: REUSE the /events wake channel (do not build a second loop); supervisor='0' routing is ALREADY FREE (a trigger:'tick' moment with no agentId falls through visibleTo to '0'); steering delivery (emitUserMessage) is FULLY built end-to-end. The agent-facing serializer STRIPS props (os-tools.mjs:106), so the tick payload must ride the moment's diff field (the /events stream), not list_state.
SPEC the NEW pieces: (1) emitTick() near flushCanvas + a setTickSource(fn) registration seam (perception-core CANNOT import osActions — layering; mirror setWorkspaceProvider). (2) The diff payload {agentStatus map, terminals (status/exitCode), surface open/close + offstage/onstage deltas} computed vs a module-level lastTickSnapshot, with an EMPTY-DIFF EARLY-RETURN that is load-bearing (mirror "if(!p.hasUser) return" so a quiet desktop never spams wakes). (3) materiality rules (which agent-status transitions are material: working->waiting/stopped/error yes, working->working no), kept content-agnostic. (4) cadence (a TICK_MS riding the existing 2s sweep sub-gated, vs a dedicated interval like the two 60s heartbeats). (5) a host-side chatStatus/chatStatusSnapshot accessor to add to the workspace-host public API. (6) a redactMoment branch so a pure-metadata tick crosses the relay intact. (7) the steer call-site: reuse /say{agent:'N'} or add a sibling /steer tool — both land on emitUserMessage. (8) echo/bulk suppression so the supervisor does not diff itself reacting to its own steer (mirror diffCanvasOps consumeEcho/canvasBulkAt). State the Option A boundary explicitly: BlitzOS emits the diff; the supervisor agent ('0' today) decides. Note W2 can ship DECOUPLED from W1 (status-diff alone is enough to wake the supervisor; plan-awareness is an enrichment). Risks: layering, spam, self-reaction, workspace scoping (free via emit() stamp), props-stripped serializer.`,
  },
  {
    key: 'job-entrypoints',
    file: `${PLANS}/blitzos-job-entrypoints.md`,
    prompt: `Write plans/blitzos-job-entrypoints.md — Phase 2 entry points (A macOS helper + B in-app HUD) and the outward status surfaces (A5 menubar + [N] native notifications + dock badge).
READ: ${MAP}/entrypoints.json (primary), ${MAP}/notifications.json (A5/[N]), ${MAP}/control-plane.json (A2 ingest). VERIFY refs: onboarding.ts:230-264 (the dragHelper NSPanel: type:'panel', frameless, transparent, focusable:false, setAlwaysOnTop('floating'), setVisibleOnAllWorkspaces, showInactive — the A1/B2 window pattern), control-server.ts (localhost bearer ingress; note server.listen(0) binds an EPHEMERAL port — the A3 discovery problem; /user_say is localhost-only), agentSocket.ts (relay paste URL), App.tsx (the .hud is ONLY the Connect-AI modal :2537; os:keybind route; onDrop/ingestPaths), Sidebar.tsx (the rail is an icon dock, not an input HUD), index.ts (app.whenReady; NO Tray, NO globalShortcut imported), osActions.ts (osIngestPaths -> ingestPaths copies-only; osSay/emitUserMessage :799-819), workspace-host.mjs (setChatStatus/noteAgentActivity feed A5), action-items.mjs (inbox count), and /Users/minjunes/agent-socket/chrome-extension/{popup.html,popup.js,background.js,manifest.json} (the extension has ZERO BlitzOS awareness; it only mints its OWN relay session).
STATE the decision: A and B share ONE Raycast-like input component with TWO shells (global non-activating NSPanel for A; in-app keybind HUD for B); same affordances.
SPEC: (1) the shared input component + the NSPanel shell (clone the onboarding dragHelper) + a NEW electron globalShortcut (unused today) for the toggle; note B2 over a focused BlitzOS could use the existing os:keybind route, but a backgrounded A1 needs globalShortcut + its own NSPanel (the two converge). (2) the A4 Send job-kickoff IPC that composes EXISTING primitives in order: osSpawnAgent (with the new Job/Task mode from job-task-model.md) -> osIngestPaths for dropped files -> osCreateSurface{kind:'web'} per added tab -> osSay/emitUserMessage to deliver the prompt; this is glue, no new wake/delivery mechanism. (3) A2: extend ingestPaths (copyDroppedEntry) with a symlink|copy/mirror mode flag + a job/context association (today it always copies into the active workspace, no context bucket). (4) A3: the Chrome-extension add-to-context, whose hard part is DISCOVERY (a sandboxed extension cannot read ~/.blitzos/session.json and control-server binds an ephemeral port): present options (a fixed-port localhost handshake / a relay-advertised context session / the simpler reframe where the extension just hands BlitzOS a URL to OPEN+read the already-logged-in tab) and recommend the reframe; the extension side needs a new "Add to BlitzOS" button beside "Connect this tab". (5) Outward surfaces: A5 Electron Tray (+ feed from the existing chat-status fabric + action-items), [N] a notify.ts Electron Notification wrapper, and a cheap dock-badge (app.setBadgeCount) first slice — all driven by a content-agnostic WHITELIST of high-signal transitions (crash, agent error, job done, action-needed), never routine working/watching churn, with a foreground/quiet guard (mirror the perception "content-only churn does not wake" rule). Everything here depends on the Job/Task object for the Send payload + context association — link job-task-model.md. Risks: focus theft (the dragHelper proves the non-activating recipe), the ephemeral-port discovery gap, macOS notification permission in the signed build, and the sandwich parented-window focus on notification click.`,
  },
]

phase('Spec')
log(`Authoring ${WRITERS.length} linked refactor sub-specs (Opus 4.8 writers)`)

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'title', 'status', 'summary', 'crossLinks', 'decisionsToFlag'],
  properties: {
    path: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    summary: { type: 'string', description: '3-5 sentences: what the doc specs + the core build sequence' },
    crossLinks: { type: 'array', items: { type: 'string' } },
    decisionsToFlag: { type: 'array', items: { type: 'string', description: 'core/persistence/architectural decisions needing user sign-off' } },
    approxLines: { type: 'number' },
  },
}

const results = await parallel(WRITERS.map((w) => () =>
  agent(`${SHARED}\n\nYOUR DOC: write it to ${w.file}\n\n${w.prompt}\n\nWhen done, return the schema. Write the file with the Write tool; the 'path' you return must be ${w.file}.`, {
    label: w.key,
    phase: 'Spec',
    schema: SPEC_SCHEMA,
  })
))

const out = results.map((r, i) => (r ? r : { path: WRITERS[i].file, failed: true, key: WRITERS[i].key }))
log(`Spec phase done: ${out.filter((r) => !r.failed).length}/${WRITERS.length} docs authored`)
return { docs: out }