// Headless verification of the macOS-faithful window system (no display needed): exercises the REAL
// store.ts — snapTargetFor (no full-screen, halves + corners), applyReconcile (live geometry kept),
// and the control-mode viewport memory. Run via scripts/test-window-system.sh (esbuild-bundled).
import { snapTargetFor, primaryRect, viewTransform, useDesktop } from '../src/renderer/src/store'
import type { Surface } from '../src/renderer/src/types'

let failures = 0
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}

const vp = { w: 1440, h: 900 }
const r = primaryRect(vp)
const cx = r.x + r.w / 2
const cy = r.y + r.h / 2

console.log('snapTargetFor — macOS tiling (no full-screen):')
// THE regression: dragging UP near the top edge (but not a side) must NOT full-screen.
ok('top edge, center-x → NO snap (no full-screen)', snapTargetFor(cx, r.y + 2, vp) === null, snapTargetFor(cx, r.y + 2, vp))
ok('bottom edge, center-x → NO snap', snapTargetFor(cx, r.y + r.h - 2, vp) === null)
ok('dead center → NO snap (free drag)', snapTargetFor(cx, cy, vp) === null)
// Side halves.
const left = snapTargetFor(r.x + 2, cy, vp)
ok('left edge mid → left HALF', !!left && left.x === Math.round(r.x) && Math.abs(left.w - Math.round(r.w) / 2) < 2 && Math.abs(left.h - Math.round(r.h)) < 2, left)
const right = snapTargetFor(r.x + r.w - 2, cy, vp)
ok('right edge mid → right HALF (right side)', !!right && right.x > cx - 2 && Math.abs(right.h - Math.round(r.h)) < 2, right)
// Corners → quarters.
const tl = snapTargetFor(r.x + 2, r.y + 2, vp)
ok('top-left corner → top-left QUARTER', !!tl && tl.x === Math.round(r.x) && tl.y === Math.round(r.y) && tl.h < Math.round(r.h) - 10, tl)
const br = snapTargetFor(r.x + r.w - 2, r.y + r.h - 2, vp)
ok('bottom-right corner → bottom-right QUARTER', !!br && br.x > cx - 2 && br.y > cy - 2, br)
// No target ever fills the whole area (would be a full-screen snap).
const samples = [
  [cx, r.y + 2], [cx, r.y + r.h - 2], [r.x + 2, cy], [r.x + r.w - 2, cy],
  [r.x + 2, r.y + 2], [r.x + r.w - 2, r.y + 2], [r.x + 2, r.y + r.h - 2], [r.x + r.w - 2, r.y + r.h - 2]
] as const
const anyFull = samples.map(([x, y]) => snapTargetFor(x, y, vp)).some((t) => t && Math.abs(t.w - Math.round(r.w)) < 2 && Math.abs(t.h - Math.round(r.h)) < 2)
ok('NO sampled edge/corner yields a full-area (full-screen) tile', !anyFull)

console.log('\napplyReconcile — keeps LIVE geometry (no revert-to-original):')
const store = useDesktop.getState()
// Seed a file-backed surface as if hydrated from disk at (0,0,400,300).
const seeded: Surface = { id: 'note-1', kind: 'native', component: 'note', x: 0, y: 0, w: 400, h: 300, z: 5, title: 'n', props: { text: 'hello' } }
store.hydrate([seeded], { x: 0, y: 0, scale: 1 }, 'desktop')
// User drags it (clamped to the primary area) and focuses it (z bumps). Capture the LIVE position.
useDesktop.getState().moveSurface('note-1', 250, 90)
useDesktop.getState().focusSurface('note-1')
const moved = useDesktop.getState().surfaces.find((s) => s.id === 'note-1')!
const movedZ = moved.z
const liveX = moved.x
const liveY = moved.y
ok('drag actually moved it off the disk origin (0,0)', liveX !== 0 || liveY !== 0, { liveX, liveY })
// A reconcile fires carrying the STALE disk geometry (0,0) + edited text.
useDesktop.getState().applyReconcile([{ ...seeded, x: 0, y: 0, z: 5, props: { text: 'edited on disk' } }])
const after = useDesktop.getState().surfaces.find((s) => s.id === 'note-1')!
ok('live x kept (not reverted to disk 0)', after.x === liveX && after.x !== 0, { after: after.x, liveX })
ok('live y kept (not reverted to disk 0)', after.y === liveY && after.y !== 0, { after: after.y, liveY })
ok('live z kept (focus survives reconcile)', after.z === movedZ, { after: after.z, movedZ })
ok('disk CONTENT still adopted (text updated)', (after.props?.text as string) === 'edited on disk', after.props)

