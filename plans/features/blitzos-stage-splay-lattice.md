# Stage splay lattice — hybrid Mission-Control splay

> SUPERSEDED (2026-06-17): the multi-stage splay was removed when BlitzOS collapsed to a single home region. See blitzos-single-canvas-navigation.md. Kept for history.

Status: **implemented (phase 1) — 2026-06-12.** Shipped: the ported ragged-row core + tests
(`stages-core.mjs` splay section, `scripts/test-stage-splay-core.mjs`), order-aware geometry across
all consumers (store/App/PrimarySpace/SurfaceFrame/stage-core lattice/os-tools/workspace-host),
`stageOrder` persistence (workspace.json round-trip + self-heal verified), world-real
`applyStageOrder` with the shared membership rule, drag-to-reorder stage labels in the splay
(insertion-reflow preview in the chrome overlay; world commits on drop), park bands per cell
gutter, the per-stage sidebar dock, and `bulkAt` perception suppression. The splay camera now
bbox-fits the whole lattice incl. the placeholder cell. Pixels not yet user-verified.
Parent: `plans/blitzos-stage-slot-desktop.md` (widget lattice), `plans/agent-os-desktop-architecture.md` (canvas doctrine)

## What this is

Today the splay (double-tap ⌘ / home single-tap) is a pure camera zoom-out over the 1D stage
row: truthful, but stages shrink proportionally as count grows and the user cannot arrange them.
macOS Mission Control has the opposite tradeoff: an even, packed layout that is a synthesized,
ephemeral presentation.

The hybrid: stages get **real, deterministic 2D world positions** from a packing algorithm, the
user can **drag stages to reorder** them (insertion reflow, like the file/folder fluid layer), and
the result is **persisted world geometry** — the splay stays a camera move, never a synthesized
view. This is the slot-lattice philosophy applied one level up: widgets sit on a per-stage
lattice; stages sit on a coarser stage lattice.

## Locked decisions (user, 2026-06-12)

1. **World-real layout.** Stage cells are real canvas geometry. Moving a stage moves every
   surface geometrically inside it (slotted tiles, free windows, its park band) by the same
   delta. Desktop mode, zoom-out, and agents all see one arrangement. No splay-only state.
2. **Insertion reflow.** Dragging a stage onto an occupied cell inserts it at that position in
   reading order; stages in between shift one cell (iOS home screen semantics). Never swap,
   never overlap.
