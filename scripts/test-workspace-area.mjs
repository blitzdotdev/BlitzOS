// #45 step 4: prove the workspace.json areaCount round-trip (write → read), backward-compat with old
// folders (missing/invalid → 1), and that reconcile preserves it. Pure Node — run with `node`.
import { writeWorkspace, readWorkspace, reconcileWorkspace } from '../src/main/workspace.mjs'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}
const fresh = () => mkdtempSync(join(tmpdir(), 'aos-area-'))
// A non-empty board so writeWorkspace actually writes workspace.json (it skips empty-when-no-prior).
const board = (areaCount) => ({
  surfaces: [{ id: 'n1', kind: 'native', component: 'note', x: 10, y: 20, w: 300, h: 200, z: 1, title: 'note', props: { text: '# hi\n' } }],
  camera: { x: 5, y: 6, scale: 1 },
  mode: 'desktop',
  ...(areaCount === undefined ? {} : { areaCount })
})
const metaPath = (d) => join(d, '.blitzos', 'workspace.json')

console.log('workspace areaCount persistence (#45 step 4):')

// 1) write areaCount=3 → read 3
{
  const d = fresh()
  writeWorkspace(d, board(3))
  const r = readWorkspace(d)
  ok('write areaCount=3 → read areaCount===3', !!r && r.areaCount === 3, r && r.areaCount)
  ok('surfaces/camera/mode also round-trip', !!r && r.surfaces.length === 1 && r.camera.x === 5 && r.mode === 'desktop', r && { n: r.surfaces.length, cam: r.camera })
  rmSync(d, { recursive: true, force: true })
}

// 2) write with NO areaCount → read defaults to 1
{
  const d = fresh()
  writeWorkspace(d, board(undefined))
  const r = readWorkspace(d)
  ok('write omitting areaCount → read areaCount===1', !!r && r.areaCount === 1, r && r.areaCount)
  rmSync(d, { recursive: true, force: true })
}

// 3) write invalid areaCount (0 / negative / fractional / non-number) → floors to 1 on read
{
  for (const bad of [0, -2, 1.5, 'x']) {
    const d = fresh()
    writeWorkspace(d, board(bad))
    const r = readWorkspace(d)
    ok(`write invalid areaCount=${JSON.stringify(bad)} → read areaCount===1`, !!r && r.areaCount === 1, r && r.areaCount)
    rmSync(d, { recursive: true, force: true })
  }
}

// 4) an OLD workspace.json lacking the areaCount key reads as 1, surfaces/camera/mode intact (back-compat)
{
  const d = fresh()
  writeWorkspace(d, board(5)) // real write (correct node shapes), then strip areaCount to simulate an old file
  const meta = JSON.parse(readFileSync(metaPath(d), 'utf8'))
  delete meta.areaCount
  writeFileSync(metaPath(d), JSON.stringify(meta, null, 2))
  const r = readWorkspace(d)
  ok('old folder (areaCount key removed) → areaCount===1', !!r && r.areaCount === 1, r && r.areaCount)
  ok('old folder still hydrates surface + camera + mode', !!r && r.surfaces.length === 1 && r.camera.x === 5 && r.mode === 'desktop', r && { n: r.surfaces.length })
  rmSync(d, { recursive: true, force: true })
}

// 5) reconcile preserves areaCount (and re-writes it when the folder changes)
{
  const d = fresh()
  writeWorkspace(d, board(4))
  writeFileSync(join(d, 'dropped.md'), '# dropped\n') // a loose file → reconcile detects a change, re-writes
  const rec = reconcileWorkspace(d, { cx: 0, cy: 0 })
  ok('reconcile returns areaCount===4 (preserved)', !!rec && rec.areaCount === 4, rec && rec.areaCount)
  const after = JSON.parse(readFileSync(metaPath(d), 'utf8'))
  ok('reconcile re-writes areaCount===4 to disk (not collapsed to 1)', after.areaCount === 4, after.areaCount)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
