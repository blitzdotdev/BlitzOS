// Home slot lattice invariants (plans/blitzos-single-canvas-navigation.md) — pure, no display, no stages.
// The single bounded "home" region holds ONE lattice; every placer call is stage-free.
// Run: node scripts/tests/test-stage-core.mjs
import { latticeFor, slotRect, findSlot, nearestFreeSlot, occupancy, budgetUsed, gridSummary, flowFiles, spanOf, sizeForDims, sizePx, HOME_BUDGET, TILE, SIZE_ORDER } from '../../src/renderer/src/stage-core.mjs'
import { homeRect } from '../../src/renderer/src/stages-core.mjs'

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

// ---- lattice sanity: the lattice lives INSIDE the single home rect ----
const lat = latticeFor(VP)
ok(lat.cols >= 4 && lat.rows >= 3, `lattice has usable size (got ${lat.cols}x${lat.rows})`)
{
  const r = homeRect(VP)
  ok(lat.x >= r.x && lat.y >= r.y && lat.x + lat.cols * TILE <= r.x + r.w + 0.5 && lat.y + lat.rows * TILE <= r.y + r.h + 0.5, 'lattice is centered inside homeRect (no spill)')
}
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
  const xx = findSlot([], lat, 'xxl', null)
  ok(!!xx === (lat.cols >= 4 && lat.rows >= 4), `xxl placeable iff the lattice is ≥4x4 (${lat.cols}x${lat.rows})`)
}

// ---- fuzz: place until full, overlap invariant must hold throughout ----
const sizes = ['s', 'm', 'l', 'xl', 'tall', 'xxl']
for (let trial = 0; trial < 200; trial++) {
  const surfaces = []
  let n = 0
  for (;;) {
    const size = sizes[Math.floor(rnd() * sizes.length)]
    const near = rnd() < 0.3 ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'][Math.floor(rnd() * 5)] : null
    const slot = findSlot(surfaces, lat, size, near)
    if (!slot) break
    surfaces.push({ id: 's' + n++, slot: { ...slot, size } })
    // overlap invariant: total occupied cells === sum of spans (no double-booked cell)
    const occ = occupancy(surfaces)
    const sum = surfaces.reduce((a, s) => a + spanOf(s.slot.size).c * spanOf(s.slot.size).r, 0)
    if (occ.size !== sum) {
      ok(false, `trial ${trial}: overlap! occ=${occ.size} sum=${sum}`)
      break
    }
    if (n > 200) break
  }
  // full: no size fits anymore for at least S? (findSlot returned null for the attempted size — home
  // may still fit smaller spans; assert only that S-fits implies findSlot finds it)
  const sFits = findSlot(surfaces, lat, 's', null)
  const occ = occupancy(surfaces)
  ok(sFits !== null || occ.size === lat.cols * lat.rows || occ.size > lat.cols * lat.rows - 1, `trial ${trial}: S only unfittable when home truly full (occ=${occ.size}/${lat.cols * lat.rows})`)
}
console.log(`fuzz: 200 fill trials done`)

// ---- determinism: same inputs -> same slot ----
{
  const a = findSlot([], lat, 'l', null)
  const b = findSlot([], lat, 'l', null)
  ok(a && b && a.col === b.col && a.row === b.row, 'placement is deterministic')
  ok(a.col === 0 && a.row === 0, 'default scan starts top-left')
}

// ---- near hints ----
{
  const tr = findSlot([], lat, 's', 'top-right')
  ok(tr.col === lat.cols - 1 && tr.row === 0, 'top-right hint lands top-right')
  const br = findSlot([], lat, 's', 'bottom-right')
  ok(br.col === lat.cols - 1 && br.row === lat.rows - 1, 'bottom-right hint lands bottom-right')
  // near a surface id: adjacent placement
  const anchor = { id: 'anchor', slot: { col: 3, row: 1, size: 's' } }
  const adj = findSlot([anchor], lat, 's', 'anchor')
  const d = Math.abs(adj.col - 3) + Math.abs(adj.row - 1)
  ok(d === 1, `near:id places adjacent (dist ${d})`)
}

