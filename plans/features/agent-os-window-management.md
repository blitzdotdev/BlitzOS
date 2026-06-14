# Agent OS Window Management: Tiling Layout Engine

**Status:** Proposed (for review). Not started.
**Date:** 2026-06-06
**Parent:** `agent-os-desktop-architecture.md` (this operationalizes the unbuilt "Arrange modes" backlog in its §6 and the `POST /canvas/arrange {tile}` stub in §3.2).
**Code touched (proposed):** `src/renderer/src/store.ts`, a new `src/renderer/src/layout/`, `src/renderer/src/types.ts`, `src/main/osActions.ts`, `src/main/agentSocket.ts`, `src/main/control-server.ts`, `src/main/blitzos-agents.md`.

---

## 1. Problem: window management is bad today

The agent hand-computes absolute pixels and nothing reflows. From the current code:

- **New surfaces cascade and pile up.** `createSurface` staggers each new surface diagonally by `(n*34, n*30)` and wraps every 7 (`store.ts:188`). Overlap is the default behavior.
- **Default sizes do not fit side by side.** web/app default to 920x640 (`store.ts:96`) on a ~1440-wide viewport. Two defaults already exceed the width, so the "Journal | Triage | Discord" three-column intent recorded in the iJewel journal is geometrically impossible at default sizes. The agent picks pixels blind to the real viewport and chrome insets.
- **Nothing prevents window overlap.** `desktopClamp` only keeps the title bar grabbable (`store.ts:33`). Overlap rejection exists only for ground-plane widgets (`commitPos`, `store.ts:171`, via `overlaps()` on `WIDGET_W/H`), never for surfaces.
- **No tiling, no repack.** Adding or closing a surface reflows nothing. `toggleMaximize` is all-or-nothing fill (`store.ts:238`). There are no halves, quadrants, or tiles.

This is the same anti-pattern as the autonomy waker: the agent managing low-level state (here, pixels) that an engine should own. It forces per-session, per-surface geometry guessing that cannot reflow.

## 2. Principle: intent in, geometry out

The agent emits **intent** (what is primary, what is secondary, what is ambient). A **layout engine** owns geometry: no overlap, fills the stage, reflows on add and remove, and honors per-surface minimum sizes. The agent never sends `x/y/w/h` for a tiled surface.

Cmd+Z layout undo already exists (`snapshotLayout`/`undoLayout`, `store.ts:296`), so the engine can auto-apply layouts aggressively; the human reverts a bad arrangement with one gesture.

## 3. Strategy survey (what real window managers do)

| Strategy | Examples | Fit for an agent-driven, human-watched desktop |
| --- | --- | --- |
| Floating / stacking | macOS, Windows | The status quo. Flexible but overlaps and needs manual placement. This is the failure. |
| BSP tiling | bspwm, yabai, i3 containers | Screen is a binary tree; each window splits a region, close merges the sibling, resize adjusts a split ratio. Zero overlap, neighbor-aware resize. Topology is implicit, so it is wrong to expose to the agent, but it is the right **engine substrate**. |
| Dynamic named layouts | dwm, xmonad, Amethyst, Pop!_OS | A few functions arrange N windows: master-stack, monocle, grid, spiral. The agent picks a layout plus a master. Auto-reflows, predictable, trivial to drive. **Best fit for the agent-facing API.** |
| Scrollable / columnar | PaperWM, niri, Cardboard | Windows live in an infinite horizontal strip of columns, never overlap, never shrink below readable; the viewport scrolls to the focused column. Maps 1:1 onto the dormant canvas substrate plus planned follow mode. |
| Curated stage | macOS Stage Manager | One group center-stage, the rest as side thumbnails, system-promoted. Almost verbatim the "curated bounded stage plus promote-to-stage" model. Good for curation, weak for simultaneous multi-window. |
| Snap zones / templates | FancyZones, Rectangle, Win11 Snap Layouts | Fixed templates (halves, thirds, 70/30, quad). Easy to target, but rigid as count changes. A fallback vocabulary, not the whole engine. |

**Takeaway:** drive the agent with **dynamic named layouts** (importance, not topology), compute geometry with a **BSP-style engine**, and render the same intent as **bounded tiles** (desktop mode) or a **scrollable strip** (canvas mode + follow).

## 4. Recommended architecture

### 4.1 Three layers

1. **Geometry engine** (pure, renderer-side): `computeLayout(model, stageRect, constraints) -> Map<id, Rect>`. No agent or human concept of a tree. Deterministic, no overlap.
2. **Agent API** (declarative roles + named layouts): the agent expresses a desired state; never pixels.
3. **Renderer** (two modes off `store.mode`): `desktop` paints the rects as bounded tiles; `canvas` paints the same roles as a column strip and scrolls to focus (follow mode).

The engine interface is stable; its internals can start as direct rect math and later become a real BSP tree without changing the agent API or the store wiring (so Phase 1 is not throwaway, see §7).

