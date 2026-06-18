# BlitzOS: Single-Canvas Navigation (home-only)

Status: BUILDING. Collapses the multi-stage desktop to ONE surviving region, "home". Supersedes `blitzos-stage-splay-lattice.md` and the stage parts of `blitzos-stage-slot-desktop.md` + the nav section of `../plans/agent-os-desktop-architecture.md`.

## Model (confirmed)
- One workspace = one infinite canvas with ONE bounded slot lattice that lives only at **home** (today's stage-0 rect, `primaryRect`→`homeRect`). Off-home is open canvas: web/app windows park there, no grid.
- **Home** = the computed scale-1 frame (`homeRect`/`homeTransform`). No saved camera. `go_to_primary`/double-Shift fly there.
- **Single Shift** = one-shot survey, then freeze toggle (`locked` gates pan/zoom): from the locked home screen the first tap zooms out 50% (anchored on home's center) and unfreezes; otherwise it toggles freeze. **Double Shift** = fly home + freeze. **ESC** = workspace switcher overlay (already wired). Workspaces replace stages.
- Decisions: rename the stage tools (+ fix all doc/skill churn); pin `mode:'desktop'` (delete the field later); defer `homeCamera`/Set-Home, multi-agent placement, and the home tint.

## Contract (what changes, by file) — agents read THIS plus the file itself

### Core (`src/renderer/src/`)
- **stages-core.mjs**: keep `DEFAULT_VP`; rename `primaryRect`→`homeRect(vp)`; simplify `parkBandRect(vp)` = `{x:home.x, y:home.y+home.h, w:home.w, h:PARK_GAP}`. DELETE `stageStride`, `stageRect`, `stageCenterX`, `stageForAgent`, `stageOfX`, `splayRows`, `stagePitchY`, `splayLayout`, `splaySlotRect`, `orderedStageRect`, `addStageRect`, `stageOfPoint`, `surfaceStage`, `insertAt`, `identityOrder`, and the `STAGE_GAP` const. Keep the chrome-inset consts + `PARK_GAP`. Rewrite the header comment to home-only.
- **stage-core.mjs**: import `{ homeRect, DEFAULT_VP }` (drop `orderedStageRect`). Drop the `stage`/`order`/`count` params AND every `slotStage`/stage filter from `latticeFor` (→ `latticeFor(vp)` on `homeRect`), `occupancy`, `budgetUsed`, `findSlot`, `nearestFreeSlot`, `flowFiles`. Rename `stageSummary`→`gridSummary(surfaces,vp)` and drop its `stage` field; rename `STAGE_BUDGET`→`HOME_BUDGET`. Keep `TILE`, `CARD_INSET`, `SPANS`, `SIZE_ORDER`, `spanOf`, `sizePx`, `slotRect`, `cardRect`, `slotOf`, `sizeForDims`.

### Consumers (`src/main/`)
- **os-tools.mjs**: imports → `{ homeRect, parkBandRect, DEFAULT_VP }` + `{ latticeFor, cardRect, findSlot, budgetUsed, gridSummary, sizeForDims, spanOf, HOME_BUDGET }`. Rename tools **`bring_to_stage`→`bring_home`** (path `/bring_home`) and **`send_backstage`→`send_offscreen`** (path `/send_offscreen`). DROP the `agent` param from `place_widget`/`create_surface`/`open_window`/`open_terminal` and delete every `stageForAgent` call. `isOffstage(s,vp)` = surface center outside `homeRect(vp)`. `parkOffstage` uses `parkBandRect(vp)`. `list_state` returns a WHITELIST only: `{surfaces, viewport, view, camera, mode, workspace, workspace_path, grid: gridSummary(...), offstage:[...]}` — no `stage`/`stageCount`/`stageOrder`/`currentStage`/`currentStageRect` (kills the live leak); rename summary key `stage`→`grid`, `backstage`→`offstage`. Rename the `stage_full` error → `home_full`. Rewrite tool DESCRIPTIONS: "stage"→"home", "off-stage/backstage"→"off-screen". `go_to_primary` description = "fly to home".
- **workspace-host.mjs**: delete `maxAgentStageCount`, `growOrder`, the stageCount self-heal (hydrate + switch), and all `currentStage`/`currentStageRect` handling; `setState`/broadcasts drop `stageCount`/`stageOrder`; pin `mode:'desktop'` in `blank()`/defaults (fix the `mode:'canvas'` default). Imports drop `stageForAgent`/`orderedStageRect` (keep `DEFAULT_VP`).
- **workspace.mjs**: `stageFields` stops writing `slotStage`/`slotArea`/`stageCount`/`stageOrder`; ignore them on read (x/y stays truth — NO slot migration); persisted `mode` defaults to `'desktop'`.
- **onboarding-board.mjs**: import `homeRect` (not `stageRect`); drop `slotStage` from seeded cards; place every card on the single home lattice (`latticeFor(vp)`/`findSlot` with no stage). Remove per-agent stage placement.

### Renderer chrome (`src/renderer/src/`, AFTER consumers land)
- **store.ts**: update stage-core call sites to the new signatures (drop stage/order/count args); fix the re-export block (~line 79) to the surviving exports. Delete `controlTransform` (state + updates), `clampStagePan`, `controlScale`; collapse `viewTransform`→`homeTransform(vp)`. `panBy`/`zoomAt` drop the `mode==='canvas'` branches (KEEP the `locked` gate). Remove `currentStage`/`currentStageRect`/`stageCount`/`stageOrder` from state; pin `mode:'desktop'`.
- **App.tsx**: delete `enterStageOverview`, `switchStage`, `addStageAndGo`, `addAreaFromOverview`; remove the ⌘←/→ and ⌘N keybinds; remove the canvas-mode branches + `showAreaFrames` + the `AreaChromeOverlay` render; remove the `currentStage`/`currentStageRect` push; fix the stale shift-tap comments to the lock/home model. KEEP ESC/overview + the lock gestures.
- **PrimarySpace.tsx**: delete `AreaChromeOverlay`; drop `sceneryClip` (home tint dropped); render only home.
- **Sidebar.tsx**: drop the per-stage filter (`surfaceStage(...)===currentStage`); show all current-workspace surfaces.
- **SurfaceFrame.tsx**: fold `isControl` into one always-on drag (remove the `mode==='canvas'` gate; the freeze `locked` already governs whether clicks reach content).

### Tests + docs
- Tests: rewrite `scripts/tests/test-stage-core.mjs` (home lattice, no stage param); DELETE `scripts/tests/test-stage-splay-core.mjs`; update `scripts/tests/test-stage-e2e.mjs` + `test-onboarding-seed.mjs`; delete `scripts/drive-stages.mjs` + `scripts/test-workspace-stage.mjs`; keep any other importing script (test-slot-glitch-drop, repro-slot-orphan, drive-*) parsing under the new signatures.
- Docs: `agent-os/CLAUDE.md` — collapse the DUPLICATED "Stage slot desktop" bullets + the "Stage splay lattice" bullet into ONE "Home lattice" bullet; rewrite the nav-model paragraphs (no stages/splay; single home + freeze lock + ESC switcher); update tool names. `~/.claude/skills/blitzos/SKILL.md` — rename tools, drop agent-as-stage, home vocabulary. `../plans/agent-os-desktop-architecture.md` — repoint its nav section here. DELETE `plans/blitzos-stage-splay-lattice.md` (+ `blitzos-stage-slot-desktop.md` if present). Memory: update/delete `blitzos-multi-stage-presentation.md` + its `MEMORY.md` line.

## Migration
Old `workspace.json` with `stageCount`/`stageOrder`/`slotStage` just loads (extra fields ignored); surfaces keep x/y, so a stage-N window is simply off-home until the user/agent re-homes it. No migration code.

## Deferred (NOT this plan)
`homeCamera`/Set-Home menu+IPC (use the computed home frame), multi-agent on one grid (single grid = home), removing the `mode` field (pinned `'desktop'`), the home tint.

## Phases (workflow)
1. Core API (stages-core + stage-core). 2. Consumers (os-tools ∥ host+workspace ∥ onboarding ∥ store). 3. Renderer chrome (App ∥ PrimarySpace ∥ Sidebar ∥ SurfaceFrame). 4. Tests ∥ Docs. 5. Verify: `npm run typecheck` + `npm run build` + `node scripts/tests/test-stage-core.mjs` + `test-onboarding-seed.mjs` all green. 6. Fix loop until green.
