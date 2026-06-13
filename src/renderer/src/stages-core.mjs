// Shared stage-grid geometry — the infinite canvas tiled into screen-sized "stages" (workspace #45).
// PURE math, ZERO deps, so the SAME definition is imported by the renderer (store.ts) AND the
// main-process cores (workspace-host.mjs, os-tools.mjs): there is ONE stage grid, no divergence.
//
// Stage i is centered at i*stageStride in world space; stage 0 is centered at the world origin, so
// stageRect(0,vp) is field-for-field identical to primaryRect(vp) — the invariant that keeps the
// single-stage path byte-identical. An agent N owns stage N (stageForAgent), so an agent's
// windows land in its own stage and never disturb the user's primary (stage 0).

// Fixed-desktop chrome insets (px): the top titlebar, the left dock, the bottom toolbar, right pad.
const SIDEBAR = 52
const TITLEBAR = 32
const TOOLBAR = 64
const RIGHTPAD = 24
// World gap between adjacent stage COLUMNS. Small on purpose: the splay fits the whole lattice
// on screen, so gap is dead space there; desktop mode only needs enough that a neighbor never
// bleeds into the scale-1 frame (max bleed = the 52px sidebar inset).
const STAGE_GAP = 150
// Vertical gutter between stage ROWS — near-uniform with the column gap so the splay reads as
// one tight lattice (the wide-void gutter was the user's #1 visual complaint). It is ALSO each
// stage's park band: cascade STARTS stay inside it (base 24 + 7*24 steps), but parked windows
// are taller than the band, so with a row below they visibly hang over that row's frame in the
// splay. Membership is unaffected (center-nearest), and desktop mode never sees it (parked work
// is below the scale-1 frame by construction).
const PARK_GAP = 200

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

/** World x of stage i's center — the anchor for placing an agent's windows inside its own stage. */
export function stageCenterX(i, vp) {
  const r = stageRect(i, vp)
  return r.x + r.w / 2
}

/** An agent's stage index = its integer id: agent '0' → stage 0 (the user's primary), '1' → 1, …
 *  Non-numeric / falsy ids map to stage 0 (so a stray call never escapes the user's stage). */
