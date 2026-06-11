// Shared area-grid geometry — the infinite canvas tiled into screen-sized "areas" (workspace #45).
// PURE math, ZERO deps, so the SAME definition is imported by the renderer (store.ts) AND the
// main-process cores (workspace-host.mjs, os-tools.mjs): there is ONE area grid, no divergence.
//
// Area i is centered at i*areaStride in world space; area 0 is centered at the world origin, so
// areaRect(0,vp) is field-for-field identical to primaryRect(vp) — the invariant that keeps the
// single-area path byte-identical. A chat session N owns area N (areaForSession), so a session's
// windows land in its own area and never disturb the user's primary (area 0).

// Fixed-desktop chrome insets (px): the top titlebar, the left dock, the bottom toolbar, right pad.
const SIDEBAR = 64
const TITLEBAR = 32
const TOOLBAR = 64
const RIGHTPAD = 24
// World gap between adjacent areas (only ever visible once there is more than one area).
const AREA_GAP = 1200

// A reasonable default viewport for code paths that must place a surface before the renderer has
// pushed the real viewport (e.g. the host building a chat widget on boot). Corrects on first sendState.
export const DEFAULT_VP = { w: 1600, h: 1000 }

/** The primary workspace area in WORLD coords = the on-screen desktop region (below the titlebar,
 *  right of the dock, above the toolbar). At scale 1 it maps 1:1 to that region. */
export function primaryRect(vp) {
  const w = Math.max(320, vp.w - SIDEBAR - RIGHTPAD)
  const h = Math.max(240, vp.h - TITLEBAR - TOOLBAR)
  return { x: -w / 2, y: -h / 2, w, h }
}

/** Width of one area tile + the inter-area gap (the world distance between adjacent area centers). */
export function areaStride(vp) {
  return primaryRect(vp).w + AREA_GAP
}

/** Area i's bounds in world coords. areaRect(0,vp) === primaryRect(vp) (single-area byte-identity). */
export function areaRect(i, vp) {
  const r = primaryRect(vp)
  return { x: i * areaStride(vp) - r.w / 2, y: -r.h / 2, w: r.w, h: r.h }
}

/** World x of area i's center — the anchor for placing a session's windows inside its own area. */
export function areaCenterX(i, vp) {
  const r = areaRect(i, vp)
  return r.x + r.w / 2
}

/** A chat session's area index = its integer id: session '0' → area 0 (the user's primary), '1' → 1, …
 *  Non-numeric / falsy ids map to area 0 (so a stray call never escapes the user's area). */
export function areaForSession(sessionId) {
  const n = Number(sessionId)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Which area a world point falls in — area centers are at i*areaStride, so round(centerX/stride). Used to
 *  find an existing window already in a target area (e.g. dock a session's terminal into ITS area). */
export function areaOfX(centerX, vp) {
  const i = Math.round(centerX / areaStride(vp))
  return i > 0 ? i : 0
}
