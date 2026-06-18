// Shared home-grid geometry — the single bounded region ("home") on the infinite canvas
// (plans/blitzos-single-canvas-navigation.md). PURE math, ZERO deps, so the SAME definition is
// imported by the renderer (store.ts) AND the main-process cores (workspace-host.mjs, os-tools.mjs):
// there is ONE home rect, no divergence.
//
// Home is the computed scale-1 frame: the on-screen desktop region below the titlebar, right of the
// dock, above the toolbar. The slot lattice (stage-core.mjs) lives INSIDE this rect; off-home is open
// canvas where web/app windows park (parkBandRect, the gutter strip just below home).

// Fixed-desktop chrome insets (px): the top titlebar, the left dock, the bottom toolbar, right pad.
const SIDEBAR = 52
const TITLEBAR = 32
const TOOLBAR = 64
const RIGHTPAD = 24
// Vertical gutter below home where off-home work surfaces park (outside the scale-1 frame, visible
// when the user zooms out). Parked windows can be taller than the band, so they visibly hang below
// home at zoom-out; that is fine, the band only anchors the cascade START.
const PARK_GAP = 200

// A reasonable default viewport for code paths that must place a surface before the renderer has
// pushed the real viewport (e.g. the host building a chat widget on boot). Corrects on first sendState.
export const DEFAULT_VP = { w: 1600, h: 1000 }

/** Home in WORLD coords = the on-screen desktop region (below the titlebar, right of the dock, above
 *  the toolbar), centered on the world origin. At scale 1 it maps 1:1 to that region. */
export function homeRect(vp) {
  const w = Math.max(320, vp.w - SIDEBAR - RIGHTPAD)
  const h = Math.max(240, vp.h - TITLEBAR - TOOLBAR)
  return { x: -w / 2, y: -h / 2, w, h }
}

/** The park band: the gutter strip directly below home, where off-home work surfaces park (outside
 *  the desktop frame, visible when the user zooms out). */
export function parkBandRect(vp) {
  const home = homeRect(vp)
  return { x: home.x, y: home.y + home.h, w: home.w, h: PARK_GAP }
}
