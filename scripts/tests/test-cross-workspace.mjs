// Item 4: cross-workspace surface addressing. findSurfaceWorkspace locates a surface by id across
// workspaces; relocateSurface MOVES it into the active one (file across folders, id preserved). Plain node.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspace, writeWorkspace, readWorkspace, findSurfaceWorkspace, relocateSurface } from '../../src/main/workspace.mjs'

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.message || e}`)
    process.exitCode = 1
  }
}

const root = mkdtempSync(join(tmpdir(), 'blitz-xws-'))
const A = createWorkspace(root, 'Alpha').path
const B = createWorkspace(root, 'Beta').path

// Put a note (id N1) in workspace Beta by persisting an osState, then a web surface (id N2) too.
writeWorkspace(B, {
  surfaces: [
    { id: 'N1', kind: 'native', component: 'note', title: 'cross note', x: 10, y: 20, w: 240, h: 240, props: { text: 'hello from Beta' } },
    { id: 'N2', kind: 'web', title: 'cross web', x: 0, y: 0, w: 800, h: 600, url: 'https://example.com', props: {} }
  ],
  camera: { x: 0, y: 0, scale: 1 },
  mode: 'canvas'
})

t('findSurfaceWorkspace locates a surface by id in another workspace', () => {
  const f = findSurfaceWorkspace(root, 'N1')
  assert.equal(f?.name, 'Beta')
  assert.equal(f?.node?.id, 'N1')
})

t('findSurfaceWorkspace honors exceptDir (skips the active workspace)', () => {
  assert.equal(findSurfaceWorkspace(root, 'N1', B), null) // only in Beta, which we skip
  assert.equal(findSurfaceWorkspace(root, 'N1', A)?.name, 'Beta') // skipping Alpha still finds it
})

t('findSurfaceWorkspace returns null for an unknown id', () => {
  assert.equal(findSurfaceWorkspace(root, 'NOPE'), null)
})

t('relocateSurface moves a note Beta→Alpha, preserving id + content', () => {
  const r = relocateSurface(root, A, 'N1', { x: 500, y: 600 })
  assert.equal(r?.fromName, 'Beta')
  assert.equal(r?.surface?.id, 'N1') // id preserved — the agent's handle keeps working
  assert.equal(r?.surface?.props?.text, 'hello from Beta') // content carried across
  assert.equal(r?.surface?.x, 500) // placed where asked
  // the file now exists under Alpha and is gone from Beta
  assert.ok(existsSync(join(A, 'cross-note.md')), 'note file under Alpha')
  assert.ok(!existsSync(join(B, 'cross-note.md')), 'note file gone from Beta')
})

t('the moved surface is dropped from the SOURCE workspace.json', () => {
  const beta = readWorkspace(B)
  assert.ok(!beta.surfaces.some((s) => s.id === 'N1'), 'N1 removed from Beta')
  assert.ok(beta.surfaces.some((s) => s.id === 'N2'), 'N2 still in Beta')
})

t('a name collision in the destination is uniquified (no clobber)', () => {
  // a web surface's file is named from its URL host (example.com → example-com.weblink), so collide on THAT.
  writeFileSync(join(A, 'example-com.weblink'), JSON.stringify({ url: 'https://pre-existing.example' }))
  const before = readFileSync(join(A, 'example-com.weblink'), 'utf8')
  const r = relocateSurface(root, A, 'N2', { x: 0, y: 0 })
  assert.equal(r?.surface?.id, 'N2')
  // the pre-existing file is untouched; the moved one took a uniquified name
  assert.equal(readFileSync(join(A, 'example-com.weblink'), 'utf8'), before)
  assert.ok(existsSync(join(A, 'example-com-2.weblink')), 'moved web took the -2 name')
})

t('relocateSurface returns null when the id is not in another workspace', () => {
  assert.equal(relocateSurface(root, A, 'NOPE'), null)
})

rmSync(root, { recursive: true, force: true })
console.log(process.exitCode ? `\n${passed} passed, FAILURES above` : `\nall ${passed} passed`)
