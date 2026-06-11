// Stage slot lattice — the PURE half of the slotted desktop (plans/blitzos-stage-slot-desktop.md).
// Zero deps, zero I/O, so the SAME placer runs in the renderer (drag snap, file flow), Electron main
// (os-tools place_widget), and the server backend — one placement algorithm, no divergence. This is
// the stages-core.mjs pattern: pure shared geometry.
//
// The model is reverse-engineered from macOS (see the plan): widgets sit at integer (col,row) cells
// of an edge-to-edge 180pt-pitch lattice; the visible card is the tile inset 8pt per side; spans are
// S=1x1, M=2x1, L=2x2, XL=4x2 (+ TALL=2x3, ours, for the chat hub). Occupied spans are simply never
// offered, which is the whole never-reflow / never-overlap guarantee. The lattice lives INSIDE a
// workspace stage's rect (stages-core stageRect), centered, so slot -> world x/y is a pure function and
// x/y/w/h stay the rendering+persistence truth (slots re-derive them on viewport change).

import { stageRect } from './stages-core.mjs'

export const TILE = 180 // cell pitch, edge-to-edge (Apple's exact metric)
export const CARD_INSET = 8 // visible card inset per side (16pt visible gap between neighbors)

/** Slot size name -> span in cells. Agent-facing names; TALL is internal (the chat hub). */
export const SPANS = {
  s: { c: 1, r: 1 },
  m: { c: 2, r: 1 },
  l: { c: 2, r: 2 },
  xl: { c: 4, r: 2 },
  tall: { c: 2, r: 3 },
  xxl: { c: 4, r: 4 } // 720×720 full-focus hero (ours, like tall)
}

/** Size cycle order for the human ⌃⌥=/− keybind — ascending by stage, wrapping. */
export const SIZE_ORDER = ['s', 'm', 'l', 'tall', 'xl', 'xxl']

/** Soft attention budget in S-cell units for NON-PINNED slotted tiles (pinned system UI — the chat
 *  hub — is exempt). Past this, place_widget returns stage_full and the agent must evict or queue.
 *  16 = exactly ONE xxl full-focus hero (a legitimate single-surface stage), or e.g. an XL + an L +
 *  an M + two S — sized so the largest tile is placeable while doctrine + stage_full still police
 *  clutter (the lattice itself caps the worst case on small screens). */
export const STAGE_BUDGET = 16

export function spanOf(size) {
  return SPANS[String(size || '').toLowerCase()] || SPANS.s
}

/** Pixel size of a slot span (the tile/window footprint; the visible card is -2*CARD_INSET). */
export function sizePx(size) {
  const sp = spanOf(size)
  return { w: sp.c * TILE, h: sp.r * TILE }
}

/** The lattice inside stage `i`: integer cols/rows that fit the stage rect, centered (equal margins).
 *  Returns { stage, cols, rows, x, y } where (x,y) is the world top-left of cell (0,0). */
export function latticeFor(vp, stage = 0) {
  const r = stageRect(stage, vp || { w: 1600, h: 1000 })
  const cols = Math.max(2, Math.floor(r.w / TILE))
  const rows = Math.max(2, Math.floor(r.h / TILE))
  return { stage, cols, rows, x: r.x + (r.w - cols * TILE) / 2, y: r.y + (r.h - rows * TILE) / 2 }
}

/** World rect of a span at (col,row) — the TILE footprint (renderer insets the card by CARD_INSET). */
export function slotRect(lat, col, row, size) {
  const sp = spanOf(size)
  return { x: lat.x + col * TILE, y: lat.y + row * TILE, w: sp.c * TILE, h: sp.r * TILE }
}

/** The VISIBLE CARD rect of a span: the tile inset CARD_INSET per side (Apple's model — tiles touch
 *  edge-to-edge, cards show a 2*CARD_INSET gap). This is what a slotted surface's x/y/w/h derive from. */
export function cardRect(lat, col, row, size) {
  const r = slotRect(lat, col, row, size)
  return { x: r.x + CARD_INSET, y: r.y + CARD_INSET, w: r.w - 2 * CARD_INSET, h: r.h - 2 * CARD_INSET }
}

/** A surface's slot, normalized, or null. Accepts {slot:{col,row,size}} with integer cells. */
export function slotOf(s) {
  const sl = s && s.slot
  if (!sl || typeof sl !== 'object') return null
  const col = Number(sl.col)
  const row = Number(sl.row)
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || row < 0) return null
  return { col, row, size: SPANS[String(sl.size || '').toLowerCase()] ? String(sl.size).toLowerCase() : 's' }
}

