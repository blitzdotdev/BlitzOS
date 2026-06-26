export const meta = {
  name: 'blitzos-single-canvas',
  description: 'Collapse BlitzOS multi-stage desktop to home-only (single-canvas navigation) per the plan, then verify',
  phases: [
    { title: 'Core API', detail: 'rewrite stages-core + stage-core to home-only' },
    { title: 'Consumers', detail: 'os-tools, workspace-host+workspace, onboarding, store' },
    { title: 'Renderer', detail: 'App, PrimarySpace, Sidebar, SurfaceFrame' },
    { title: 'Tests+Docs', detail: 'rewrite tests, fix CLAUDE.md/skill/plans/memory' },
    { title: 'Verify', detail: 'typecheck + build + node tests' },
    { title: 'Fix', detail: 'repair until green' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const PLAN = ROOT + '/plans/blitzos-single-canvas-navigation.md'

const rules = (owns) =>
  'Repo root: ' + ROOT + '. Obey ../CLAUDE.md AND agent-os/CLAUDE.md: NO hacks/shortcuts, handle every edge case (add a TODO comment if a case is genuinely deferred), match the surrounding code style and comment density, no em dashes in any prose you write. ' +
  'READ THE CONTRACT FIRST: ' + PLAN + ' (the "Contract" section is authoritative; read your file too). ' +
  'You may ONLY edit: ' + owns + '. Do not touch any other file. ' +
  'When you change a function signature, UPDATE EVERY CALL SITE in your owned file(s); never rely on JS ignoring extra positional args. ' +
  'After editing, grep your file(s) for leftover references to deleted/renamed symbols (stageForAgent, orderedStageRect, stageOfPoint, surfaceStage, splay, slotStage, stageCount, stageOrder, controlTransform, clampStagePan, bring_to_stage, send_backstage, primaryRect, stageSummary, STAGE_BUDGET, currentStage) and fix them. ' +
  'Return the structured result honestly: list any dangling reference you could NOT resolve within your file (cross-file is fine to report, not fix).'

const FILE = {
  type: 'object', additionalProperties: false, required: ['ok', 'summary'],
  properties: {
    ok: { type: 'boolean', description: 'true if all assigned edits were made cleanly' },
    summary: { type: 'string', description: 'concise list of what changed' },
    dangling: { type: 'array', items: { type: 'string' }, description: 'unresolved/cross-file references worth flagging' },
  },
}
const CORE = {
  type: 'object', additionalProperties: false, required: ['ok', 'stagesCoreExports', 'stageCoreExports', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    stagesCoreExports: { type: 'array', items: { type: 'string' }, description: 'final exported names from stages-core.mjs' },
    stageCoreExports: { type: 'array', items: { type: 'string' }, description: 'final exported names from stage-core.mjs' },
    summary: { type: 'string' },
  },
}
const VERIFY = {
  type: 'object', additionalProperties: false, required: ['pass', 'steps'],
  properties: {
    pass: { type: 'boolean', description: 'true ONLY if typecheck + build + the three pure node tests all passed' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'ok'], properties: { cmd: { type: 'string' }, ok: { type: 'boolean' }, tail: { type: 'string', description: 'last ~40 lines of output' } } } },
    failures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['area', 'error'], properties: { area: { type: 'string', description: 'file or area to fix' }, error: { type: 'string', description: 'the actual error text' } } } },
  },
}

