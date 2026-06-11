// Stage placer invariants (plans/blitzos-stage-slot-desktop.md P1) — pure, no display.
// Run: node scripts/test-stage-core.mjs
import { latticeFor, slotRect, findSlot, nearestFreeSlot, occupancy, budgetUsed, stageSummary, flowFiles, spanOf, sizeForDims, sizePx, STAGE_BUDGET, TILE, SIZE_ORDER } from '../src/renderer/src/stage-core.mjs'

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) {
    pass++
  } else {
    fail++
    console.log('  FAIL', m)
  }
}
const VP = { w: 1600, h: 1000 }

// deterministic PRNG (no Math.random — reproducible failures)
let seed = 42
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

// ---- lattice sanity ----
const lat = latticeFor(VP, 0)
ok(lat.cols >= 4 && lat.rows >= 3, `lattice has usable size (got ${lat.cols}x${lat.rows})`)
const r0 = slotRect(lat, 0, 0, 's')
ok(r0.w === TILE && r0.h === TILE, 'S slot is one tile')
ok(sizePx('xl').w === 4 * TILE && sizePx('xl').h === 2 * TILE, 'XL spans 4x2 tiles')
ok(spanOf('garbage').c === 1, 'unknown size falls back to S')
ok(sizeForDims(520, 600) === 'tall', '520x600 (chat) -> tall')
ok(sizeForDims(700, 300) === 'xl', 'wide -> xl')
ok(sizePx('xxl').w === 4 * TILE && sizePx('xxl').h === 4 * TILE, 'XXL spans 4x4 tiles (720x720)')
ok(sizeForDims(700, 700) === 'xxl', 'big both ways -> xxl')
ok(SIZE_ORDER[0] === 's' && SIZE_ORDER[SIZE_ORDER.length - 1] === 'xxl' && SIZE_ORDER.every((n) => spanOf(n)), 'SIZE_ORDER covers valid sizes ascending')
{
  const lat0 = latticeFor(VP, 0)
  const xx = findSlot([], lat0, 'xxl', null, 0)
  ok(!!xx === (lat0.cols >= 4 && lat0.rows >= 4), `xxl placeable iff the lattice is ≥4x4 (${lat0.cols}x${lat0.rows})`)
}

// ---- fuzz: place until full, overlap invariant must hold throughout ----
const sizes = ['s', 'm', 'l', 'xl', 'tall', 'xxl']
for (let trial = 0; trial < 200; trial++) {
  const surfaces = []
  let n = 0
  for (;;) {
    const size = sizes[Math.floor(rnd() * sizes.length)]
    const near = rnd() < 0.3 ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'][Math.floor(rnd() * 5)] : null
    const slot = findSlot(surfaces, lat, size, near, 0)
    if (!slot) break
    surfaces.push({ id: 's' + n++, slot: { ...slot, size }, slotArea: 0 })
    // overlap invariant: total occupied cells === sum of spans (no double-booked cell)
    const occ = occupancy(surfaces, 0)
    const sum = surfaces.reduce((a, s) => a + spanOf(s.slot.size).c * spanOf(s.slot.size).r, 0)
    if (occ.size !== sum) {
      ok(false, `trial ${trial}: overlap! occ=${occ.size} sum=${sum}`)
      break
    }
    if (n > 200) break
  }
  // full: no size fits anymore for at least S? (findSlot returned null for the attempted size — the
  // stage may still fit smaller spans; assert only that S-fits implies findSlot finds it)
  const sFits = findSlot(surfaces, lat, 's', null, 0)
  const occ = occupancy(surfaces, 0)
  ok(sFits !== null || occ.size === lat.cols * lat.rows || occ.size > lat.cols * lat.rows - 1, `trial ${trial}: S only unfittable when grid truly full (occ=${occ.size}/${lat.cols * lat.rows})`)
}
console.log(`fuzz: 200 fill trials done`)

