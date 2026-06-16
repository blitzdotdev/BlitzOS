// Stage splay lattice core tests (plans/blitzos-stage-splay-lattice.md).
// Pure math — run with: node scripts/test-stage-splay-core.mjs
import {
  DEFAULT_VP,
  primaryRect,
  stageRect,
  stageStride,
  splayRows,
  splayLayout,
  splaySlotRect,
  orderedStageRect,
  addStageRect,
  parkBandRect,
  stageOfPoint,
  surfaceStage,
  insertAt,
  identityOrder
} from '../../src/renderer/src/stages-core.mjs'

let failures = 0
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const vp = DEFAULT_VP

// --- Ragged row shapes: pinned against the ported algorithm at DEFAULT_VP. layout = count+1. ---
const expected = {
  1: [2], // 1 real stage + placeholder = today's row, byte-compat
  2: [2, 1],
  3: [2, 2],
  4: [3, 2], // MC pyramid: top-heavy ragged
  5: [3, 3],
  6: [2, 2, 3],
  7: [3, 3, 2],
  8: [3, 3, 3]
}
for (const [count, rows] of Object.entries(expected)) {
  const got = splayLayout(Number(count), vp).rows
  check(`rows count=${count} → ${JSON.stringify(rows)}`, eq(got, rows), `got ${JSON.stringify(got)}`)
}

// Raggedness is real: at least one multi-row count yields UNEVEN rows.
check(
  'uneven rows exist (not an even grid)',
  Object.values(expected).some((rows) => rows.length > 1 && new Set(rows).size > 1)
)

// Determinism: same inputs, identical layout.
check('deterministic', eq(splayLayout(6, vp), splayLayout(6, vp)))

// Row conservation: every layout places exactly layoutCount tiles, every row non-empty.
for (let c = 1; c <= 30; c++) {
  const { rows, count } = splayLayout(c, vp)
  if (rows.reduce((a, b) => a + b, 0) !== count || rows.some((k) => k < 1)) {
    check(`row conservation count=${c}`, false, JSON.stringify(rows))
  }
}
check('row conservation 1..30', true)

// --- Row-0 byte-compat: single-row layouts reproduce the legacy stage row exactly. ---
{
  const legacy = [stageRect(0, vp), stageRect(1, vp)]
  const now = [orderedStageRect(0, vp, [0], 1), addStageRect(vp, 1)]
  check('row-0 compat: stage 0 ≡ legacy', eq(now[0], legacy[0]), JSON.stringify(now[0]))
  check('row-0 compat: placeholder ≡ legacy stage 1', eq(now[1], legacy[1]), JSON.stringify(now[1]))
}

// --- Centering: in a ragged layout, each row is centered on the widest row's axis. ---
{
  const count = 3 // rows [2,2] — even; use 6 → [2,2,3]
  const { rows, pitchX } = splayLayout(6, vp)
  const r = primaryRect(vp)
  const centers = []
  let idx = 0
  for (let row = 0; row < rows.length; row++) {
    const xs = []
    for (let k = 0; k < rows[row]; k++, idx++) {
      const rect = splaySlotRect(idx, 6, vp)
      xs.push(rect.x + rect.w / 2)
    }
    centers.push((Math.min(...xs) + Math.max(...xs)) / 2)
  }
  const axis = centers[0]
  check(
    'rows centered on a common axis',
    centers.every((c) => Math.abs(c - axis) < 0.001),
    JSON.stringify(centers)
  )
  check('pitchX = legacy stageStride', pitchX === stageStride(vp))
  void count
  void r
}

