export const meta = {
  name: 'blitzos-single-canvas-finish',
  description: 'Finish the home-only refactor: renderer + type decls + straggler consumers + tests + docs, then verify until green',
  phases: [
    { title: 'Finish edits', detail: 'renderer, store+types, .d.mts, main stragglers, server+terminal, tests, docs' },
    { title: 'Verify', detail: 'typecheck + build + node tests' },
    { title: 'Fix', detail: 'repair until green' },
  ],
}

const ROOT = '/Users/minjunes/superapp/teenybase/agent-os'
const PLAN = ROOT + '/plans/blitzos-single-canvas-navigation.md'

const rules = (owns) =>
  'Repo root: ' + ROOT + '. Obey ../CLAUDE.md AND agent-os/CLAUDE.md: NO hacks/shortcuts (no `any`, no @ts-ignore, no try/catch swallow), handle every edge case, match surrounding style/comment density, no em dashes in prose. ' +
  'CONTEXT: a multi-stage->home-only refactor is HALF DONE. Core is finished: stages-core.mjs now exports ONLY {DEFAULT_VP, homeRect, parkBandRect}; stage-core.mjs exports {TILE,CARD_INSET,SPANS,SIZE_ORDER,HOME_BUDGET,spanOf,sizePx,latticeFor,slotRect,cardRect,slotOf,occupancy,budgetUsed,findSlot,nearestFreeSlot,sizeForDims,gridSummary,flowFiles} with NO stage/order/count params. os-tools/workspace-host/workspace/onboarding-board/store.ts were edited (store may be only PARTLY done). These symbols are DELETED/RENAMED and must NOT remain anywhere: orderedStageRect, stageRect, primaryRect, stageForAgent, stageOfPoint, surfaceStage, splayLayout, splaySlotRect, stageStride, stageCenterX, stageOfX, addStageRect, insertAt, identityOrder, stageSummary, STAGE_BUDGET, controlTransform, clampStagePan, viewTransform, currentStage, currentStageRect, stageCount, stageOrder, slotStage, bring_to_stage, send_backstage, AreaChromeOverlay, enterStageOverview. Renames: primaryRect->homeRect, stageSummary->gridSummary, STAGE_BUDGET->HOME_BUDGET, viewTransform->homeTransform, bring_to_stage->bring_home, send_backstage->send_offscreen. ' +
  'READ THE CONTRACT: ' + PLAN + '. You may ONLY edit: ' + owns + '. After editing, grep your file(s) for the banned-symbol list and remove EVERY remaining reference. Report any cross-file dangling reference you spot but cannot fix.'

const FILE = {
  type: 'object', additionalProperties: false, required: ['ok', 'summary'],
  properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, dangling: { type: 'array', items: { type: 'string' } } },
}
const VERIFY = {
  type: 'object', additionalProperties: false, required: ['pass', 'steps'],
  properties: {
    pass: { type: 'boolean', description: 'true ONLY if typecheck + build + the three pure node tests all passed' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cmd', 'ok'], properties: { cmd: { type: 'string' }, ok: { type: 'boolean' }, tail: { type: 'string' } } } },
    failures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['area', 'error'], properties: { area: { type: 'string' }, error: { type: 'string' } } } },
  },
}

