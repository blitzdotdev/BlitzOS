# #45 Workspace areas — grounded implementation plan (2026-06-07)

> **⚠️ Vocabulary update (2026-06-11):** "areas" were renamed to **STAGES** (`stageForAgent`, `stageCount`, `stages-core.mjs`). Read "area" as "stage" throughout. Implemented + shipped (stage-per-agent + the slot lattice; see `plans/blitzos-stage-slot-desktop.md`).

Synthesized by a 4-agent workflow that mapped every spatial-fn consumer in the CURRENT (post-window-rewrite)
code. Design model in `multiple-workspace-areas.md`. **Overriding invariant: at `areaCount===1` every spatial
computation is byte-identical to today** (no regression to the just-rewritten, GUI-unverified window system).

## Step 1 — store: area-aware spatial fns, byte-identical at areaCount===1 (headless-provable, NO UI)
`src/renderer/src/store.ts`:
- Add `AREA_GAP = 1200` (stable constant), `areaStride(vp) = primaryRect(vp).w + AREA_GAP`, and
  `areaRect(i,vp) = { x: i*stride - r.w/2, y: -r.h/2, w: r.w, h: r.h }` (r = primaryRect). **Keep `primaryRect`
  literally unchanged** — `areaRect` references it; never re-express primaryRect via areaRect (drift risk).
- State: `areaCount:1`, `currentArea:0`; actions `setCurrentArea` (clamp 0..n-1), `setAreaCount` (floor 1),
  `addArea` (count++, switch to new).
- Make `desktopClamp`/`snapTargetFor`/`viewTransform`/`toggleMaximize`/`goToPrimary`/`focusAndZoom` take an
  optional `area=0` (and `areaCount=1` for viewTransform) and branch `area===0 ? primaryRect(vp) : areaRect(area,vp)`
  so the area-0 path executes the OLD code literally. viewTransform CANVAS scale stays the literal `0.31` for
  n===1; the fit-all formula is only entered when `areaCount>1`.
- **Proof (extend `scripts/test-window-system.ts`):** deepEqual(areaRect(0,vp), primaryRect(vp)); every existing
  3-arg snapTargetFor assertion still passes; snapTargetFor(x,y,vp)===snapTargetFor(x,y,vp,0) for the 8 samples;
  viewTransform('desktop'|'canvas',vp)===(…,0,1) forms; canvas scale===0.31; fresh state areaCount===1/currentArea===0.

## Step 2 — render all areas in CONTROL mode; NORMAL locks to current area
`PrimarySpace.tsx` loops `areaRect(i,vp)` (label `PRIMARY` when count===1 — byte-identical DOM — else `AREA i+1`
+ current highlight). Finalize viewTransform CANVAS fit-all (union of areaRect(0..n-1); n===1 ⇒ exactly 0.31).
App.tsx toggleControlMode passes `currentArea,areaCount`. **Proof:** canvas scale<0.31 for n=2 + union-center maps
to viewport center; desktop n=1/area-1 centers areaRect(1) at the same screen point area-0 uses.

## Step 3 — switching (Cmd/Ctrl+←/→, animated) + add-area; clamp/snap/resize/maximize in current area
App.tsx keydown: Cmd/Ctrl+Arrow → setCurrentArea(±1) (guard editable focus; animate ONLY in desktop mode — in
control mode just retarget+highlight, no camera jump). Toolbar `+` → addArea. **Proof:** moveSurface clamps to
areaRect(1) when currentArea=1 (regression-guard: byte-identical to primaryRect at currentArea=0); snap/maximize
likewise key off currentArea.

## Step 4 — persist areaCount round-trip + expose areas to the agent (both transports)
`workspace.mjs`/`.d.mts`: write+read top-level `areaCount` (`Number.isInteger && >0` guard, default 1 for old
folders). `workspace-host.mjs` doReconcile preserves `areaCount: st.areaCount ?? 1`. `osActions.ts` OsState +
sendState (App.tsx) push `areaCount`/`currentArea`/`primaryAreaRect`(=areaRect(currentArea,vp)). `backend.mjs`
/list_state whitelist must explicitly add the 3 fields. `blitzos-agents.md`: areas are bounded desktops tiled
left→right; place surfaces in the CURRENT area (list_state.primaryAreaRect) near view; human switches; read-only
awareness (no agent-driven area create/switch tool in v1). **Proof:** `scripts/test-workspace-area.mjs` round-trip
(write areaCount 3 → read 3; missing → 1; hand-written old json → 1, rest unchanged).

## Key risks (mitigations baked into the steps)
- primaryRect re-definition drift → keep primaryRect literal; gate on deepEqual.
- viewTransform CANVAS must collapse to EXACTLY 0.31 at n===1 → branch `n===1 ? 0.31 : fit(...)`.
- Required-vs-optional params → all new params optional (area=0 / areaCount=1).
- sendState omission → step 4 explicitly edits the push payload; assert it includes the fields.
- Cmd+Arrow vs textarea caret → guard editable focus.
- Backward-compat → readWorkspace defaults missing/invalid areaCount to 1 (tested with a hand-written old json).
- capture.ts area-awareness is OPTIONAL (area-0 path keeps the thumbnail byte-identical) — defer unless needed.
