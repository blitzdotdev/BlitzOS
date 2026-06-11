// Shared stage-grid geometry — the infinite canvas tiled into screen-sized "stages" (workspace #45).
// PURE math, ZERO deps, so the SAME definition is imported by the renderer (store.ts) AND the
// main-process cores (workspace-host.mjs, os-tools.mjs): there is ONE stage grid, no divergence.
//
// Stage i is centered at i*stageStride in world space; stage 0 is centered at the world origin, so
// stageRect(0,vp) is field-for-field identical to primaryRect(vp) — the invariant that keeps the
// single-stage path byte-identical. A chat session N owns stage N (stageForSession), so a session's
// windows land in its own stage and never disturb the user's primary (stage 0).

// Fixed-desktop chrome insets (px): the top titlebar, the left dock, the bottom toolbar, right pad.
const SIDEBAR = 52
const TITLEBAR = 32
const TOOLBAR = 64
const RIGHTPAD = 24
// World gap between adjacent stages (only ever visible once there is more than one stage).
const STAGE_GAP = 1200

// A reasonable default viewport for code paths that must place a surface before the renderer has
// pushed the real viewport (e.g. the host building a chat widget on boot). Corrects on first sendState.
export const DEFAULT_VP = { w: 1600, h: 1000 }

/** The primary workspace stage in WORLD coords = the on-screen desktop region (below the titlebar,
 *  right of the dock, above the toolbar). At scale 1 it maps 1:1 to that region. */
export function primaryRect(vp) {
  const w = Math.max(320, vp.w - SIDEBAR - RIGHTPAD)
  const h = Math.max(240, vp.h - TITLEBAR - TOOLBAR)
  return { x: -w / 2, y: -h / 2, w, h }
}

/** Width of one stage tile + the inter-stage gap (the world distance between adjacent stage centers). */
export function stageStride(vp) {
  return primaryRect(vp).w + STAGE_GAP
}

/** Stage i's bounds in world coords. stageRect(0,vp) === primaryRect(vp) (single-stage byte-identity). */
export function stageRect(i, vp) {
  const r = primaryRect(vp)
  return { x: i * stageStride(vp) - r.w / 2, y: -r.h / 2, w: r.w, h: r.h }
}

/** World x of stage i's center — the anchor for placing a session's windows inside its own stage. */
export function stageCenterX(i, vp) {
  const r = stageRect(i, vp)
  return r.x + r.w / 2
}

/** A chat session's stage index = its integer id: session '0' → stage 0 (the user's primary), '1' → 1, …
 *  Non-numeric / falsy ids map to stage 0 (so a stray call never escapes the user's stage). */
export function stageForSession(sessionId) {
  const n = Number(sessionId)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Which stage a world point falls in — stage centers are at i*stageStride, so round(centerX/stride). Used to
 *  find an existing window already in a target stage (e.g. dock a session's terminal into ITS stage). */
export function stageOfX(centerX, vp) {
  const i = Math.round(centerX / stageStride(vp))
  return i > 0 ? i : 0
}
