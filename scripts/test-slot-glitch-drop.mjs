// Regression test for the "every widget popped out and stacked after relaunch" root cause.
//
// onStatePush does a wholesale setState. A renderer push that DROPPED a live file-backed surface (a
// render-process-gone reload, a hydrate race, an HMR remount) would otherwise persist the shrink to
// workspace.json; writeWorkspace never deletes content files, so the dropped node's file ORPHANS and
// the next reconcile RESURRECTS it as a fresh slotless, staggered tile (see scripts/repro-slot-orphan.mjs
// for the bare mechanism). The fix: onStatePush re-asserts a file-backed surface that vanished from a push
// but was NOT closed and whose content file is STILL on disk (a glitch-drop, not a removal).
//
// This drives the REAL workspace host (createWorkspaceHost) with a fake adapter.
//   node scripts/test-slot-glitch-drop.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceHost } from '../src/main/workspace-host.mjs'

const root = mkdtempSync(join(tmpdir(), 'blitz-glitch-'))
let failed = false
const ok = (c, m) => { if (!c) { failed = true; console.error('  ✗ ' + m) } else console.log('  ✓ ' + m) }

try {
  let osState = { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop', stageCount: 1, stageOrder: [0], view: { cx: 0, cy: 0 } }
  const host = createWorkspaceHost({
    root,
    initialName: 'Home',
    getState: () => osState,
    setState: (s) => { osState = s },
    broadcast: () => {},
    defaultMode: 'desktop'
  })
  const wsDir = host.activePath()
  const metaFile = join(wsDir, '.blitzos', 'workspace.json')
  const nodes = () => { try { return JSON.parse(readFileSync(metaFile, 'utf8')).nodes } catch { return [] } }
  const card = { id: 'card-rhythm', kind: 'srcdoc', html: '<div>rhythm</div>', title: 'Working rhythm', x: 100, y: 100, w: 344, h: 344, slot: { col: 4, row: 0, size: 'l' }, slotStage: 0, props: {} }

  // SEED: the card is live in osState; persist it (the onboarding seed steady state).
  osState = { ...osState, surfaces: [card] }
  host.flush()
  let seeded = nodes().find((n) => n.id === 'card-rhythm')
  ok(!!seeded && JSON.stringify(seeded.slot) === JSON.stringify({ col: 4, row: 0, size: 'l' }), 'seed: node persisted WITH slot')
  const contentPath = seeded && join(wsDir, seeded.path)
  ok(contentPath && existsSync(contentPath), 'seed: content file on disk')

  // GLITCH-DROP: a renderer push that LOST the card (crash reload / hydrate race), NOT a close.
  host.onStatePush({ surfaces: [] })
  host.flush()
  const afterGlitch = nodes().find((n) => n.id === 'card-rhythm')
  ok(!!afterGlitch, 'FIX: node SURVIVES a glitch-drop push (re-asserted, not orphaned)')
  ok(afterGlitch && JSON.stringify(afterGlitch.slot) === JSON.stringify({ col: 4, row: 0, size: 'l' }), 'FIX: slot intact after a glitch-drop')
  ok(osState.surfaces.some((s) => s.id === 'card-rhythm' && s.slot), 'FIX: card kept in osState with its slot')

  // A reconcile must NOT resurrect it (identity + slot preserved — no fresh UUID, no stagger). Exclude
  // the host-owned chat hub (also a srcdoc, role:'chat') so we count only real board cards.
  host.reconcileAt(0, 0)
  const cards = osState.surfaces.filter((s) => s.kind === 'srcdoc' && s.role !== 'chat')
  ok(cards.length === 1 && cards[0].id === 'card-rhythm' && cards[0].slot, 'FIX: reconcile keeps ONE card, original id, slot intact (no resurrection)')

  // CONTROL — a GENUINE close still drops it (file deleted + recentlyClosed), so the fix does not
  // resurrect things the user actually closed.
  host.closeSurfaceFile('card-rhythm')
  ok(!existsSync(contentPath), 'close: content file deleted')
  host.onStatePush({ surfaces: [] })
  host.flush()
  ok(!nodes().find((n) => n.id === 'card-rhythm'), 'close: a closed card STAYS gone (not re-asserted)')

  console.log(failed ? '\nFAILED' : '\nall assertions passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