phase('Finish edits')
const edits = await parallel([
  () => agent(
    rules('src/renderer/src/App.tsx, src/renderer/src/components/PrimarySpace.tsx, src/renderer/src/components/Sidebar.tsx, src/renderer/src/components/SurfaceFrame.tsx, src/renderer/src/capture.ts') + '\n\n' +
    'TASK (Renderer section of the plan). App.tsx: delete enterStageOverview/switchStage/addStageAndGo/addAreaFromOverview, the Cmd+ArrowLeft/Right and Cmd+N keybinds, all mode==="canvas" branches, showAreaFrames, the <AreaChromeOverlay .../> render, and the currentStage/currentStageRect fields in the os:state push; fix the stale shift-tap comments to the lock/home model; KEEP the ESC->workspace-switcher overlay and lock gestures untouched. PrimarySpace.tsx: delete the exported AreaChromeOverlay component and sceneryClip; renderStage renders ONLY the single home region. Sidebar.tsx: drop the per-stage filter (surfaceStage(...)===currentStage) and show all current-workspace surfaces (keep existing runtime-kind exclusions). SurfaceFrame.tsx: fold isControl into one always-on drag (remove the mode==="canvas" gate; keep the existing locked-based read-only gate). capture.ts: remove any currentStage/stage references. The store now exposes homeTransform (not viewTransform/controlTransform) and no longer has currentStage/stageCount/stageOrder.',
    { label: 'renderer-chrome', phase: 'Finish edits', schema: FILE }
  ),
  () => agent(
    rules('src/renderer/src/store.ts, src/renderer/src/types.ts') + '\n\n' +
    'TASK: FINISH store.ts (it was only partly edited) + types.ts. store.ts: ensure controlTransform/clampStagePan/controlScale are fully gone; viewTransform is fully collapsed to homeTransform(vp) (zero remaining "viewTransform" identifiers, all callers updated); panBy/zoomAt keep the `if (s.locked) return {}` gate but have NO mode==="canvas" branch; currentStage/currentStageRect/stageCount/stageOrder are removed from state and every action; the stages-core re-export block (~line 79) re-exports only homeRect/parkBandRect/DEFAULT_VP; all stage-core call sites use the new signatures (latticeFor(vp), occupancy(surfaces), gridSummary, HOME_BUDGET, no stage args). types.ts: remove stageCount/stageOrder/currentStage/currentStageRect/slotStage and any controlTransform field from the Surface/DesktopState/persisted interfaces. Grep both for the banned list; zero remain.',
    { label: 'store+types', phase: 'Finish edits', schema: FILE }
  ),
  () => agent(
    rules('src/renderer/src/stage-core.d.mts, src/renderer/src/stages-core.d.mts') + '\n\n' +
    'TASK: regenerate these TWO .d.mts declaration files to EXACTLY match the new runtime exports of their .mjs siblings (READ src/renderer/src/stage-core.mjs and stages-core.mjs first). stages-core.d.mts declares ONLY DEFAULT_VP, homeRect(vp), parkBandRect(vp). stage-core.d.mts declares TILE, CARD_INSET, SPANS, SIZE_ORDER, HOME_BUDGET, spanOf, sizePx, latticeFor(vp), slotRect, cardRect, slotOf, occupancy(surfaces,excludeId?), budgetUsed(surfaces), findSlot(surfaces,lat,size,near?,excludeId?), nearestFreeSlot, sizeForDims, gridSummary(surfaces,vp), flowFiles(files,surfaces,vp,avoid?). Remove EVERY deleted/renamed symbol. Match the existing declaration style and parameter types.',
    { label: 'core-dts', phase: 'Finish edits', schema: FILE }
  ),
  () => agent(
    rules('src/main/osActions.ts, src/main/telemetry.ts, src/main/onboarding.ts, src/preload/index.ts, src/main/onboarding-board.d.mts, src/main/workspace.d.mts') + '\n\n' +
    'TASK: strip the dead stage model from these main-process + declaration files. osActions.ts (~line 1097 Electron hydrate send): stop reading/sending cached.stageCount/stageOrder/currentStage/currentStageRect; default mode to "desktop"; if it launches/places an agent by stage, pass home (0). telemetry.ts: drop stageCount/currentStage from any captured/serialized state shape. onboarding.ts: drop any stage/stageCount references. preload/index.ts: drop stageCount/stageOrder/currentStage from any IPC payload TYPE. onboarding-board.d.mts: remove slotStage from StagedSurface. workspace.d.mts: remove stageCount/stageOrder (and slotStage if present) from the workspace shape. Grep all six afterward.',
    { label: 'main-stragglers', phase: 'Finish edits', schema: FILE }
  ),
  () => agent(
    rules('preview/backend.mjs, src/main/terminal-manager.mjs') + '\n\n' +
    'TASK: preview/backend.mjs (~line 710 server hydrate send): stop reading/sending osState.stageCount/stageOrder/currentStage (single home now); pin mode "desktop" where defaulted. terminal-manager.mjs: remove the per-terminal `stage` field and the spawnTerminal({stage}) modeling (open_terminal no longer passes a stage; everything is home) — keep reads of an absent/legacy stage tolerant (ignore it). Run `node --check` on both. Grep both for stageCount/stageOrder/`stage` field afterward.',
    { label: 'server+terminal', phase: 'Finish edits', schema: FILE }
  ),
  () => agent(
    rules('scripts/tests/test-stage-core.mjs, scripts/tests/test-stage-splay-core.mjs, scripts/tests/test-stage-e2e.mjs, scripts/tests/test-onboarding-seed.mjs, scripts/tests/test-os-tools-home.mjs (new), scripts/drive-stages.mjs, scripts/test-workspace-stage.mjs, scripts/repro-slot-orphan.mjs, scripts/test-slot-glitch-drop.mjs, scripts/test-workspace-jsx.mjs, scripts/tests/test-window-system.ts') + '\n\n' +
    'TASK (Tests). 1) Rewrite scripts/tests/test-stage-core.mjs for the HOME lattice: latticeFor(vp) on homeRect at world origin, occupancy(surfaces)/budgetUsed(surfaces) with NO stage param, findSlot fills home, gridSummary(surfaces,vp) shape — assert real invariants. 2) DELETE (Bash rm) scripts/tests/test-stage-splay-core.mjs, scripts/drive-stages.mjs, scripts/test-workspace-stage.mjs. 3) Update scripts/tests/test-stage-e2e.mjs (the OLD tool paths /bring_to_stage and /send_backstage become /bring_home and /send_offscreen; drop stage args) and scripts/tests/test-onboarding-seed.mjs (homeRect, gridSummary, no stage args). 4) Fix imports/calls in scripts/repro-slot-orphan.mjs, scripts/test-slot-glitch-drop.mjs, scripts/test-workspace-jsx.mjs, scripts/tests/test-window-system.ts so they parse + import cleanly under the new signatures. 5) ADD scripts/tests/test-os-tools-home.mjs: import makeOsTools from ../../src/main/os-tools.mjs with a minimal no-op stub ops, assert the tool name list includes bring_home + send_offscreen and EXCLUDES bring_to_stage/send_backstage, that place_widget input schema has no `agent` property, and that the list_state handler over a stub state returns an object whose keys exclude stageCount/stageOrder/currentStage and include `grid`. Run each pure test you wrote/edited with `node` and paste the pass output in your summary.',
    { label: 'tests', phase: 'Finish edits', schema: FILE }
  ),
  () => agent(
    rules(ROOT + '/CLAUDE.md, /Users/minjunes/.claude/skills/blitzos/SKILL.md, ' + ROOT + '/plans/blitzos-stage-splay-lattice.md (delete), ' + ROOT + '/plans/blitzos-stage-slot-desktop.md (delete if present), /Users/minjunes/superapp/teenybase/plans/agent-os-desktop-architecture.md, src/main/blitzos-agents.md, src/main/blitzos-interview.md, the memory note + its MEMORY.md index') + '\n\n' +
    'TASK (Docs). agent-os/CLAUDE.md: collapse the DUPLICATED "Stage slot desktop" bullets + the "Stage splay lattice" bullet into ONE concise "Home lattice" bullet (one bounded lattice at home/homeRect, off-home=open-canvas parking, place_widget/bring_home/send_offscreen, HOME_BUDGET); rewrite the nav-model paragraphs to home-only (single home, single Shift=freeze toggle, double Shift=fly home+freeze, ESC=workspace switcher, NO stages/splay/canvas-mode); update all tool names. /Users/minjunes/.claude/skills/blitzos/SKILL.md: rename the two tools, drop agent-as-stage / multi-stage placement / place_widget {agent}, home vocabulary. DELETE plans/blitzos-stage-splay-lattice.md and plans/blitzos-stage-slot-desktop.md (Bash rm; if missing, skip). /Users/minjunes/superapp/teenybase/plans/agent-os-desktop-architecture.md: replace its nav section stage/splay text with a one-paragraph pointer to plans/blitzos-single-canvas-navigation.md. src/main/blitzos-agents.md AND src/main/blitzos-interview.md (agent duty docs injected at runtime): rename bring_to_stage->bring_home, send_backstage->send_offscreen, drop place_widget {agent}/agent-as-stage, stage->home vocabulary. Memory: rewrite /Users/minjunes/.claude/projects/-Users-minjunes-superapp-teenybase-agent-os/memory/blitzos-multi-stage-presentation.md to note multi-stage was collapsed to home-only (or delete it) and update its line in that folder MEMORY.md. No em dashes.',
    { label: 'docs', phase: 'Finish edits', schema: FILE }
  ),
])
log('Finish edits: ' + edits.map((r, i) => i + ':' + (r && r.ok ? 'ok' : 'FLAG')).join(' '))