// --- No two cells overlap (incl. the placeholder), park bands stay inside their own cell. ---
{
  for (const count of [1, 2, 4, 6, 8]) {
    const rects = []
    for (let i = 0; i <= count; i++) rects.push(splaySlotRect(i, count, vp))
    let overlap = false
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) {
        const A = rects[a]
        const B = rects[b]
        if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) overlap = true
      }
    if (overlap) check(`no cell overlap count=${count}`, false)
    // park band: directly below its stage, never poking into ANOTHER stage rect
    for (let i = 0; i < count; i++) {
      const band = parkBandRect(i, vp, identityOrder(count), count)
      const mine = rects[i]
      if (band.x !== mine.x || band.y !== mine.y + mine.h) check(`park band attached i=${i} count=${count}`, false)
      for (let b = 0; b <= count; b++) {
        if (b === i) continue
        const B = rects[b]
        if (band.x < B.x + B.w && B.x < band.x + band.w && band.y < B.y + B.h && B.y < band.y + band.h)
          check(`park band clear of cells i=${i} count=${count}`, false)
      }
    }
  }
  check('cells disjoint + park bands in-gutter (counts 1,2,4,6,8)', true)
}

// --- stageOfPoint: each stage's center maps back to its id, under a permuted order; the
// placeholder cell and far-away points clamp to a REAL stage. ---
{
  const count = 5
  const order = [2, 0, 4, 1, 3]
  let roundtrip = true
  for (const id of order) {
    const r = orderedStageRect(id, vp, order, count)
    if (stageOfPoint(r.x + r.w / 2, r.y + r.h / 2, vp, order, count) !== id) roundtrip = false
  }
  check('stageOfPoint roundtrip under permuted order', roundtrip)
  const ph = addStageRect(vp, count)
  const clamped = stageOfPoint(ph.x + ph.w / 2, ph.y + ph.h / 2, vp, order, count)
  check('placeholder cell clamps to a real stage', order.includes(clamped), String(clamped))
  // park-band point belongs to its own stage (membership of parked windows): the row CATCHMENT
  // spans stage top → next row's top, so anywhere in the gutter resolves to the stage above it
  const band = parkBandRect(4, vp, order, count)
  check('park-band point owned by its stage', stageOfPoint(band.x + band.w / 2, band.y + 120, vp, order, count) === 4)
  // a TALL parked window (taller than the gutter, hanging over the next row) still belongs to the
  // stage it hangs from — surfaceStage probes the TOP edge, never the (next-row-leaning) center
  const tall = { x: band.x + 60, y: band.y + 24, w: 900, h: 700 }
  check('tall parked window owned by its stage', surfaceStage(tall, vp, order, count) === 4)
}

// --- surfaceStage precedence: slotStage > chat agent > geometry. ---
{
  const order = identityOrder(3)
  const r1 = orderedStageRect(1, vp, order, 3)
  check('surfaceStage slotStage wins', surfaceStage({ x: r1.x, y: r1.y, w: 10, h: 10, slot: { col: 0, row: 0, size: 's' }, slotStage: 2 }, vp, order, 3) === 2)
  check('surfaceStage chat → agent stage', surfaceStage({ x: r1.x, y: r1.y, w: 10, h: 10, role: 'chat', agentId: '2' }, vp, order, 3) === 2)
  check('surfaceStage geometric', surfaceStage({ x: r1.x + 10, y: r1.y + 10, w: 100, h: 80 }, vp, order, 3) === 1)
}

// --- insertAt: iOS insertion semantics, pure. ---
check('insertAt forward', eq(insertAt([0, 1, 2, 3], 0, 2), [1, 2, 0, 3]))
check('insertAt backward', eq(insertAt([0, 1, 2, 3], 3, 0), [3, 0, 1, 2]))
check('insertAt noop', eq(insertAt([0, 1, 2], 1, 1), [0, 1, 2]))
check('insertAt pure', (() => { const o = [0, 1, 2]; insertAt(o, 0, 2); return eq(o, [0, 1, 2]) })())
check('identityOrder', eq(identityOrder(3), [0, 1, 2]))

// --- splayRows unit: the ported greedy on raw (n, numRows). ---
check('splayRows(7,2) = [4,3] (MC top-heavy)', eq(splayRows(7, 2), [4, 3]))
check('splayRows(5,2) = [3,2]', eq(splayRows(5, 2), [3, 2]))
check('splayRows(8,3) = [3,3,2]', eq(splayRows(8, 3), [3, 3, 2]))

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall stage-splay-core tests passed')