// ---- Phase 1: Core API (single owner; the two files are tightly coupled) ----
phase('Core API')
const core = await agent(
  rules('src/renderer/src/stages-core.mjs AND src/renderer/src/stage-core.mjs') + '\n\n' +
  'TASK: implement the "Core" section of the contract exactly. stages-core: rename primaryRect->homeRect(vp), simplify parkBandRect(vp), keep DEFAULT_VP + chrome-inset consts + PARK_GAP, DELETE all stage/splay symbols and STAGE_GAP, rewrite the header comment to home-only. stage-core: import { homeRect, DEFAULT_VP }, drop stage/order/count params and all slotStage filters from latticeFor/occupancy/budgetUsed/findSlot/nearestFreeSlot/flowFiles, rename stageSummary->gridSummary(surfaces,vp) (drop its "stage" field), rename STAGE_BUDGET->HOME_BUDGET, keep TILE/CARD_INSET/SPANS/SIZE_ORDER/spanOf/sizePx/slotRect/cardRect/slotOf/sizeForDims. These are PURE files (zero deps) - keep them pure.',
  { label: 'core:stages+stage', phase: 'Core API', schema: CORE }
)
log('Core API exports — stages-core: ' + (core?.stagesCoreExports || []).join(', '))
log('Core API exports — stage-core: ' + (core?.stageCoreExports || []).join(', '))

// ---- Phase 2: Consumers (file-exclusive; barrier — Renderer depends on store) ----
phase('Consumers')
const consumers = await parallel([
  () => agent(
    rules('src/main/os-tools.mjs') + '\n\n' +
    'TASK: implement the os-tools.mjs bullet of the contract. Fix the two import lines to the new core exports (homeRect, parkBandRect, DEFAULT_VP, latticeFor, cardRect, findSlot, budgetUsed, gridSummary, sizeForDims, spanOf, HOME_BUDGET). Rename tool bring_to_stage->bring_home (path /bring_home) and send_backstage->send_offscreen (path /send_offscreen). DROP the agent param from place_widget/create_surface/open_window/open_terminal and delete every stageForAgent call. Rewrite isOffstage(s,vp) as "surface center outside homeRect(vp)". parkOffstage uses parkBandRect(vp). list_state must return ONLY the whitelist {surfaces, viewport, view, camera, mode, workspace, workspace_path, grid: gridSummary(...), offstage:[...]} — remove stage/stageCount/stageOrder/currentStage/currentStageRect (this kills a live agent-facing leak); rename the summary key stage->grid and backstage->offstage. Rename the stage_full error to home_full. Rewrite tool DESCRIPTIONS so agent-facing vocabulary is home/off-screen, never stage/backstage. go_to_primary description = "fly to home".',
    { label: 'consumer:os-tools', phase: 'Consumers', schema: FILE }
  ),
  () => agent(
    rules('src/main/workspace-host.mjs AND src/main/workspace.mjs') + '\n\n' +
    'TASK: implement the workspace-host.mjs and workspace.mjs bullets. host: delete maxAgentStageCount, growOrder, the stageCount self-heal at both hydrate and switch, and all currentStage/currentStageRect handling; setState + broadcasts drop stageCount/stageOrder; pin mode:"desktop" in blank() and every default (fix the mode:"canvas" default); imports drop stageForAgent/orderedStageRect, keep DEFAULT_VP. workspace.mjs: stageFields stops writing slotStage/slotArea/stageCount/stageOrder; ignore them on read (x/y stays the truth, NO slot migration); persisted mode defaults to "desktop". Old workspace.json files with the dropped fields must still load (extra fields ignored).',
    { label: 'consumer:host+workspace', phase: 'Consumers', schema: FILE }
  ),
  () => agent(
    rules('src/main/onboarding-board.mjs') + '\n\n' +
    'TASK: implement the onboarding-board.mjs bullet. Change the import from stages-core to use homeRect (not stageRect). Drop slotStage from every seeded card. Place every card on the SINGLE home lattice via latticeFor(vp)/findSlot with NO stage argument. Remove any per-agent stage placement logic. The board still saturates then the brain curates down — keep that behavior, just on home.',
    { label: 'consumer:onboarding', phase: 'Consumers', schema: FILE }
  ),
  () => agent(
    rules('src/renderer/src/store.ts') + '\n\n' +
    'TASK: implement the store.ts bullet. Update every stage-core call site to the new signatures (drop stage/order/count args from latticeFor/occupancy/nearestFreeSlot/flowFiles, gridSummary not stageSummary, HOME_BUDGET not STAGE_BUDGET). Fix the re-export block near line 79 to only the surviving stages-core exports (homeRect, parkBandRect, DEFAULT_VP). Delete controlTransform (state field + all updates), clampStagePan, controlScale. Collapse viewTransform into homeTransform(vp) returning the scale-1 home frame. In panBy/zoomAt delete the mode==="canvas" branches but KEEP the existing `if (s.locked) return {}` freeze gate. Remove currentStage/currentStageRect/stageCount/stageOrder from state. Pin mode to "desktop". Do NOT change the lock/Shift gesture wiring (already correct). This file is large; be surgical.',
    { label: 'consumer:store', phase: 'Consumers', schema: FILE }
  ),
])
const cFail = consumers.map((r, i) => (r && r.ok ? null : i)).filter((x) => x !== null)
log('Consumers done. ' + (cFail.length ? ('flagged indices: ' + cFail.join(',')) : 'all ok'))