const verifyPrompt =
  'Repo root: ' + ROOT + '. Run from the repo root and report HONESTLY (agent-os/CLAUDE.md forbids claiming a pass without proof; do not fake). ' +
  'Step 1 `npm run typecheck` (timeout 300000). Step 2 `npm run build` (timeout 600000; bundles main+preload+renderer, catches .mjs import/export errors). Step 3 `node scripts/tests/test-stage-core.mjs`. Step 4 `node scripts/tests/test-onboarding-seed.mjs`. Step 5 `node scripts/tests/test-os-tools-home.mjs`. ' +
  'Optionally try `node scripts/tests/test-stage-e2e.mjs`; if it fails ONLY for a missing display/Electron/Chromium, record ok:false with tail "needs display - not a code failure" and do NOT count it toward pass. ' +
  'For each step record {cmd, ok, tail(last ~40 lines)}. pass=true ONLY if steps 1-5 all succeed. For every failing step add failures[]={area:file/area, error:actual message}. Do not edit files.'

phase('Verify')
let verify = await agent(verifyPrompt, { label: 'verify', phase: 'Verify', schema: VERIFY })
let attempt = 0
while (verify && !verify.pass && attempt < 4) {
  attempt++
  phase('Fix')
  const fails = (verify.failures || []).map((f) => '- [' + f.area + '] ' + f.error).join('\n') || 'see step tails: ' + (verify.steps || []).filter((s) => !s.ok).map((s) => s.cmd + ' => ' + (s.tail || '')).join(' || ')
  log('Verify failed (attempt ' + attempt + '). Dispatching fixer.')
  await agent(
    'Repo root: ' + ROOT + '. Obey ../CLAUDE.md + agent-os/CLAUDE.md (fix the TRUE root cause, NO masking: no `any`, no @ts-ignore, no swallow). Contract: ' + PLAN + '. ' +
    'A verify run (`npm run typecheck` + `npm run build` + node tests) FAILED. Fix the real cause of EACH failure by editing the offending source/test files (you may edit ANY file under src/, scripts/, preview/). This is a multi-stage->home-only refactor; typical causes: a call site still passing a stage/order/count arg, an import or .d.mts decl of a deleted/renamed symbol (orderedStageRect/stageForAgent/stageSummary/STAGE_BUDGET/primaryRect/stageRect/controlTransform/viewTransform/currentStage/stageCount/stageOrder/slotStage), a renderer reading a removed store field, or a test asserting the old shape. Re-run the exact failing command yourself to CONFIRM the fix before returning. FAILURES:\n' + fails,
    { label: 'fix:' + attempt, phase: 'Fix', schema: FILE }
  )
  phase('Verify')
  verify = await agent(verifyPrompt, { label: 'verify:retry' + attempt, phase: 'Verify', schema: VERIFY })
}

return {
  edits: edits.map((r) => ({ ok: r?.ok, summary: (r?.summary || '').slice(0, 280), dangling: r?.dangling })),
  verify: { pass: verify?.pass, attempts: attempt, steps: (verify?.steps || []).map((s) => ({ cmd: s.cmd, ok: s.ok })), failures: verify?.failures || [] },
}