// ---- nearestFreeSlot: snaps to the cell under a world point, skips occupied ----
{
  const c2 = slotRect(lat, 2, 1, 's')
  const hit = nearestFreeSlot([], lat, 's', c2.x + 90, c2.y + 90)
  ok(hit.col === 2 && hit.row === 1, 'nearestFreeSlot picks the cell under the point')
  const occupied = [{ id: 'x', slot: { col: 2, row: 1, size: 's' } }]
  const next = nearestFreeSlot(occupied, lat, 's', c2.x + 90, c2.y + 90)
  ok(!(next.col === 2 && next.row === 1), 'occupied cell is never offered')
  const dd = Math.abs(next.col - 2) + Math.abs(next.row - 1)
  ok(dd === 1, 'falls to an adjacent free cell')
}

// ---- drag exclusion: a tile may re-snap into its own cells ----
{
  const me = { id: 'me', slot: { col: 1, row: 1, size: 'l' } }
  const sameSpot = nearestFreeSlot([me], lat, 'l', slotRect(lat, 1, 1, 'l').x + 180, slotRect(lat, 1, 1, 'l').y + 180, 'me')
  ok(sameSpot && sameSpot.col === 1 && sameSpot.row === 1, 'excludeId lets a tile drop back onto itself')
}

// ---- budget: pinned exempt, non-pinned counted ----
{
  const surfaces = [
    { id: 'chat', pinned: true, slot: { col: 0, row: 0, size: 'tall' } },
    { id: 'w1', slot: { col: 2, row: 0, size: 'l' } },
    { id: 'w2', slot: { col: 4, row: 0, size: 's' } }
  ]
  ok(budgetUsed(surfaces) === 5, `pinned exempt from budget (got ${budgetUsed(surfaces)})`)
  const sum = gridSummary(surfaces, VP)
  ok(sum.budget.total === HOME_BUDGET && sum.budget.used === 5 && sum.budget.remaining === HOME_BUDGET - 5, 'summary budget math')
  ok(sum.tiles.length === 3 && sum.fits.s === true, 'summary lists tiles + fits')
  ok(sum.free_cells === sum.grid.cols * sum.grid.rows - 11, `free_cells accounts spans: tall6+l4+s1=11 (got ${sum.free_cells})`)
  ok(sum.occupied_cells === 11, 'summary occupied_cells = sum of spans')
  // gridSummary carries NO stage field anymore (single home region).
  ok(!('stage' in sum) && Number.isInteger(sum.grid.cols) && Number.isInteger(sum.grid.rows) && sum.grid.tile === TILE, 'summary shape is home-only {grid,occupied_cells,free_cells,budget,fits,tiles}')
}

// ---- gridSummary.fits is honest: it mirrors findSlot for EVERY size, on real occupancy ----
{
  // a half-occupied home: fits[size] must equal "findSlot returns a span" for each size, no lies.
  const occupied = [
    { id: 'a', slot: { col: 0, row: 0, size: 'xxl' } },
    { id: 'b', slot: { col: 4, row: 0, size: 'l' } }
  ]
  const sum = gridSummary(occupied, VP)
  for (const name of ['s', 'm', 'l', 'xl', 'tall', 'xxl']) {
    ok(sum.fits[name] === (findSlot(occupied, lat, name, null) !== null), `fits.${name} mirrors findSlot`)
  }
  // saturate home with S tiles → eventually even S stops fitting and fits.s flips false.
  const sats = []
  for (let i = 0; ; i++) {
    const s = findSlot(sats, lat, 's', null)
    if (!s) break
    sats.push({ id: 'f' + i, slot: { ...s, size: 's' } })
    if (i > 200) break
  }
  ok(gridSummary(sats, VP).fits.s === false, 'a fully-tiled home reports fits.s === false (no free span)')
}