// ---- Phase 3: Renderer chrome (file-exclusive; depends on store's new shape) ----
phase('Renderer')
const renderer = await parallel([
  () => agent(
    rules('src/renderer/src/App.tsx') + '\n\n' +
    'TASK: implement the App.tsx bullet. Delete enterStageOverview, switchStage, addStageAndGo, addAreaFromOverview. Remove the Cmd+ArrowLeft/Right and Cmd+N stage keybinds. Remove the mode==="canvas" branches, showAreaFrames, and the <AreaChromeOverlay .../> render. Remove the currentStage/currentStageRect fields from the sendState/os:state push. Fix the now-stale shift-tap comments to describe the lock/home model (single Shift = freeze toggle, double Shift = fly home + freeze). KEEP the ESC->workspace-switcher overlay and the lock gestures and Overview exactly as they are. If you reference a symbol the store no longer exports (controlTransform, currentStage, stageCount), remove that usage.',
    { label: 'render:App', phase: 'Renderer', schema: FILE }
  ),
  () => agent(
    rules('src/renderer/src/components/PrimarySpace.tsx') + '\n\n' +
    'TASK: implement the PrimarySpace.tsx bullet. Delete the AreaChromeOverlay component (it is exported from here). Drop sceneryClip and its usage (the home tint is dropped). renderStage should render ONLY the single home region (no per-stage loop, no stageOrder/stageCount). Remove imports of deleted stages-core symbols.',
    { label: 'render:PrimarySpace', phase: 'Renderer', schema: FILE }
  ),
  () => agent(
    rules('src/renderer/src/components/Sidebar.tsx') + '\n\n' +
    'TASK: implement the Sidebar.tsx bullet. Drop the per-stage filter (the surfaceStage(...)===currentStage line). The dock should show all surfaces of the current workspace (still excluding the runtime-only kinds it already excludes). Remove imports of deleted stages-core symbols (surfaceStage, stageOrder, stageCount).',
    { label: 'render:Sidebar', phase: 'Renderer', schema: FILE }
  ),
  () => agent(
    rules('src/renderer/src/components/SurfaceFrame.tsx') + '\n\n' +
    'TASK: implement the SurfaceFrame.tsx bullet. Fold isControl into one always-on drag overlay: remove the `s.mode === "canvas"` gate. The drag overlay/handle should be available whenever appropriate WITHOUT depending on canvas mode; the freeze lock (already read at line ~258 for read-only gating) governs whether clicks pass through to content. Keep the existing locked-based read-only behavior. Remove any other mode==="canvas" usage in this file.',
    { label: 'render:SurfaceFrame', phase: 'Renderer', schema: FILE }
  ),
])
log('Renderer done.')