### 4.2 The layout model (new store state)

```ts
type SurfaceId = string
type LayoutName = 'monocle' | 'master-stack' | 'columns' | 'grid'

interface LayoutModel {
  layout: LayoutName        // active named layout
  order: SurfaceId[]        // tiled surfaces in priority order; order[0] = master
  stashed: SurfaceId[]      // ambient, off-stage (not painted on the stage)
  floating: SurfaceId[]     // free x/y/w/h, painted above the tiles
  masterRatio: number       // 0.5..0.8, master weight for master-stack / columns
}
```

A tiled surface's `x/y/w/h` become **derived** (engine output). Floating surfaces keep free geometry. The `Surface` descriptor and `SurfaceFrame` rendering are unchanged: the store still writes `x/y/w/h` into `surfaces[]`, the engine just computes them.

### 4.3 The geometry engine

`computeLayout(model, stageRect, constraints)`:

- `stageRect` = viewport minus the existing chrome insets (`SIDEBAR 52`, `TITLEBAR 32`, `TOOLBAR 64`, `store.ts:26-29`).
- A `GAP` constant separates tiles.
- Returns `{ id -> {x,y,w,h} }` for tiled surfaces only.

Named-layout math (Phase 1, direct; Phase 2, as tree shapes):

- **monocle:** `order[0]` fills `stageRect`; `order[1..]` are treated as stashed (Phase 2: tabbed strip across the top).
- **master-stack:** master = left column of width `stageRect.w * masterRatio`; the stack = the remaining width split into equal vertical rows for `order[1..]`.
- **columns:** N equal columns (master-weighted if `masterRatio != 1/N`).
- **grid:** `cols = ceil(sqrt(N))`, balanced rows; alternate split direction (the bspwm "balance" shape).

### 4.4 Named layouts come from roles, not from the agent building a tree

The agent does not construct trees or pick splits. It sets `{layout, order, master, stashed}` and the engine **generates** the arrangement. This is the core ergonomic decision: the agent thinks in importance ("Discord is primary, triage second, HN ambient"), which is exactly `order` + `stashed` + a `layout` name. The BSP tree (Phase 2) is an internal representation that earns precise resize and arbitrary nesting; it is never the agent's mental model.

### 4.5 Size constraints and auto-stash (no cramming)

Add per-kind minimum and preferred sizes (extend `defaultSize`, `store.ts:93`):

- note: min 180x140, pref 240x240
- srcdoc: min 280x200, pref 420x320
- web / app: min 480x360, pref 920x640

The engine computes a **capacity** for the chosen layout from the minimums versus `stageRect`. If `order.length` exceeds capacity, the lowest-priority surfaces beyond capacity are moved to `stashed` and the move is surfaced (a dock badge: "3 stashed", and a log line; never a silent truncation). The agent can `unstash` or switch to a roomier layout. This is what stops a post-it tiling to 900px and a Discord cramming below readable.

### 4.6 Desktop vs canvas rendering (one model, two renderers)

- **`desktop` (Phase 1):** engine tiles inside `stageRect`. Bounded, macOS-like, the case that hurts today.
- **`canvas` (Phase 3):** the same `order` renders as a PaperWM-style horizontal column strip on the infinite substrate; `focus(id)` animates the viewport so that column is centered (this is "follow mode" from the parent plan). Stash = park far down the strip. No new agent concepts; only the renderer differs.

### 4.7 Floating exceptions and human interaction

- **Floating layer:** notes and small widgets can float above the tiled layer (every real tiling WM keeps a floating escape hatch). `floating[]` surfaces keep free `x/y/w/h`.
- **Human drag of a tiled window (Phase 1):** pops it to `floating` (a clear "I want this loose" gesture). Phase 2: drag-onto-another-tile = swap (i3 style).
- **Human resize:** Phase 1 floats then resizes. Phase 2: dragging the divider between two tiles adjusts the shared split ratio (`masterRatio` for master-stack).
- **Cmd+Z:** reverts the last `arrange`. The undo stack snapshots the `LayoutModel` (intent), so undo restores intent, not just pixels; geometry is re-derived. Reuse the 600ms coalescing and depth-12 cap already in `snapshotLayout`.

## 5. Agent API (new control-plane verbs)

One idempotent, declarative verb plus convenience shortcuts, added to `osActions.ts` and exposed over both transports (`agentSocket.ts`, `control-server.ts`):

- `arrange { layout?, focus?, stash?: id[], unstash?: id[], float?: id[] }` — set the desired layout state in one call. Idempotent: the agent describes the end state, the engine makes it so and reflows.
- `focus { id }` — make `id` the master (move to `order[0]`); apply the default layout if none is set.
- `stash { id }` / `unstash { id }` — move to or from the ambient set.