export function stageForAgent(agentId) {
  const n = Number(agentId)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Which stage a world point falls in — stage centers are at i*stageStride, so round(centerX/stride). Used to
 *  find an existing window already in a target stage (e.g. dock an agent's terminal into ITS stage). */
export function stageOfX(centerX, vp) {
  const i = Math.round(centerX / stageStride(vp))
  return i > 0 ? i : 0
}

// ---------------------------------------------------------------------------------------------
// Stage splay lattice (plans/blitzos-stage-splay-lattice.md): stages arranged in macOS-style
// RAGGED CENTERED ROWS instead of one endless row. Ported from GNOME Shell's
// UnalignedLayoutStrategy (.repos/gnome-shell/js/ui/workspace.js — the reverse-engineered
// Mission Control lineage): greedy fill toward an ideal row width with the overshoot rule
// (_keepSameRow), rows centered on a common axis, deterministic row-count hill climb.
// ONE deviation, documented: GNOME breaks scale ties with a 0.1-weighted "space" term that
// only behaves because its row spacing is SCREEN-constant chrome; our gaps are WORLD-
// proportional, which makes that term always prefer vertical stacking (degenerate for 2
// stages). We require STRICT tile-scale improvement to add a row instead.
//
// The layout always includes ONE extra slot: the "create new stage" placeholder is a real
// layout citizen (user decision), so world positions never depend on whether the splay UI is
// open. Reading order maps `stageOrder[orderIndex] = stageId`; the placeholder is orderIndex
// `count` (last). A 1-row layout reproduces the legacy `i * stageStride` row byte-for-byte.

/** GNOME's _keepSameRow, uniform-width specialization: rows of tiles per row for n tiles. */
export function splayRows(layoutCount, numRows) {
  const n = Math.max(0, Math.round(layoutCount))
  if (!n) return []
  const rows = []
  const ideal = n / numRows
  let placed = 0
  for (let r = 0; r < numRows; r++) {
    if (r === numRows - 1) {
      rows.push(n - placed)
      break
    }
    let k = 0
    for (;;) {
      const grown = k + 1
      if (placed + grown > n) break
      if (grown <= ideal) {
        k = grown
        continue
      }
      // overshoot if it lands the row NEARER the ideal — the ragged rule. Ties overshoot
      // EXPLICITLY (epsilon): GNOME leaves ties to float noise, which flips direction across
      // counts; tie-overshoot is deterministic and matches Mission Control's top-heavy fill
      // (7 windows → 4 over 3, 5 → 3 over 2).
      if (Math.abs(1 - grown / ideal) <= Math.abs(1 - k / ideal) + 1e-9) {
        k = grown
        continue
      }
      break
    }
    k = Math.max(1, k)
    rows.push(k)
    placed += k
  }
  return rows.filter((k) => k > 0)
}

/** Vertical distance between stage-row centers: stage height + the park-band gutter. */
export function stagePitchY(vp) {
  return primaryRect(vp).h + PARK_GAP
}

/** The splay layout for `count` REAL stages (+1 placeholder slot, always): row sizes + pitches.
 *  Row count = deterministic hill climb maximizing the fitted tile scale (strict improvement). */
export function splayLayout(count, vp) {
  const layoutCount = Math.max(1, Math.round(count)) + 1 // + the create-stage placeholder slot
  const pitchX = stageStride(vp)
  const pitchY = stagePitchY(vp)
  let best = null
  for (let nr = 1; nr <= layoutCount; nr++) {
    const rows = splayRows(layoutCount, nr)
    const gridW = Math.max(...rows) * pitchX - STAGE_GAP
    const gridH = nr * pitchY - PARK_GAP
    const scale = Math.min(vp.w / gridW, vp.h / gridH)
    if (best && scale <= best.scale) break
    best = { rows, scale }
  }
  return { rows: best.rows, pitchX, pitchY, count: layoutCount }
}

/** World rect of the cell at READING-ORDER index `orderIndex` in the layout (rows centered on the
 *  widest row's axis; 1-row layouts reproduce the legacy row exactly). */
export function splaySlotRect(orderIndex, count, vp) {
  const { rows, pitchX, pitchY } = splayLayout(count, vp)
  const r = primaryRect(vp)
  const maxRowW = Math.max(...rows) * pitchX - STAGE_GAP
  let row = 0
  let idx = Math.max(0, Math.min(orderIndex, rows.reduce((a, b) => a + b, 0) - 1))
  while (idx >= rows[row]) {
    idx -= rows[row]
    row++
  }
  const rowW = rows[row] * pitchX - STAGE_GAP
  const offsetX = (maxRowW - rowW) / 2
  return { x: offsetX + idx * pitchX - r.w / 2, y: row * pitchY - r.h / 2, w: r.w, h: r.h }
}

/** World rect of stage `id` under reading order `order` (identity when order is absent). */
export function orderedStageRect(id, vp, order, count) {
  const n = Math.max(1, Math.round(count ?? (Array.isArray(order) ? order.length : 0) ?? 1))
  const orderIndex = Array.isArray(order) && order.length ? order.indexOf(id) : id
  return splaySlotRect(orderIndex < 0 ? id : orderIndex, n, vp)
}

/** World rect of the "create new stage" placeholder — the layout's last slot. */
export function addStageRect(vp, count) {
  const n = Math.max(1, Math.round(count))
  return splaySlotRect(n, n, vp)
}

/** Each stage's park band: the gutter strip below its stage rect, inside its own cell — where
 *  off-stage work surfaces park (outside the desktop frame, attached to their stage at zoom-out). */
export function parkBandRect(id, vp, order, count) {
  const r = orderedStageRect(id, vp, order, count)
  return { x: r.x, y: r.y + r.h, w: r.w, h: PARK_GAP }
}

/** Which REAL stage owns a world point. ROW = catchment region, not nearest center: a row owns
 *  everything from its stage TOP down to the NEXT row's top (the stage + its whole gutter), so
 *  parked windows hanging below a stage stay ITS members even when the gutter is tight and their
 *  centers sit nearer the next row. Surface callers should pass a TOP-ish y (surfaceStage does).
 *  COLUMN stays nearest-center. The placeholder slot and empty space clamp to a real cell. */
export function stageOfPoint(cx, cy, vp, order, count) {
  const n = Math.max(1, Math.round(count ?? (Array.isArray(order) ? order.length : 1)))
  const { rows, pitchX, pitchY } = splayLayout(n, vp)
  const r0 = primaryRect(vp)
  const maxRowW = Math.max(...rows) * pitchX - STAGE_GAP
  const row = Math.max(0, Math.min(rows.length - 1, Math.floor((cy + r0.h / 2) / pitchY)))
  const rowW = rows[row] * pitchX - STAGE_GAP
  const offsetX = (maxRowW - rowW) / 2
  let col = Math.max(0, Math.min(rows[row] - 1, Math.round((cx - offsetX) / pitchX)))
  let orderIndex = 0
  for (let r = 0; r < row; r++) orderIndex += rows[r]
  orderIndex += col
  orderIndex = Math.max(0, Math.min(n - 1, orderIndex)) // clamp the placeholder slot away
  return Array.isArray(order) && order.length ? (order[orderIndex] ?? orderIndex) : orderIndex
}

/** THE stage-membership rule, shared by the splay drag (what moves with a stage) and the
 *  per-stage sidebar (what docks for the current stage): explicit slot stage, else the owning
 *  agent's stage (chat widgets), else geometric — the cell owning the surface's center. */
export function surfaceStage(s, vp, order, count) {
  if (s.slotStage != null) return s.slotStage
  if (s.slot && s.slotStage == null) return 0
  if (s.role === 'chat') return s.agentId != null ? stageForAgent(s.agentId) : 0
  // TOP-center probe: a parked window belongs to the stage it hangs FROM (its top sits in that
  // stage's cell or gutter), regardless of how far its body reaches toward the next row.
  return stageOfPoint(s.x + (s.w || 0) / 2, s.y, vp, order, count)
}

/** Insertion reflow (iOS-home-screen semantics): the dragged stage inserts at the target order
 *  index and everything between shifts one slot. Pure; returns a NEW order array. */
export function insertAt(order, from, to) {
  const next = order.slice()
  const [moved] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved)
  return next
}

/** Identity order for `count` stages — the migration default when workspace.json has none. */
export function identityOrder(count) {
  return Array.from({ length: Math.max(1, Math.round(count)) }, (_, i) => i)
}