console.log('\napplyReconcile — new & removed files still flow:')
useDesktop.getState().applyReconcile([
  { ...seeded, x: 0, y: 0, z: 5, props: { text: 'edited on disk' } },
  { id: 'file-2', kind: 'native', component: 'file', x: 120, y: 120, w: 200, h: 160, z: 6, title: 'pic.png', props: { name: 'pic.png' } }
])
ok('new disk surface added at its disk position', !!useDesktop.getState().surfaces.find((s) => s.id === 'file-2' && s.x === 120))
useDesktop.getState().applyReconcile([{ id: 'file-2', kind: 'native', component: 'file', x: 120, y: 120, w: 200, h: 160, z: 6, title: 'pic.png', props: { name: 'pic.png' } }])
ok('removed disk surface dropped (note-1 gone)', !useDesktop.getState().surfaces.find((s) => s.id === 'note-1'))

console.log('\napplyReconcile — a brand-new disk surface lands ON TOP (not buried):')
{
  const base: Surface = { id: 'a', kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 30, title: 'a', props: {} }
  useDesktop.getState().hydrate([base], { x: 0, y: 0, scale: 1 }, 'desktop')
  useDesktop.getState().focusSurface('a') // a's z climbs high
  const aZ = useDesktop.getState().surfaces.find((s) => s.id === 'a')!.z
  // reconcile brings a NEW file carrying a small backend stack-index z (would bury it under 'a')
  useDesktop.getState().applyReconcile([
    { ...base, z: aZ },
    { id: 'b', kind: 'native', component: 'file', x: 50, y: 50, w: 200, h: 160, z: 2, title: 'b.png', props: { name: 'b.png' } }
  ])
  const b = useDesktop.getState().surfaces.find((s) => s.id === 'b')!
  ok('new surface z is above the existing focused surface (on top, not z:2)', b.z > aZ, { bZ: b.z, aZ })
}

console.log('\napplyReconcile — focused note: keep live text, adopt other disk content:')
{
  const note: Surface = { id: 'n', kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 10, title: 'n', props: { text: 'typed-unsaved', color: 'coral' } }
  useDesktop.getState().hydrate([note], { x: 0, y: 0, scale: 1 }, 'desktop')
  useDesktop.getState().setEditingId('n') // user is focused in the textarea
  // agent edits the SAME note's file: new text + new color
  useDesktop.getState().applyReconcile([{ ...note, props: { text: 'agent-wrote-this', color: 'mint' } }])
  const after = useDesktop.getState().surfaces.find((s) => s.id === 'n')!
  ok("unsaved live text preserved (not clobbered)", (after.props?.text as string) === 'typed-unsaved', after.props)
  ok('other disk content (color) still adopted', (after.props?.color as string) === 'mint', after.props)
  useDesktop.getState().setEditingId(null)
}

console.log('\ntoggleMaximize clears preSnap (no stale pop-out size):')
{
  const w: Surface = { id: 'm', kind: 'native', component: 'note', x: 10, y: 10, w: 200, h: 150, z: 10, title: 'm', props: {}, preSnap: { w: 900, h: 600 } }
  useDesktop.getState().hydrate([w], { x: 0, y: 0, scale: 1 }, 'desktop')
  useDesktop.getState().toggleMaximize('m')
  const mx = useDesktop.getState().surfaces.find((s) => s.id === 'm')!
  ok('preSnap cleared after maximize', mx.preSnap === undefined, mx.preSnap)
  ok('restore captured for un-maximize', !!mx.restore)
}

console.log('\ncontrol-mode viewport memory:')
ok('controlTransform starts null after a fresh hydrate', useDesktop.getState().controlTransform === null)
// Enter control mode + pan: controlTransform must track the live camera (so exit→enter restores it).
useDesktop.getState().setMode('canvas')
useDesktop.getState().setTransform({ x: 0, y: 0, scale: 0.31 })
useDesktop.getState().panBy(-100, -40)
const afterPan = useDesktop.getState()
ok('panBy in canvas mode updates controlTransform', JSON.stringify(afterPan.controlTransform) === JSON.stringify(afterPan.transform), {
  controlTransform: afterPan.controlTransform,
  transform: afterPan.transform
})
ok('the remembered camera reflects the pan (≠ default bird\'s-eye)', JSON.stringify(afterPan.controlTransform) !== JSON.stringify(viewTransform('canvas', vp)))
// Back in desktop mode, panBy must NOT pollute controlTransform.
useDesktop.getState().setMode('desktop')
const before = JSON.stringify(useDesktop.getState().controlTransform)
useDesktop.getState().panBy(5, 5)
ok('panBy in desktop mode leaves controlTransform untouched', JSON.stringify(useDesktop.getState().controlTransform) === before)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
