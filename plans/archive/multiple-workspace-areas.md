# Multiple workspace areas (#45) — design

> **⚠️ Vocabulary update (2026-06-11):** "areas" were renamed to **STAGES** (`stageForAgent`, `stageCount`, `stages-core.mjs`, meta field `stage`). Read every "area" below as "stage". The feature **shipped** — stage-per-agent plus the slot lattice (`stage-core.mjs`, `place_widget`/`bring_to_stage`/`send_backstage`); see `plans/blitzos-stage-slot-desktop.md`.

**Status:** design (2026-06-07). The user's explicitly-flagged "next big thing": more than one
workspace area, like macOS Spaces. Today there is ONE area (`primaryRect`, centered at the world
origin). Control mode is supposed to show them ALL — so areas must be TILED in world space (separate
origin-centered surface-sets can't be shown side-by-side).

## Model

- **Areas are tiled horizontally in world space.** Area `i` is an area-sized rect centered at
  `(i * stride, 0)`, where `stride = areaW + GAP`. Area 0 is centered at the origin → **identical to
  today when `areaCount === 1`** (no regression to the working single-area behavior — the invariant).
- `areaRect(i, vp)` = `{ x: i*stride - w/2, y: -h/2, w, h }` with `w,h` = the screen-sized area
  dimensions (today's `primaryRect` size). `primaryRect(vp)` stays = `areaRect(0, vp)`.
- Store: `areaCount` (default 1), `currentArea` (default 0). A surface's area is DERIVED from its
  world x (`round(x / stride)` clamped to [0, areaCount-1]) — no separate field needed for v1.

## Spatial functions become area-aware (thread `currentArea`)

The operations that today use `primaryRect(vp)` must use the CURRENT area's rect:
- store `desktopClamp` / `toggleMaximize` / `viewTransform` / `goToPrimary` — they have `s`, so use
  `areaRect(s.currentArea, vp)`.
- renderer `snapTargetFor(wx,wy,vp, area)`, SurfaceFrame resize-clamp, `capture.ts` — pass
  `currentArea` (the component reads `s.currentArea`).
- `viewTransform`: NORMAL = scale-1 centered on `areaRect(currentArea)`; CONTROL = fit ALL areas
  (compute the bounding rect of areas 0..n-1, fit it to the viewport at the control margin).
- `PrimarySpace`: render ALL area rects (labeled 1..n), not just the origin one.

## Switching + adding

- Switch: `Ctrl/Cmd + ←/→` → `setCurrentArea(±1)` clamped → animate the camera to `areaRect(i)`
  (reuse `animateTransform`). The ws-btn / a small area indicator shows "Area i/n".
- Add: a "+" (toolbar or control-mode) → `areaCount++` + switch to the new (empty) area.
- New surfaces (agent or user) land in the current area (cascade around its center).

## Persistence

- `workspace.json`: add `areaCount` (top-level). Surfaces already persist their world x/y, which
  encodes the area (tiled). On hydrate, `currentArea = 0`. writeWorkspace writes areaCount;
  readWorkspace restores it.

## Agent (blitzos-agents.md + list_state)

- `list_state` already returns `view`; add `areaCount` + `currentArea` + the current area's rect.
- Manual: "Workspace areas are bounded desktops tiled left→right; place surfaces in the CURRENT area
  (near `view`); to use another area, the human switches to it." (The agent works in the current
  area; multi-area orchestration by the agent is a later refinement.)

## Build order (each proven before the next)

1. store: `areaCount`/`currentArea`/`areaRect`; make `primaryRect`+the spatial fns area-aware
   (areaCount=1 must be byte-identical behavior). Headless-verify single-area unchanged.
2. PrimarySpace renders all areas; control-mode fits all; normal locks to current. Verify.
3. Switch (Ctrl+←/→, animated) + add-area. Verify the camera lands on each area + clamp/snap/resize
   operate in the current area.
4. Persist areaCount (round-trip). MD + list_state expose areas.

## Risk

This touches the PROVEN single-area spatial model (clamp, snap, resize-clamp, fullscreen, capture).
The areaCount=1 ⇒ identical-behavior invariant is the safety net — verify it after step 1 before
adding any multi-area UI.