3. **macOS-style ragged rows, NOT an even grid** (revised 2026-06-12 after porting the real
   algorithm — see "Layout algorithm" below). Stages pack into CENTERED rows of uneven length
   (shipped, layout = stages + the placeholder slot: 3 stages → 3+1, 4 → 3+2, 6 → 2+2+3,
   7 → 3+3+2), the Exposé look, not a left-aligned rectangle. Count changes reshape the layout;
   the ORDER only changes via explicit user drags. (So auto-adding stages one by one yields a
   fresh deterministic layout on each splay, with the user's relative order preserved.)
4. **Park bands live in the cell gutter.** Each stage cell reserves a strip below its stage rect;
   `parkOffstage` targets it. Parked work stays visually attached to its stage; no collisions
   with the next row by construction.
5. **The "create new stage" placeholder is a layout citizen.** It occupies slot N (next in
   order) inside the same layout function, renders in the splay as a ghost cell, and clicking it
   materializes the stage in place.

## Model

- New pure shared module `src/renderer/src/stage-splay-core.mjs` (transport-shared like
  `stage-core.mjs` / `stages-core.mjs`):
  - `splayLayout(count, vp)` → `{rows: number[], originFor(i)}` — the PORTED ragged-row
    algorithm (see "Layout algorithm" below); cells are stage-rect-sized + gutters (gutter
    bottom = park band height); rows centered on a common axis.
  - `stageOrigin(orderIndex, layout)` → world `{x, y}` of that cell's stage rect.
  - `insertAt(order, from, to)` → new order (pure, tested).
  - **Row-0 compatibility:** a layout that fits one row MUST reproduce today's
    `i * stageStride(vp)` geometry exactly — existing 1–3 stage workspaces stay byte-identical,
    and `stageOrder` absent ⇒ identity order (the migration story).
- Persistence: `workspace.json` gains `stageOrder: number[]` (stage ids in reading order).
  `stageCount` unchanged. Agent-spawn growth appends to the order.
- `stageRect(i, vp)` becomes order-aware (position looked up via stageOrder → cell origin); all
  existing callers flow through it (`viewTransform`, `parkOffstage`, `snapTargetFor`,
  `latticeFor`, stage summaries).
- `stageOfX(centerX)` generalizes to `stageOfPoint(cx, cy)` = nearest cell; window stage
  membership stays geometric (doctrine).
- Agent identity untouched: `stageForAgent(N) = N` regardless of where stage N's cell sits.

## Layout algorithm — ported from source, not improvised

macOS's Mission Control lives in closed-source Dock.app, so "exactly how macOS does it" means
the two faithful reverse-engineered lineages, both cloned into `../.repos/` and read in full:

1. **GNOME Shell `UnalignedLayoutStrategy`** — `.repos/gnome-shell/js/ui/workspace.js:145`
   (the modern Mission Control model; GNOME's overview was redesigned against Exposé). This is
   the lineage we PORT. Its exact mechanics:
   - **Row count** (`_getBestLayout`, line 532): try numRows = 1, 2, 3, …; stop at the first
     candidate not better per `_isBetterScaleAndSpace` (line 459) — a weighted tradeoff,
     `LAYOUT_SCALE_WEIGHT = 1` vs `LAYOUT_SPACE_WEIGHT = 0.1` (lines 27–28): prefer bigger
     tiles, break ties toward better area fill. Deterministic hill climb, no randomness.
   - **Ragged fill** (`computeLayout`, line 212): `idealRowWidth = totalWidth / numRows`;
     greedy top-down fill where `_keepSameRow` (line 193) OVERSHOOTS the ideal if that lands
     the row ratio nearer 1.0; the last row absorbs the remainder. For uniform tiles this
     yields rows differing by one (7,2 → 4+3; 8,3 → 3+3+2) — the unevenness is EMERGENT, no
     jitter is added. ONE shipped deviation: GNOME resolves exact ties by float noise (flips
     direction across counts); we tie-overshoot explicitly (epsilon), which is deterministic
     and matches Mission Control's top-heavy fill.
   - **Travel-distance assignment**: windows are assigned to rows sorted by their ORIGINAL
     center y (line 235) and ordered within a row by ORIGINAL center x (`_sortRow`, 206). In
     our model the persisted `stageOrder` plays exactly this role (reading order = the user's
     curated "original arrangement"), so re-layouts preserve relative placement by
     construction.
   - **Placement** (`computeWindowSlots`, line 302): each row centered horizontally
     (line 343), the grid centered vertically (line 344); single row = vertically centered.
2. **KWin "Natural" present-windows** —
   `.repos/kwin-5.24/src/effects/presentwindows/presentwindows.cpp:1321` (the OLD 10.3-era
   Exposé feel): start from real window geometry and iteratively push overlapping pairs apart
   (~10–20px steps along center-to-center vectors, corner-pull to fill the screen aspect).
   **Considered and rejected** for the persistent layout: it has no notion of a stable order,
   so it cannot satisfy "deterministic + only user drags change it". (Its spirit survives in
   the insertion-reflow drag preview.)

**What cannot carry over, stated honestly:** GNOME/Exposé scale each row/window independently
(a 2-tile row renders LARGER than its 4-tile neighbor). Our layout is world-real — stages are
real desktops with fixed dimensions and one camera fits the splay — so per-row scale is
impossible by construction. The organic, non-robotic quality comes entirely from the ragged
centered rows + order-preserving reflow, which for uniform same-size tiles is also all macOS
itself would produce (its remaining unevenness comes from heterogeneous window sizes, an axis
stages don't have). No fake randomness will be added to simulate more.

## Interactions

- **Splay drag:** pointerdown on a stage FRAME (not a window) in canvas mode → stage floats with
  a ghost target cell; other stage frames preview their insertion-reflowed cells; drop commits
  the new order, translates every member surface in ONE store transaction, persists, and
  animates. Reuses the float/ghost/spring-snap patterns from the widget lattice.
- **Camera:** `viewTransform('canvas')` becomes a bounding-box fit of the grid INCLUDING the
  placeholder cell.
- **Navigation:** `enterStage` / ⌘←→ walk reading order, not raw index.

## Stage-bound sidebar (added 2026-06-12)

The left dock currently shows an icon for EVERY open surface in the workspace. It becomes a
**per-stage dock**: it lists only the surfaces attached to `currentStage`, and switching stages
(⌘←→, `enterStage`, clicking a stage in the splay) refreshes it to that stage's set.

- **Membership rule** (one rule, no special cases): a surface belongs to the stage that owns it —
  `slotStage` if slotted; `stageForAgent(agentId)` for agent-bound runtime surfaces (chat);
  otherwise geometric `stageOfPoint` of its center (free windows, minimized windows at their last
  rect, and parked windows, whose park band sits inside their stage's cell gutter, all resolve
  naturally). This is the same membership the splay drag uses to decide what moves with a stage —
  ONE shared helper in the core module, used by both.
- **Mechanics:** Sidebar subscribes to `currentStage` and filters; the existing first-seen
  `orderRef` keyed by surface id already yields stable per-stage ordering across switches. The
  create (+) button stays global — a created surface lands in the current stage, so it appears in
  the dock it was created from.
- **Canvas mode (splay):** `currentStage` is still defined, so the dock keeps showing that
  stage's set; clicking another stage homes into it and the dock refreshes with it.

## Touch points

- `stages-core.mjs` (+ new `stage-splay-core.mjs`), `store.ts` (stageOrder state, `moveStage`,
  hydrate/persist), `App.tsx` (splay drag + placeholder + camera fit),
  `workspace-host.mjs`/`workspace.mjs` (persist/restore/append), `os-tools.mjs`
  (`parkOffstage` → gutter rect; shared with server transport), `preview/backend.mjs` parity,
  `Sidebar.tsx` (stage-bound filtering via the shared membership helper).
- Tests: `node scripts/test-stage-splay-core.mjs` — layout shapes 1..9 pinned against the
  ported algorithm (5 → 2+3, 7 → 3+4, 8 → 3+3+2; rows centered, ragged), row-0 byte-compat,
  insertion reflow, determinism (same inputs → identical layout), order round-trip, invariants
  (no cell overlap; park band ⊂ own cell; stage rect dims preserved).

## Risks / notes

- Moving a stage rewrites x/y on many surfaces → suppress the perception differ for the bulk
  (the `canvasBulkAt` mechanism), or it spams "human moved 30 windows" moments.
- Browser surfaces follow automatically (renderer reports body rects per RAF) — no host changes.
- Stage math must stay in shared `.mjs` cores (CLAUDE.md rule: one source for all transports).
- On ship: update `agent-os/CLAUDE.md` stage bullets + `agent-os-desktop-architecture.md`.
