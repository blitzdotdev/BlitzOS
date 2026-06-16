// Headless tests for the machine-global root state + boot journal (kernel fault model) and the
// boot-where-you-left-off preference in the workspace host. Plain node — no Electron needed.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readRootState, patchRootState, openBootJournal } from '../../src/main/workspace.mjs'
import { createWorkspaceHost } from '../../src/main/workspace-host.mjs'

let passed = 0
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++
      console.log(`  ✓ ${name}`)
    })
    .catch((e) => {
      console.error(`  ✗ ${name}\n    ${e?.message || e}`)
      process.exitCode = 1
    })
}

const root = mkdtempSync(join(tmpdir(), 'blitz-rootstate-'))
const stubs = () => {
  let st = { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'canvas' }
  return { getState: () => st, setState: (s) => (st = s), broadcast: () => {} }
}
// a pid that existed and is now guaranteed dead (a child that already exited)
const deadPid = spawnSync('true').pid

await t('patchRootState merges shallowly + readRootState roundtrips', () => {
  patchRootState(root, { lastActiveWorkspace: 'A' })
  patchRootState(root, { boot: { pid: 1, mode: 'test', bootedAt: 1, heartbeatAt: 1, cleanShutdown: true } })
  const s = readRootState(root)
  assert.equal(s.lastActiveWorkspace, 'A') // untouched by the second patch
  assert.equal(s.boot.pid, 1)
})

await t('fresh journal: not dirty, not concurrent; markClean survives reopen', () => {
  rmSync(join(root, '.blitzos'), { recursive: true, force: true })
  const j1 = openBootJournal(root, 'test')
  assert.equal(j1.dirty, false)
  assert.equal(j1.concurrent, false)
  j1.markClean()
  assert.equal(readRootState(root).boot.cleanShutdown, true)
  const j2 = openBootJournal(root, 'test')
  assert.equal(j2.dirty, false)
  j2.markClean()
})

await t('a record with a DEAD pid and no clean shutdown reads as a crash (dirty)', () => {
  patchRootState(root, { boot: { pid: deadPid, mode: 'test', bootedAt: 100, heartbeatAt: 12345, cleanShutdown: false } })
  const j = openBootJournal(root, 'test')
  assert.equal(j.dirty, true)
  assert.equal(j.concurrent, false)
  assert.equal(j.lastAliveAt, 12345)
  j.markClean()
})

await t('a record with a LIVE foreign pid reads as concurrent, never as a crash', () => {
  // the parent shell is a live process that is not us
  patchRootState(root, { boot: { pid: process.ppid, mode: 'other', bootedAt: 1, heartbeatAt: 2, cleanShutdown: false } })
  const j = openBootJournal(root, 'test')
  assert.equal(j.concurrent, true)
  assert.equal(j.dirty, false)
  j.markClean()
})

await t('a record with OUR OWN pid (double-open) is neither a crash nor concurrent', () => {
  patchRootState(root, { boot: { pid: process.pid, mode: 'test', bootedAt: 1, heartbeatAt: 2, cleanShutdown: false } })
  const j = openBootJournal(root, 'test')
  assert.equal(j.dirty, false)
  assert.equal(j.concurrent, false)
  j.markClean()
})

await t('host remembers the active workspace across constructions (boot where you left off)', async () => {
  const h1 = createWorkspaceHost({ root, initialName: 'Home', ...stubs() })
  h1.create('B')
  const r = await h1.performSwitch('B')
  assert.equal(r.status, 200)
  h1.stopWatch() // performSwitch armed watchers; release so the test process can exit
  assert.equal(readRootState(root).lastActiveWorkspace, 'B')
  const h2 = createWorkspaceHost({ root, initialName: 'Home', ...stubs() })
  assert.equal(h2.active(), 'B') // un-pinned boot returns where the user left off
})

await t('an explicit pin (BLITZ_WORKSPACE) beats the remembered workspace', () => {
  const h = createWorkspaceHost({ root, initialName: 'Home', explicitInitial: true, ...stubs() })
  assert.equal(h.active(), 'Home')
})

await t('a remembered workspace that no longer exists falls back to the default', () => {
  patchRootState(root, { lastActiveWorkspace: 'Ghost' })
  const h = createWorkspaceHost({ root, initialName: 'Home', ...stubs() })
  assert.equal(h.active(), 'Home')
})

rmSync(root, { recursive: true, force: true })
console.log(process.exitCode ? `\n${passed} passed, FAILURES above` : `\nall ${passed} passed`)