// ---- file flow: never under a widget, inside home, deterministic ----
{
  const widgets = [
    { id: 'w', slot: { col: lat.cols - 2, row: 0, size: 'l' } },
    { id: 'c', pinned: true, slot: { col: 0, row: 0, size: 'tall' } }
  ]
  const files = Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, w: 160, h: 150 }))
  const placed = flowFiles(files, widgets, VP)
  ok(placed.length === 12, 'all files placed')
  const blocked = widgets.map((s) => slotRect(lat, s.slot.col, s.slot.row, s.slot.size))
  const overlapsWidget = placed.some((p) => blocked.some((b) => p.x < b.x + b.w && p.x + 160 > b.x && p.y < b.y + b.h && p.y + 150 > b.y))
  ok(!overlapsWidget, 'no file under a widget tile')
  const again = flowFiles(files, widgets, VP)
  ok(JSON.stringify(placed) === JSON.stringify(again), 'flow is deterministic')
  // every placed icon sits inside home
  const r = homeRect(VP)
  ok(placed.every((p) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h), 'every file icon lands inside home')
  // fluid: an avoid rect (drag ghost) displaces files that would have sat there
  const ghost = slotRect(lat, lat.cols - 2, 2, 'l')
  const fluid = flowFiles(files, widgets, VP, ghost)
  const underGhost = fluid.some((p) => p.x < ghost.x + ghost.w && p.x + 160 > ghost.x && p.y < ghost.y + ghost.h && p.y + 150 > ghost.y)
  ok(!underGhost, 'avoid rect (drag ghost) displaces files too')
}

// ---- REGRESSION (2026-06-11 video #3): free-form windows FLOAT — they never block the placer ----
// The desktop is layered like macOS: tiles + icons are the desktop layer, windows float above it.
// A free window over the lattice must be INVISIBLE to the placer.
{
  const c21 = slotRect(lat, 2, 1, 's')
  const notepad = { id: 'note', kind: 'native', component: 'note', x: c21.x + 20, y: c21.y + 20, w: 320, h: 300 }
  ok(occupancy([notepad]).size === 0, 'a free window reserves NO cells (it floats above)')
  const hit = nearestFreeSlot([notepad], lat, 's', c21.x + 90, c21.y + 90)
  ok(hit && hit.col === 2 && hit.row === 1, 'tiles snap into cells under a free window')
  const file = { id: 'f', kind: 'native', component: 'file', x: c21.x + 20, y: c21.y + 20, w: 160, h: 150 }
  ok(occupancy([file]).size === 0, 'file tile reserves no cells either (fluid layer)')
}

// ---- REGRESSION (2026-06-11 video #2): a MINIMIZED tile must not reserve cells (the dead zone) ----
{
  const chat = { id: 'chat', pinned: true, minimized: true, slot: { col: 0, row: 0, size: 'tall' } }
  ok(occupancy([chat]).size === 0, 'minimized tile frees its span (no dead zone)')
  const tl = nearestFreeSlot([chat], lat, 's', slotRect(lat, 0, 0, 's').x + 90, slotRect(lat, 0, 0, 's').y + 90)
  ok(tl && tl.col === 0 && tl.row === 0, 'top-left is placeable while the chat is minimized')
  ok(budgetUsed([{ ...chat, pinned: false }]) === 0, 'minimized tile is off the budget')
  const sum = gridSummary([chat], VP)
  ok(sum.tiles.length === 0 && sum.free_cells === sum.grid.cols * sum.grid.rows, 'summary: minimized tile not on home')
  // foldered (groupId) tiles release cells the same way
  const grouped = { id: 'g', slot: { col: 0, row: 0, size: 'l' }, groupId: 'folder1' }
  ok(occupancy([grouped]).size === 0, 'foldered tile frees its span')
  // visible again -> occupies again
  ok(occupancy([{ ...chat, minimized: false }]).size === 6, 'restored tile re-occupies (6 cells tall)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
