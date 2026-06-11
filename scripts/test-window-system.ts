// Headless verification of the macOS-faithful window system (no display needed): exercises the REAL
// store.ts — snapTargetFor (no full-screen, halves + corners), applyReconcile (live geometry kept),
// and the control-mode viewport memory. Run via scripts/test-window-system.sh (esbuild-bundled).
import { snapTargetFor, primaryRect, viewTransform, stageRect, stageStride, useDesktop } from '../src/renderer/src/store'
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
// No target ever fills the whole stage (would be a full-screen snap).
const samples = [
  [cx, r.y + 2], [cx, r.y + r.h - 2], [r.x + 2, cy], [r.x + r.w - 2, cy],
  [r.x + 2, r.y + 2], [r.x + r.w - 2, r.y + 2], [r.x + 2, r.y + r.h - 2], [r.x + r.w - 2, r.y + r.h - 2]
] as const
const anyFull = samples.map(([x, y]) => snapTargetFor(x, y, vp)).some((t) => t && Math.abs(t.w - Math.round(r.w)) < 2 && Math.abs(t.h - Math.round(r.h)) < 2)
ok('NO sampled edge/corner yields a full-stage (full-screen) tile', !anyFull)

console.log('\napplyReconcile — keeps LIVE geometry (no revert-to-original):')
const store = useDesktop.getState()
// Seed a file-backed surface as if hydrated from disk at (0,0,400,300).
const seeded: Surface = { id: 'note-1', kind: 'native', component: 'note', x: 0, y: 0, w: 400, h: 300, z: 5, title: 'n', props: { text: 'hello' } }
store.hydrate([seeded], { x: 0, y: 0, scale: 1 }, 'desktop')
// User drags it (clamped to the primary stage) and focuses it (z bumps). Capture the LIVE position.
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

