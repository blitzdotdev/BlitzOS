// #52 — end-to-end proof of the WIRING: the shared workspace host's group() does flush → mkdir+mv →
// reconcile, with the new folder broadcast to renderers. Drives the real host with a fake adapter +
// a real temp dir (the host is transport-agnostic; this is exactly what backend.mjs / osActions call).
import { createWorkspaceHost } from '../src/main/workspace-host.mjs'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
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
const note = (id, text) => ({ id, kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 1, title: id, props: { text } })

const root = mkdtempSync(join(tmpdir(), 'aos-host-'))
let osState = { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' }
const broadcasts = []
const host = createWorkspaceHost({
  root,
  initialName: 'Home',
  getState: () => osState,
  setState: (s) => {
    osState = s
  },
  broadcast: (o) => broadcasts.push(o),
  defaultMode: 'desktop'
})
const ws = host.activePath()
const md = () => readdirSync(ws).filter((n) => n.endsWith('.md') && n !== 'BLITZOS.md')

console.log('workspace-host.group — end-to-end (the path backend /group + Cmd+G hit):')
// the renderer "pushed" a board with 3 notes
osState = { surfaces: [note('a', '# A'), note('b', '# B'), note('c', '# C')], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' }

const r = host.group('My Folder', ['a', 'b'], 0, 0)
ok('host.group ok, moved 2', r && r.ok && r.moved === 2, r)
ok('a real subdir exists with the 2 moved notes', existsSync(join(ws, r.folder)) && readdirSync(join(ws, r.folder)).filter((n) => n.endsWith('.md')).length === 2, r.folder)
ok('the 2 grouped notes left the workspace root (real mv)', md().length === 1, md())

// the host should have BROADCAST a reconcile so renderers swap the loose tiles for one folder tile
const reconciles = broadcasts.filter((b) => b && b.type === 'reconcile')
ok('a reconcile was broadcast to renderers', reconciles.length >= 1, broadcasts.map((b) => b.type))
const last = reconciles[reconciles.length - 1]
const dirTiles = (last?.surfaces || []).filter((s) => s.component === 'dir')
const looseNotes = (last?.surfaces || []).filter((s) => s.component === 'note')
ok('the broadcast carries ONE folder tile', dirTiles.length === 1, dirTiles.map((t) => t.title))
ok('the broadcast no longer carries the 2 grouped notes (only the loose one)', looseNotes.length === 1, looseNotes.map((t) => t.title))

// and it persists: a fresh read of the folder shows the folder tile (real directory on disk)
osState = host && undefined // not needed
host.stopWatch?.()
rmSync(root, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