// ---- Phase 4: Tests + Docs (independent of each other) ----
phase('Tests+Docs')
const td = await parallel([
  () => agent(
    rules('scripts/tests/* and scripts/drive-stages.mjs and scripts/test-workspace-stage.mjs and any other script that imports the changed core') + '\n\n' +
    'TASK: tests. 1) Rewrite scripts/tests/test-stage-core.mjs to exercise the HOME lattice: latticeFor(vp) anchored on homeRect at world origin, occupancy(surfaces) and budgetUsed(surfaces) with NO stage param, findSlot fills home, gridSummary(surfaces,vp) shape. Assert real invariants. 2) DELETE scripts/tests/test-stage-splay-core.mjs. 3) Update scripts/tests/test-stage-e2e.mjs and scripts/tests/test-onboarding-seed.mjs to the new signatures (drop stage args, gridSummary, homeRect). 4) DELETE scripts/drive-stages.mjs and scripts/test-workspace-stage.mjs. 5) ADD a new pure smoke test scripts/tests/test-os-tools-home.mjs: import makeOsTools from ../../src/main/os-tools.mjs with a minimal stub ops object, and assert (a) the tool name list includes bring_home and send_offscreen and EXCLUDES bring_to_stage/send_backstage, (b) the place_widget input schema has no `agent` property, (c) calling the list_state handler over a stub state returns an object whose keys do NOT include stageCount/stageOrder/currentStage and that has a `grid` key (not `stage`). If makeOsTools needs ops methods, stub them as no-ops returning {}. 6) Any other script importing the changed core (test-slot-glitch-drop, repro-slot-orphan, drive-jsx-widget, show-jsx-widgets, drive-redesign, onboarding-scan): just fix imports/calls so they still parse and import cleanly. Run `node` on each pure test you wrote to confirm it passes before returning; paste the pass output in your summary.',
    { label: 'tests', phase: 'Tests+Docs', schema: FILE }
  ),
  () => agent(
    rules('agent-os/CLAUDE.md (i.e. ' + ROOT + '/CLAUDE.md)') + '\n\n' +
    'TASK: docs in agent-os/CLAUDE.md. The file currently has the "Stage slot desktop" bullet DUPLICATED verbatim (it appears twice) plus a "Stage splay lattice" bullet. Collapse all three into ONE concise "Home lattice" bullet describing: one bounded slot lattice at home (homeRect), off-home = open canvas parking, place_widget/bring_home/send_offscreen, the HOME_BUDGET. Rewrite the navigation-model paragraphs (the "infinite canvas" / "Navigation modes" / canvas-Control-Mode / splay text) to the home-only model: single home frame, single Shift = freeze toggle, double Shift = fly home + freeze, ESC = workspace switcher, NO stages/splay/canvas-mode. Update every tool name (bring_to_stage->bring_home, send_backstage->send_offscreen) and remove agent-as-stage mentions. Keep it tight and in the existing bullet style; no em dashes.',
    { label: 'docs:claudemd', phase: 'Tests+Docs', schema: FILE }
  ),
  () => agent(
    rules('/Users/minjunes/.claude/skills/blitzos/SKILL.md AND plans/blitzos-stage-splay-lattice.md (delete) AND plans/blitzos-stage-slot-desktop.md (delete if present) AND ../plans/agent-os-desktop-architecture.md AND the memory note + index') + '\n\n' +
    'TASK: skill + plans + memory churn. 1) /Users/minjunes/.claude/skills/blitzos/SKILL.md: rename tools bring_to_stage->bring_home and send_backstage->send_offscreen, drop the agent-as-stage / multi-stage placement guidance, switch vocabulary to home/off-screen, drop place_widget {agent}. 2) DELETE ' + ROOT + '/plans/blitzos-stage-splay-lattice.md and ' + ROOT + '/plans/blitzos-stage-slot-desktop.md if it exists. 3) /Users/minjunes/superapp/teenybase/plans/agent-os-desktop-architecture.md: in its navigation section, replace the stage/splay description with a one-paragraph pointer to plans/blitzos-single-canvas-navigation.md (home-only). 4) Memory: /Users/minjunes/.claude/projects/-Users-minjunes-superapp-teenybase-agent-os/memory/blitzos-multi-stage-presentation.md now describes a removed feature — rewrite it to note multi-stage was collapsed to home-only (link [[blitzos-system-map]]) OR delete it, and update its one-line pointer in that same memory folder MEMORY.md accordingly. Use Bash rm for deletions. No em dashes.',
    { label: 'docs:skill+plans+memory', phase: 'Tests+Docs', schema: FILE }
  ),
])
log('Tests+Docs done.')

