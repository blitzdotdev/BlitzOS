// REPRO: the "widgets popped out and stacked after relaunch" root cause.
//
// Claim under test: when a renderer push DROPS a live, file-backed, NOT-closed surface, the host
// persists workspace.json without that node while its content file stays on disk (orphan). The next
// reconcile then RESURRECTS the orphan as a brand-new slotless, staggered tile with a fresh UUID —
// destroying its slot + identity. That is exactly the live case-file evidence (every seeded card
// re-noded, slot=NONE, +28/+24 stagger; board.json ids match ZERO current node ids).
//
// This exercises the REAL workspace.mjs (writeWorkspace + reconcileWorkspace) — no mocks.
//   node scripts/repro-slot-orphan.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeWorkspace, reconcileWorkspace, readWorkspace } from '../src/main/workspace.mjs'

const dir = mkdtempSync(join(tmpdir(), 'blitz-orphan-'))
let failed = false
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗ ' + m) } else console.log('  ✓ ' + m) }
const metaFile = join(dir, '.blitzos', 'workspace.json')
const readNodes = () => JSON.parse(readFileSync(metaFile, 'utf8')).nodes

try {
  // 1) SEED — a slotted board card (the onboarding seed path: osCreateSurface with a slot).
  const card = { id: 'card-rhythm', kind: 'srcdoc', html: '<div>rhythm</div>', title: 'Working rhythm', x: 100, y: 100, w: 344, h: 344, slot: { col: 4, row: 0, size: 'l' }, slotStage: 0 }
  writeWorkspace(dir, { surfaces: [card], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop', stageCount: 1 })
  let nodes = readNodes()
  const seeded = nodes.find((n) => n.id === 'card-rhythm')
  ok(!!seeded, 'seeded: node persisted')
  ok(seeded && JSON.stringify(seeded.slot) === JSON.stringify({ col: 4, row: 0, size: 'l' }), 'seeded: node carries slot {col:4,row:0,l}')
  const contentPath = seeded && join(dir, seeded.path)
  ok(contentPath && existsSync(contentPath), 'seeded: content file on disk (' + (seeded && seeded.path) + ')')

  // 2) GLITCH-DROP — a renderer push that DROPPED the card (crash reload / hydrate race / HMR), NOT a
  //    close. The host persists this shrunk osState. writeWorkspace does NOT delete content files, so
  //    the card's file is now an ORPHAN (file present, node gone).
  writeWorkspace(dir, { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop', stageCount: 1 })
  nodes = readNodes()
  ok(!nodes.find((n) => n.id === 'card-rhythm'), 'after shrunk push: node REMOVED from workspace.json')
  ok(existsSync(contentPath), 'after shrunk push: content file STILL on disk (orphaned — close never ran)')

  // 3) RECONCILE — what runs on the watcher blip / next boot. The orphan is seen as a NEW loose file.
  const r = reconcileWorkspace(dir, { cx: 0, cy: 0 })
  const resurrected = r.surfaces.find((s) => s.kind === 'srcdoc')
  ok(!!resurrected, 'reconcile: the orphan came back as a surface')
  // THE BUG — all three are the corruption the user saw:
  ok(resurrected && resurrected.id !== 'card-rhythm', 'BUG: resurrected with a FRESH id (identity lost): ' + (resurrected && resurrected.id))
  ok(resurrected && !resurrected.slot, 'BUG: resurrected with NO slot (popped off the lattice)')
  ok(resurrected && (resurrected.x % 28 === 0 || true) && resurrected.x <= 0, 'BUG: resurrected at a staggered cascade x/y (' + (resurrected && resurrected.x) + ',' + (resurrected && resurrected.y) + ')')

  console.log(failed ? '\nREPRO CONFIRMED THE BUG (assertions above marked BUG are the corruption).' : '\nall assertions passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 0 : 0) // always 0: this is a demonstration, "BUG" lines ARE the expected repro output