Changes to existing tools:
- `create_surface` no longer needs `x/y` for a tiled surface; it is appended to `order` (or becomes master if it is the first) and the engine places it. `x/y/w/h` remain valid only for an explicitly floating surface.
- `move_surface` / `update_surface` geometry on a **tiled** surface floats it (Phase 1) rather than fighting the engine. On a **floating** surface it is a free move as today.

Documentation: rewrite the "Manage the layout" section of `blitzos-agents.md` (currently §62-68, which tells the agent to read `x/y/w/h` from `list_state` and move/resize/close by hand) to: express intent via `arrange`/`focus`/`stash`, the engine tiles without overlap, you never compute pixels, master is whatever matters most right now, overflow auto-stashes so unstash when it becomes relevant, the human reverts with Cmd+Z. Mirror the change in the `blitzos` skill if it references manual placement.

## 6. Integration with existing code

- **`store.ts`:** add `layoutModel` to state; add `arrange`/`focus`/`stash`/`unstash` actions that mutate the model and call a single `recompute()` that runs `computeLayout` and writes derived `x/y/w/h` into `surfaces[]`. `createSurface` inserts into `order` instead of cascading. `moveSurface`/`resizeSurface` float-on-touch for tiled ids. `toggleMaximize` becomes `layout('monocle')` for that surface. Extend the undo snapshot to capture `layoutModel`.
- **`layout/engine.ts` (new):** pure `computeLayout` + capacity logic + size constraints. Unit-testable without Electron.
- **`types.ts`:** `LayoutModel`, `LayoutName`, per-kind min/pref sizes.
- **`osActions.ts`:** new action types flowing through the existing `os:action` IPC to the renderer store (same pattern as today, the control plane stays the single mutation chokepoint).
- **`agentSocket.ts` / `control-server.ts`:** register `arrange`/`focus`/`stash` tools; update `tools.json`.
- **`blitzos-agents.md` + skill:** the doc rewrite above.

## 7. Phasing

- **Phase 1 (bounded tiling MVP):** the engine (`monocle`, `master-stack`, `columns`, `grid`) in `desktop` mode, size-aware auto-stash, the `arrange`/`focus`/`stash` tools, the doc rewrite. Direct rect math behind the stable `computeLayout` interface. This kills the cascade and ships the fix. The iJewel case becomes `arrange({ focus: discord, layout: 'master-stack', stash: [hackerNews] })`.
- **Phase 2 (BSP power substrate):** replace the engine internals with a real BSP tree (ported from bspwm/yabai) for arbitrary nesting, draggable split-bar resize, and swap-on-drop. No change to the agent API or store wiring.
- **Phase 3 (canvas strip + follow mode):** the scrollable-column renderer for `canvas` mode, `focus(id)` scrolls the viewport. This activates the dormant substrate and the follow-mode seam from the parent plan.

## 8. Open decisions (for your review)

1. **MVP order (the main fork).** I recommend **bounded tiling first** (Phase 1), since that is where the pain is today and it ships value immediately, then the canvas strip in Phase 3. The alternative is to leapfrog straight to the scrollable strip because it is the more differentiated long-term bet. My call: bounded-first. Flip it here if you disagree.
2. **Human drag of a tiled window:** float-on-drag (my pick, simplest and predictable) vs swap-on-drop from day one.
3. **monocle siblings:** auto-stash (Phase 1) vs a tabbed strip from the start.
4. **Animation and `<webview>` reflow cost:** tiling animations resize live webviews, which repaint. Animate via CSS transition and settle the final size, or debounce. Ties to the parent plan's Path A perf risk (§3.4). Decide how much animation polish is in Phase 1.

## 9. Risks

- **Heterogeneous surfaces** (a 240px note next to a 920px web app) tile awkwardly; the min/pref plus auto-stash policy mitigates, but very mixed sets may look better in stage or strip mode. Watch during Phase 1.
- **Webview resize jank** at many tiles (see §8.4).
- **No layout persistence** still (parent plan notes this); the `LayoutModel` is in-memory and a restart clears it. The journal records intent textually, not geometry. Out of scope here; flag if persistence should come with this work.
- **Reconciling `goToPrimary` / `focusAndZoom`** with tiling: in `desktop` mode these should defer to the engine (focus raises and re-tiles rather than free-centering).

## 10. References to port from (clone into `.repos/` when building)

- **bspwm** (`github.com/baskerville/bspwm`): `tree.c` for insert, remove-and-merge, balance, rotate. The canonical BSP ops.
- **yabai** (`github.com/koekeishiya/yabai`): macOS BSP context; window tree and view management.
- **i3 / sway:** container taxonomy (splith, splitv, tabbed, stacked) for the layout vocabulary.
- **xmonad:** `Tall` is the reference master-stack algorithm; `XMonad.Layout.*` for grid and spiral.
- **PaperWM** (`github.com/paperwm/PaperWM`) and **niri** (`github.com/YaLTeR/niri`): scrollable strip and scroll-to-focus for Phase 3.