// ---- determinism: same inputs -> same slot ----
{
  const a = findSlot([], lat, 'l', null, 0)
  const b = findSlot([], lat, 'l', null, 0)
  ok(a && b && a.col === b.col && a.row === b.row, 'placement is deterministic')
  ok(a.col === 0 && a.row === 0, 'default scan starts top-left')
}

// ---- near hints ----
{
  const tr = findSlot([], lat, 's', 'top-right', 0)
  ok(tr.col === lat.cols - 1 && tr.row === 0, 'top-right hint lands top-right')
  const br = findSlot([], lat, 's', 'bottom-right', 0)
  ok(br.col === lat.cols - 1 && br.row === lat.rows - 1, 'bottom-right hint lands bottom-right')
  // near a surface id: adjacent placement
  const anchor = { id: 'anchor', slot: { col: 3, row: 1, size: 's' }, slotArea: 0 }
  const adj = findSlot([anchor], lat, 's', 'anchor', 0)
  const d = Math.abs(adj.col - 3) + Math.abs(adj.row - 1)
  ok(d === 1, `near:id places adjacent (dist ${d})`)
}

// ---- nearestFreeSlot: snaps to the cell under a world point, skips occupied ----
{
  const c2 = slotRect(lat, 2, 1, 's')
  const hit = nearestFreeSlot([], lat, 's', c2.x + 90, c2.y + 90, 0)
  ok(hit.col === 2 && hit.row === 1, 'nearestFreeSlot picks the cell under the point')
  const occupied = [{ id: 'x', slot: { col: 2, row: 1, size: 's' }, slotArea: 0 }]
  const next = nearestFreeSlot(occupied, lat, 's', c2.x + 90, c2.y + 90, 0)
  ok(!(next.col === 2 && next.row === 1), 'occupied cell is never offered')
  const dd = Math.abs(next.col - 2) + Math.abs(next.row - 1)
  ok(dd === 1, 'falls to an adjacent free cell')
}

// ---- drag exclusion: a tile may re-snap into its own cells ----
{
  const me = { id: 'me', slot: { col: 1, row: 1, size: 'l' }, slotArea: 0 }
  const sameSpot = nearestFreeSlot([me], lat, 'l', slotRect(lat, 1, 1, 'l').x + 180, slotRect(lat, 1, 1, 'l').y + 180, 0, 'me')
  ok(sameSpot && sameSpot.col === 1 && sameSpot.row === 1, 'excludeId lets a tile drop back onto itself')
}

// ---- budget: pinned exempt, non-pinned counted ----
{
  const surfaces = [
    { id: 'chat', pinned: true, slot: { col: 0, row: 0, size: 'tall' }, slotArea: 0 },
    { id: 'w1', slot: { col: 2, row: 0, size: 'l' }, slotArea: 0 },
    { id: 'w2', slot: { col: 4, row: 0, size: 's' }, slotArea: 0 }
  ]
  ok(budgetUsed(surfaces, 0) === 5, `pinned exempt from budget (got ${budgetUsed(surfaces, 0)})`)
  const sum = stageSummary(surfaces, VP, 0)
  ok(sum.budget.total === STAGE_BUDGET && sum.budget.used === 5 && sum.budget.remaining === STAGE_BUDGET - 5, 'summary budget math')
  ok(sum.tiles.length === 3 && sum.fits.s === true, 'summary lists tiles + fits')
  ok(sum.free_cells === sum.grid.cols * sum.grid.rows - 11, `free_cells accounts spans: tall6+l4+s1=11 (got ${sum.free_cells})`)
}

// ---- area isolation: slots in area 1 do not occupy area 0 ----
{
  const surfaces = [{ id: 'a1', slot: { col: 0, row: 0, size: 'xl' }, slotArea: 1 }]
  ok(occupancy(surfaces, 0).size === 0, 'area-1 tile occupies nothing in area 0')
  ok(occupancy(surfaces, 1).size === 8, 'area-1 tile occupies its own area')
}