// ---- Phase 5+6: Verify, then fix loop until green ----
const verifyPrompt =
  'Repo root: ' + ROOT + '. Run these from the repo root and capture results HONESTLY (do not fake anything; agent-os/CLAUDE.md forbids claiming a pass without proof). ' +
  'Step 1: `npm run typecheck` (allow up to 300000ms). Step 2: `npm run build` (allow up to 600000ms; this bundles main+preload+renderer and catches .mjs import/export errors across the main<->renderer-core boundary). Step 3: `node scripts/tests/test-stage-core.mjs`. Step 4: `node scripts/tests/test-onboarding-seed.mjs`. Step 5: `node scripts/tests/test-os-tools-home.mjs`. ' +
  'Optionally try `node scripts/tests/test-stage-e2e.mjs` but if it fails ONLY because it needs a display/Electron/Chromium binary that is absent, record it as a step with ok:false and tail noting "needs display - not a code failure" and do NOT count it toward pass. ' +
  'For each step record {cmd, ok, tail(last ~40 lines)}. Set pass=true ONLY if steps 1-5 all succeeded (exit 0 / test prints success). For every failing step add a failures[] entry with the precise file/area and the actual error text (the compiler/test message), so a fixer can act. Do not edit any files.'

phase('Verify')
let verify = await agent(verifyPrompt, { label: 'verify', phase: 'Verify', schema: VERIFY })
let attempt = 0
while (verify && !verify.pass && attempt < 3) {
  attempt++
  phase('Fix')
  const fails = (verify.failures || []).map((f) => '- [' + f.area + '] ' + f.error).join('\n') || 'see steps tails'
  log('Verify failed (attempt ' + attempt + '). Dispatching fixer.')
  await agent(
    'Repo root: ' + ROOT + '. Obey ../CLAUDE.md + agent-os/CLAUDE.md (NO hacks, fix the TRUE root cause, handle all edge cases). The contract is ' + PLAN + '. ' +
    'A verify run of `npm run typecheck` + `npm run build` + the node tests FAILED. Fix the real cause of EACH failure below by editing the offending source/test files (you may edit any file under src/ or scripts/). Common causes after this refactor: a call site still passing a stage/order/count arg, an import of a deleted/renamed symbol (orderedStageRect/stageForAgent/stageSummary/STAGE_BUDGET/primaryRect/controlTransform/currentStage), a renderer reading a store field that no longer exists, or a test asserting old shape. Re-run the failing command yourself to confirm your fix before returning. Do NOT mask errors (no `any`, no try/catch swallow, no @ts-ignore). FAILURES:\n' + fails,
    { label: 'fix:attempt' + attempt, phase: 'Fix', schema: FILE }
  )
  phase('Verify')
  verify = await agent(verifyPrompt, { label: 'verify:retry' + attempt, phase: 'Verify', schema: VERIFY })
}

return {
  core: { stagesCore: core?.stagesCoreExports, stageCore: core?.stageCoreExports },
  consumers: consumers.map((r) => ({ ok: r?.ok, summary: r?.summary, dangling: r?.dangling })),
  renderer: renderer.map((r) => ({ ok: r?.ok, summary: r?.summary, dangling: r?.dangling })),
  testsDocs: td.map((r) => ({ ok: r?.ok, summary: r?.summary })),
  verify: { pass: verify?.pass, attempts: attempt, steps: (verify?.steps || []).map((s) => ({ cmd: s.cmd, ok: s.ok })), failures: verify?.failures || [] },
}
