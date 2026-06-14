# BlitzOS compositor hardening (overlapping browsers + multi-widget glitch)

Subplan of `blitzos-sandwich-compositor.md`. Goal: make the two-window sandwich robust under
arbitrary overlapping live browsers and many DOM widgets, with a STRUCTURAL fix, not patches.
Grounded in two Opus investigations (code audit + reference-browser precedent), 2026-06-13.

## Bugs (from the user's screen recordings)

1. **Browser-on-browser bleed-through.** When one browser overlaps another, the TOP browser shows the
   BOTTOM page through it wherever the top page leaves areas unpainted (a centered column's margins, a
   short page). The L0 view order is CORRECT (top is on top); the views are just see-through.
2. **Multi-browser chaos.** With 3+ overlapping browsers the bleed layers up: page fragments appear in
   wrong regions, the screen "glitches." Same root cause as 1, compounded.
3. **Whole-renderer glitch with many widgets beneath a browser.** Not just the pages: the entire DOM UI
   stutters/tears when several DOM widgets sit under a browser.

## Root cause: one disease, three symptoms

- **Symptom 1/2 = guest-page transparency.** Electron's `webPreferences.transparent` DEFAULTS TO TRUE
  for a guest page (`electron.d.ts:17148`: "the background will remain transparent"). The host never
  set `transparent:false`, so Blink composited every page WITH ALPHA; unpainted regions are see-through.
  `view.setBackgroundColor('#fff')` sets the native layer color but does NOT defeat guest-page alpha
  (the documented caveat), so the earlier patch was insufficient.
- **Symptom 3 = an uncoordinated per-frame recompute + repaint storm.** The renderer drives all page
  geometry and z through N INDEPENDENT per-surface RAFs (`SurfaceFrame.tsx:281-321`, one loop per web
  surface), each calling `getBoundingClientRect()` + `getComputedStyle().zIndex` every frame (forced
  layout/style flush), while every DOM frame's `pageHolesClip` + `overlapsWeb` selectors and the
  screen-space `bgHolesClip` and per-stage `sceneryClip` re-scan ALL surfaces on EVERY zustand
  `setState` (a drag is a continuous stream of setStates). The full-viewport opaque `.bg` div carries a
  `clip-path` that changes every camera frame and is NOT GPU-promoted, forcing a whole-viewport raster
  repaint per frame. All of this lands on one renderer main thread; the L0 pages (reconciled in main,
  "one RAF behind") then fall behind the clip holes the stuttering renderer draws, which reads as
  tearing/glitching across the whole screen.
- **z-order race (compounds 2/3).** Because each surface reports its own z on its own RAF, the host's
  `reorderViews` (`webcontents-view-host.ts`) sorts a mix of fresh and stale `e.z`, so the wrong view
  can be on top for up to one frame during a drag. There is no single global ordering transaction.

## Decision: harden model (a), do NOT change the architecture

The reference browsers (`.repos/min`, `.repos/browser-base`) both structurally AVOID overlap: exactly
one live content view per window, every other tab a `capturePage` snapshot. That is robust but it would
break BlitzOS's core premise (many simultaneously-live, panned-away, overlapping pages the agent needs).
The sandwich's clip-path-for-DOM-occlusion is the one mechanism that escapes the rectangular-bounds
limit (a `WebContentsView` can only be a rectangle, so it cannot express the L-shape of a partially
covered page). So: keep overlapping live opaque views + strict z-order, and make THAT correct and cheap.

## The fix: three pillars

### Pillar 1 — opaque-view invariant. DONE (verified to compile/build).

`transparent: false` in the WebContentsView `webPreferences` at construction
(`webcontents-view-host.ts`), with `setBackgroundColor('#fff')` kept only as the pre-paint flash color.
This is the entire fix for bugs 1 and 2 (the bleed). Needs your live confirm (a page that overlaps
another should now be opaque white where it does not paint, occluding the lower page).

### Pillar 2 — one coalesced geometry+order transaction (replaces N per-surface RAFs). DONE (commit 2a5f3b8).

The per-surface RAF loops are replaced by a SINGLE App-level rAF (`App.tsx`) that reads EVERY browser
hole by `data-sid`, computes z from `store.effectiveZ` (no `getComputedStyle` flush), and pushes ONE
message (`os:web-geometry`, the ordered list of `{id, rect, z, visible, zoom}`). Main applies all bounds
and reorders the L0 child views ONCE (`applyWebGeometry`; `applyEntry` split into `applyEntryBounds` +
`reorderViews`). This removes the cross-surface z-staleness race, the W independent forced-layout RAFs,
and the per-`applyEntry` reorder churn: one reader, one message, one reorder per frame. Needs the user's
overlap eye test (no display in CI).

### Pillar 3 — cheapen the clip + repaint (the rest of bug 3). DONE (commit 2a5f3b8).

- **No clip when there is no page to clip around.** `pageHolesClip` / `bgHolesClip` return `undefined`
  when their hole set is empty, so a non-overlapping widget gets NO `clip-path` at all (off the clip /
  repaint layer; its CSS `border-radius` still rounds it). A browser over a field of widgets no longer
  puts every one on a repaint path. (The existing AABB `continue` already prunes non-overlapping pairs
  inside the loop; the empty-set early-out is what removes the trivial full-rect clip layer.)
- **Stop full-viewport raster repaints.** The full-viewport `.bg` is GPU-promoted (`transform:
  translateZ(0)`, `styles.css`), so its per-camera-frame `clip-path` change is an isolated solid-color
  raster on its own layer instead of a whole-viewport main-thread repaint.
- Deferred (only if the eye test still shows cost): hoisting the per-frame hole computation out of each
  DOM surface's zustand selector into one memoized derived value. The early-out above already keeps the
  selector body cheap for the common (non-overlapping) case, so this was not needed for the fix.

### Pillar 4 — OSR/snapshots, surgical only. FOLLOW-UP, optional.

Use offscreen-render / `capturePage` frames (model d) ONLY off the live path: parked surfaces, the
zoomed-out Control Mode bird's-eye, and telemetry (the plan already notes L1 `capturePage` excludes
pages). Never for the focused, interactive, overlapping foreground pages.

## macOS sharp edges to preserve (do not regress in any of this)

Hide-by-position not `setVisible` (the blank-after-show wedge); the force-parented L1/L0 pair (macOS
occlusion-culls a covered standalone window); integer view bounds (`Math.round`, already applied).

## Verify

Pillars 2/3 are renderer + main geometry changes; verify with: `npm run typecheck` + `npm run build`;
the headless control-API / CDP path for view placement; and the user's eye for the overlap + the
many-widgets-under-a-browser drag (the glitch). Pillar 1 is the bleed fix and needs the overlap eye test.