/** Occupancy set "col,row" of every cell covered by slotted surfaces in `stage` (excluding excludeId).
 *  FREE-FORM windows do NOT block: the desktop is layered like macOS — tiles + file icons are the
 *  desktop layer, free windows FLOAT ABOVE it (z-banded in the renderer) — so a tile snapping "under"
 *  a window simply sits behind it, exactly like a window over desktop widgets. */
export function occupancy(surfaces, stage = 0, excludeId = null) {
  const occ = new Set()
  for (const s of surfaces || []) {
    if (!s || s.id === excludeId) continue
    if (s.minimized || s.groupId) continue // an INVISIBLE tile must not reserve cells (the top-left dead-zone bug: a minimized chat kept its 2x3 span); restore re-places if its span got taken
    if ((s.slotStage ?? 0) !== stage) continue
    const sl = slotOf(s)
    if (!sl) continue
    const sp = spanOf(sl.size)
    for (let c = sl.col; c < sl.col + sp.c; c++) for (let r = sl.row; r < sl.row + sp.r; r++) occ.add(c + ',' + r)
  }
  return occ
}

function spanFree(occ, lat, col, row, sp) {
  if (col < 0 || row < 0 || col + sp.c > lat.cols || row + sp.r > lat.rows) return false
  for (let c = col; c < col + sp.c; c++) for (let r = row; r < row + sp.r; r++) if (occ.has(c + ',' + r)) return false
  return true
}

/** Budget used (in S-cell units) by non-pinned slotted surfaces in `stage`. */
export function budgetUsed(surfaces, stage = 0) {
  let used = 0
  for (const s of surfaces || []) {
    if (!s || s.pinned) continue
    if (s.minimized || s.groupId) continue // off the stage = off the budget (mirrors occupancy)
    if ((s.slotStage ?? 0) !== stage) continue
    const sl = slotOf(s)
    if (!sl) continue
    const sp = spanOf(sl.size)
    used += sp.c * sp.r
  }
  return used
}

// Scan-order preference per `near` hint: which corner the search radiates from.
const NEAR_ORDER = {
  'top-left': (lat, c, r) => r * lat.cols + c,
  'top-right': (lat, c, r) => r * lat.cols + (lat.cols - 1 - c),
  'bottom-left': (lat, c, r) => (lat.rows - 1 - r) * lat.cols + c,
  'bottom-right': (lat, c, r) => (lat.rows - 1 - r) * lat.cols + (lat.cols - 1 - c),
  center: (lat, c, r) => {
    const dc = c + 0.5 - lat.cols / 2
    const dr = r + 0.5 - lat.rows / 2
    return dc * dc + dr * dr
  }
}

/**
 * First free span for `size` in scan order. `near` is an edge/corner hint ('top-left' | 'top-right' |
 * 'bottom-left' | 'bottom-right' | 'center'), a surface id (place adjacent to it), or omitted
 * (top-left reading order). Returns {col,row} or null when no span fits (the stage is spatially full).
 */
export function findSlot(surfaces, lat, size, near = null, stage = 0, excludeId = null) {
  const occ = occupancy(surfaces, stage, excludeId)
  const sp = spanOf(size)
  // near = a surface id -> nearest free span to that surface's slot center
  if (near && !NEAR_ORDER[near]) {
    const anchor = (surfaces || []).find((s) => s && s.id === near && slotOf(s) && (s.slotStage ?? 0) === stage)
    if (anchor) {
      const a = slotOf(anchor)
      const asp = spanOf(a.size)
      const ax = a.col + asp.c / 2
      const ay = a.row + asp.r / 2
      let best = null
      let bestD = Infinity
      for (let r = 0; r <= lat.rows - sp.r; r++)
        for (let c = 0; c <= lat.cols - sp.c; c++) {
          if (!spanFree(occ, lat, c, r, sp)) continue
          const d = (c + sp.c / 2 - ax) ** 2 + (r + sp.r / 2 - ay) ** 2
          if (d < bestD) {
            bestD = d
            best = { col: c, row: r }
          }
        }
      return best
    }
  }
  const rank = NEAR_ORDER[near] || NEAR_ORDER['top-left']
  let best = null
  let bestK = Infinity
  for (let r = 0; r <= lat.rows - sp.r; r++)
    for (let c = 0; c <= lat.cols - sp.c; c++) {
      if (!spanFree(occ, lat, c, r, sp)) continue
      const k = rank(lat, c, r)
      if (k < bestK) {
        bestK = k
        best = { col: c, row: r }
      }
    }
  return best
}