console.log("\napplyReconcile — live web URL kept (no 'typing on Google → back to HN'):")
{
  const web: Surface = { id: 'w1', kind: 'web', x: 0, y: 0, w: 800, h: 600, z: 10, title: 'Hacker News', url: 'https://news.ycombinator.com' }
  useDesktop.getState().hydrate([web], { x: 0, y: 0, scale: 1 }, 'desktop')
  // user navigates the webview → the did-navigate sync folds the live location into the store
  useDesktop.getState().updateSurface('w1', { url: 'https://www.google.com/search?q=x' })
  // a reconcile fires carrying the STALE persisted url (HN)
  useDesktop.getState().applyReconcile([{ ...web, url: 'https://news.ycombinator.com' }])
  const after = useDesktop.getState().surfaces.find((s) => s.id === 'w1')!
  ok('live (Google) url kept, NOT reverted to the disk HN url', after.url === 'https://www.google.com/search?q=x', after.url)
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

console.log('\n#45 workspace stages — step 1: stage-aware spatial fns, byte-identical at stageCount===1:')
{
  const stride = stageStride(vp)
  const eqRect = (a: { x: number; y: number; w: number; h: number } | null, b: { x: number; y: number; w: number; h: number } | null) =>
    !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
  // THE invariant: stageRect(0) is field-for-field primaryRect, and the stride is the stage width + gap.
  ok('stageRect(0,vp) deep-equals primaryRect(vp)', eqRect(stageRect(0, vp), primaryRect(vp)), { areaRect0: stageRect(0, vp), primaryRect: r })
  ok('stageStride(vp) === primaryRect(vp).w + 1200', stride === r.w + 1200, stride)
  // every existing 3-arg snapTargetFor call equals its stage=0 form (the default path is the old path).
  // NB: some samples (top/bottom-center) correctly return null from BOTH — null===null counts as identical.
  const allSamplesIdentical = samples.every(([x, y]) => {
    const a = snapTargetFor(x, y, vp)
    const b = snapTargetFor(x, y, vp, 0)
    return (a === null && b === null) || eqRect(a, b)
  })
  ok('snapTargetFor(x,y,vp) === snapTargetFor(x,y,vp,0) for all 8 samples', allSamplesIdentical)
  // viewTransform collapses to today's values at stage 0 / count 1
  const vtD = viewTransform('desktop', vp)
  const vtD01 = viewTransform('desktop', vp, 0, 1)
  ok('viewTransform(desktop) === (desktop,0,1)', JSON.stringify(vtD) === JSON.stringify(vtD01), { vtD, vtD01 })
  const vtC = viewTransform('canvas', vp)
  const vtC01 = viewTransform('canvas', vp, 0, 1)
  ok('viewTransform(canvas) === (canvas,0,1) and scale===0.7', JSON.stringify(vtC) === JSON.stringify(vtC01) && vtC.scale === 0.7, { vtC })
  // stages are same-size, one stride apart
  ok('stageRect(1).x - stageRect(0).x === stride', stageRect(1, vp).x - stageRect(0, vp).x === stride)
  ok('stageRect(1).w === stageRect(0).w', stageRect(1, vp).w === stageRect(0, vp).w)

  // fresh single-stage state
  useDesktop.getState().hydrate([], { x: 0, y: 0, scale: 1 }, 'desktop')
  ok('fresh hydrate → stageCount===1 && currentStage===0', useDesktop.getState().stageCount === 1 && useDesktop.getState().currentStage === 0)

  // setCurrentArea / setAreaCount / addArea clamping
  useDesktop.getState().setAreaCount(2)
  ok('setAreaCount(2) → stageCount===2', useDesktop.getState().stageCount === 2)
  useDesktop.getState().setCurrentArea(5)
  ok('setCurrentArea(5) clamps to 1 (stageCount-1)', useDesktop.getState().currentStage === 1)
  useDesktop.getState().setCurrentArea(-3)
  ok('setCurrentArea(-3) clamps to 0', useDesktop.getState().currentStage === 0)
  useDesktop.getState().setCurrentArea(0)
  useDesktop.getState().addArea()
  ok('addArea from {count2,cur0} → {count3,cur2}', useDesktop.getState().stageCount === 3 && useDesktop.getState().currentStage === 2)
  useDesktop.getState().setAreaCount(0)
  ok('setAreaCount(0) floors to 1 and clamps currentStage to 0', useDesktop.getState().stageCount === 1 && useDesktop.getState().currentStage === 0)

  // CONTROL fits all stages; NORMAL locks each stage to the same on-screen anchor
  const cxAnchor = viewTransform('desktop', vp, 0, 2).x // stage-0 desktop camera x (the anchor t.x)
  const a1 = viewTransform('desktop', vp, 1, 2)
  const a1CenterScreenX = (stageRect(1, vp).x + r.w / 2) * 1 + a1.x // screen = world*scale + t
  const a0CenterScreenX = (stageRect(0, vp).x + r.w / 2) * 1 + cxAnchor
  ok('desktop: stage-1 center maps to the SAME screen x as stage-0 center (stage lock)', Math.abs(a1CenterScreenX - a0CenterScreenX) < 0.001, { a1CenterScreenX, a0CenterScreenX })
  const vtC2 = viewTransform('canvas', vp, 0, 2)
  ok('canvas: 2 stages zoom out (scale < single-stage 0.7)', vtC2.scale < 0.7, vtC2.scale)
  const unionCenterScreenX = (((2 - 1) * stride) / 2) * vtC2.scale + vtC2.x
  ok('canvas: the tiled-row center maps to the stage anchor screen x', Math.abs(unionCenterScreenX - vtC.x) < 0.001, { unionCenterScreenX, anchor: vtC.x })

  // macOS free drag: moveSurface lets a window move FREELY outside the stage (off left/right/bottom);
  // the ONLY constraint is the title bar can't go above the stage top (y >= primaryRect.y).
  const surf: Surface = { id: 's', kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 5, title: 's', props: {} }
  useDesktop.getState().hydrate([surf], { x: 0, y: 0, scale: 1 }, 'desktop', 2)
  useDesktop.getState().moveSurface('s', 99999, 50) // far off the right edge — must be ALLOWED, not clamped
  ok('moveSurface allows free x far outside the stage (no horizontal clamp)', useDesktop.getState().surfaces.find((q) => q.id === 's')!.x === 99999, useDesktop.getState().surfaces.find((q) => q.id === 's')!.x)
  useDesktop.getState().moveSurface('s', -99999, 99999) // far off the left + bottom — x free, y free downward
  const sm = useDesktop.getState().surfaces.find((q) => q.id === 's')!
  ok('moveSurface allows free x off the left + free y downward (off-bottom)', sm.x === -99999 && sm.y === 99999, { x: sm.x, y: sm.y })
  useDesktop.getState().moveSurface('s', 10, primaryRect(vp).y - 500) // try to push the title bar ABOVE the top
  ok('moveSurface clamps the title bar to the stage top (y >= primaryRect.y) — #29 preserved', useDesktop.getState().surfaces.find((q) => q.id === 's')!.y === primaryRect(vp).y, useDesktop.getState().surfaces.find((q) => q.id === 's')!.y)

  // toggleMaximize fills the CURRENT stage
  useDesktop.getState().hydrate([surf], { x: 0, y: 0, scale: 1 }, 'desktop', 2)
  useDesktop.getState().setCurrentArea(1)
  useDesktop.getState().toggleMaximize('s')
  ok('toggleMaximize fills stageRect(1) (x === stageRect(1).x + 8 inset)', useDesktop.getState().surfaces.find((q) => q.id === 's')!.x === stageRect(1, vp).x + 8, useDesktop.getState().surfaces.find((q) => q.id === 's')!.x)
  useDesktop.getState().hydrate([surf], { x: 0, y: 0, scale: 1 }, 'desktop', 2)
  useDesktop.getState().setCurrentArea(0)
  useDesktop.getState().toggleMaximize('s')
  ok('REGRESSION: toggleMaximize stage 0 fills primaryRect (x === primaryRect.x + 8)', useDesktop.getState().surfaces.find((q) => q.id === 's')!.x === primaryRect(vp).x + 8, useDesktop.getState().surfaces.find((q) => q.id === 's')!.x)

  // hydrate restores stageCount (default 1 for old folders / invalid values)
  useDesktop.getState().hydrate([], { x: 0, y: 0, scale: 1 }, 'desktop', 4)
  ok('hydrate stageCount=4 → stageCount===4, currentStage===0', useDesktop.getState().stageCount === 4 && useDesktop.getState().currentStage === 0)
  useDesktop.getState().hydrate([], { x: 0, y: 0, scale: 1 }, 'desktop')
  ok('hydrate stageCount omitted → defaults to 1', useDesktop.getState().stageCount === 1)
  useDesktop.getState().hydrate([], { x: 0, y: 0, scale: 1 }, 'desktop', 0)
  ok('hydrate stageCount=0 (invalid) → floors to 1', useDesktop.getState().stageCount === 1)

  // review fix: a runtime chat/activity panel left in another stage is pulled back into stage 0 on boot
  // (the agent conversation must be reachable); a CONTENT surface in another stage is NOT moved.
  const chatPanel: Surface = { id: 'chat', kind: 'native', component: 'chat', x: stageRect(1, vp).x + 40, y: 0, w: 360, h: 460, z: 3, title: 'Chat', props: {} }
  useDesktop.getState().hydrate([chatPanel], { x: 0, y: 0, scale: 1 }, 'desktop', 2)
  const ch = useDesktop.getState().surfaces.find((q) => q.id === 'chat')!
  ok('hydrate pulls a runtime panel from stage 1 back inside stage 0', ch.x >= primaryRect(vp).x && ch.x <= primaryRect(vp).x + primaryRect(vp).w - 360, ch.x)
  const note2: Surface = { id: 'nn', kind: 'native', component: 'note', x: stageRect(1, vp).x + 40, y: 0, w: 300, h: 200, z: 2, title: 'n', props: {} }
  useDesktop.getState().hydrate([note2], { x: 0, y: 0, scale: 1 }, 'desktop', 2)
  const nn = useDesktop.getState().surfaces.find((q) => q.id === 'nn')!
  ok('hydrate does NOT move a content surface out of its stage', nn.x === stageRect(1, vp).x + 40, nn.x)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