// ---- file flow: never under a widget, inside the area, deterministic ----
{
  const widgets = [
    { id: 'w', slot: { col: lat.cols - 2, row: 0, size: 'l' }, slotArea: 0 },
    { id: 'c', pinned: true, slot: { col: 0, row: 0, size: 'tall' }, slotArea: 0 }
  ]
  const files = Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, w: 160, h: 150 }))
  const placed = flowFiles(files, widgets, VP, 0)
  ok(placed.length === 12, 'all files placed')
  const blocked = widgets.map((s) => slotRect(lat, s.slot.col, s.slot.row, s.slot.size))
  const overlapsWidget = placed.some((p) => blocked.some((b) => p.x < b.x + b.w && p.x + 160 > b.x && p.y < b.y + b.h && p.y + 150 > b.y))
  ok(!overlapsWidget, 'no file under a widget tile')
  const again = flowFiles(files, widgets, VP, 0)
  ok(JSON.stringify(placed) === JSON.stringify(again), 'flow is deterministic')
  // fluid: an avoid rect (drag ghost) displaces files that would have sat there
  const ghost = slotRect(lat, lat.cols - 2, 2, 'l')
  const fluid = flowFiles(files, widgets, VP, 0, ghost)
  const underGhost = fluid.some((p) => p.x < ghost.x + ghost.w && p.x + 160 > ghost.x && p.y < ghost.y + ghost.h && p.y + 150 > ghost.y)
  ok(!underGhost, 'avoid rect (drag ghost) displaces files too')
}

// ---- REGRESSION (2026-06-11 video #3, supersedes #1): free-form windows FLOAT — they never block ----
// The desktop is layered like macOS: tiles + icons are the desktop layer, windows float above it
// (z-banded). A free window over the lattice must be INVISIBLE to the placer.
{
  const c21 = slotRect(lat, 2, 1, 's')
  const notepad = { id: 'note', kind: 'native', component: 'note', x: c21.x + 20, y: c21.y + 20, w: 320, h: 300 }
  ok(occupancy([notepad], 0).size === 0, 'a free window reserves NO cells (it floats above)')
  const hit = nearestFreeSlot([notepad], lat, 's', c21.x + 90, c21.y + 90, 0)
  ok(hit && hit.col === 2 && hit.row === 1, 'tiles snap into cells under a free window')
  const file = { id: 'f', kind: 'native', component: 'file', x: c21.x + 20, y: c21.y + 20, w: 160, h: 150 }
  ok(occupancy([file], 0).size === 0, 'file tile reserves no cells either (fluid layer)')
}

// ---- REGRESSION (2026-06-11 video #2): a MINIMIZED tile must not reserve cells (the dead zone) ----
{
  const chat = { id: 'chat', pinned: true, minimized: true, slot: { col: 0, row: 0, size: 'tall' }, slotArea: 0 }
  ok(occupancy([chat], 0, null, lat).size === 0, 'minimized tile frees its span (no dead zone)')
  const tl = nearestFreeSlot([chat], lat, 's', slotRect(lat, 0, 0, 's').x + 90, slotRect(lat, 0, 0, 's').y + 90, 0)
  ok(tl && tl.col === 0 && tl.row === 0, 'top-left is placeable while the chat is minimized')
  ok(budgetUsed([{ ...chat, pinned: false }], 0) === 0, 'minimized tile is off the budget')
  const sum = stageSummary([chat], VP, 0)
  ok(sum.tiles.length === 0 && sum.free_cells === sum.grid.cols * sum.grid.rows, 'summary: minimized tile not on the stage')
  // foldered (groupId) tiles release cells the same way
  const grouped = { id: 'g', slot: { col: 0, row: 0, size: 'l' }, slotArea: 0, groupId: 'folder1' }
  ok(occupancy([grouped], 0, null, lat).size === 0, 'foldered tile frees its span')
  // visible again -> occupies again
  ok(occupancy([{ ...chat, minimized: false }], 0, null, lat).size === 6, 'restored tile re-occupies (6 cells tall)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