/** Free span nearest a WORLD point (drag snap: the outline ghost's cell). Null when none fits. */
export function nearestFreeSlot(surfaces, lat, size, wx, wy, stage = 0, excludeId = null) {
  const occ = occupancy(surfaces, stage, excludeId)
  const sp = spanOf(size)
  let best = null
  let bestD = Infinity
  for (let r = 0; r <= lat.rows - sp.r; r++)
    for (let c = 0; c <= lat.cols - sp.c; c++) {
      if (!spanFree(occ, lat, c, r, sp)) continue
      const rect = slotRect(lat, c, r, size)
      const dx = rect.x + rect.w / 2 - wx
      const dy = rect.y + rect.h / 2 - wy
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = { col: c, row: r }
      }
    }
  return best
}

/** Best slot size for a free-form w/h (bring_to_stage of a surface that has no size argument). */
export function sizeForDims(w, h) {
  const ww = Number(w) || TILE
  const hh = Number(h) || TILE
  if (ww > 3 * TILE && hh > 3 * TILE) return 'xxl' // decisively big BOTH ways (>540): the full-focus hero — the chat's 520×600 stays tall
  if (hh > 2.5 * TILE && hh >= ww) return 'tall' // portrait first (the chat hub shape)
  if (ww > 2.5 * TILE) return 'xl'
  if (ww > 1.5 * TILE) return hh > 1.5 * TILE ? 'l' : 'm'
  return 's'
}

/** The agent-facing stage summary for list_state: lattice, occupancy, budget, free space. */
export function stageSummary(surfaces, vp, stage = 0) {
  const lat = latticeFor(vp, stage)
  const occ = occupancy(surfaces, stage)
  const used = budgetUsed(surfaces, stage)
  const slotted = []
  for (const s of surfaces || []) {
    if (!s || s.minimized || s.groupId || (s.slotStage ?? 0) !== stage) continue
    const sl = slotOf(s)
    if (sl) slotted.push({ id: s.id, title: s.title, col: sl.col, row: sl.row, size: sl.size, pinned: !!s.pinned })
  }
  const fits = {}
  for (const name of Object.keys(SPANS)) fits[name] = !!findSlot(surfaces, lat, name, null, stage)
  return {
    stage,
    grid: { cols: lat.cols, rows: lat.rows, tile: TILE },
    occupied_cells: occ.size,
    free_cells: lat.cols * lat.rows - occ.size,
    budget: { used, total: STAGE_BUDGET, remaining: Math.max(0, STAGE_BUDGET - used) },
    fits,
    tiles: slotted
  }
}

/** Flow file/folder tiles around the slotted widgets — macOS's fluid icon layer. Pure: returns
 *  [{id, x, y}] placements on a fine icon grid (column-major from the stage's top-RIGHT, like the Mac
 *  desktop), skipping any icon cell whose rect intersects a slotted tile or the avoid rect (the
 *  in-flight drag ghost). Sizes come from each file surface's own w/h. */
export function flowFiles(files, surfaces, vp, stage = 0, avoid = null) {
  const r = stageRect(stage, vp || { w: 1600, h: 1000 })
  const lat = latticeFor(vp, stage)
  const blocked = []
  for (const s of surfaces || []) {
    if (!s || s.minimized || s.groupId || (s.slotStage ?? 0) !== stage) continue
    const sl = slotOf(s)
    if (sl) blocked.push(slotRect(lat, sl.col, sl.row, sl.size))
  }
  if (avoid) blocked.push(avoid)
  const PAD = 10
  const hit = (x, y, w, h) => blocked.some((b) => x < b.x + b.w + PAD && x + w + PAD > b.x && y < b.y + b.h + PAD && y + h + PAD > b.y)
  const out = []
  // column-major from top-right: fill a column downward, then step one column-width left.
  let colRight = r.x + r.w - 16
  let colW = 0
  let y = r.y + 16
  for (const f of files || []) {
    const w = Math.min(Number(f.w) || 160, r.w - 32)
    const h = Math.min(Number(f.h) || 150, r.h - 32)
    let placed = false
    let guard = 0
    while (!placed && guard++ < 400) {
      if (y + h > r.y + r.h - 16) {
        // next column to the LEFT
        colRight -= (colW || w) + 14
        colW = 0
        y = r.y + 16
        if (colRight - w < r.x + 16) break // stage exhausted — leave remaining at last position
      }
      const x = colRight - w
      if (hit(x, y, w, h)) {
        y += 24 // slide down past the obstruction in fine steps
      } else {
        out.push({ id: f.id, x: Math.round(x), y: Math.round(y) })
        y += h + 14
        colW = Math.max(colW, w)
        placed = true
      }
    }
    if (!placed) out.push({ id: f.id, x: Math.round(r.x + 16), y: Math.round(r.y + 16) })
  }
  return out
}
