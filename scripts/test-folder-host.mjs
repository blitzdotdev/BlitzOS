// #52 — end-to-end proof of the WIRING: the shared workspace host's group() does flush → mkdir+mv →
// reconcile, with the new folder broadcast to renderers. Drives the real host with a fake adapter +
// a real temp dir (the host is transport-agnostic; this is exactly what backend.mjs / osActions call).
import { createWorkspaceHost } from '../src/main/workspace-host.mjs'
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
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

console.log('\nworkspace-host.newFolder — "New Folder" / "New Board" from the right-click menu:')
const nf = host.newFolder('Documents', 'folder', 0, 0)
ok('newFolder ok (normal file folder)', nf && nf.ok && existsSync(join(ws, nf.folder)) && !nf.folder.endsWith('.board'), nf)
const nb = host.newFolder('Stage', 'board', 0, 0)
ok('newBoard ok (.board suffix → on-canvas folder)', nb && nb.ok && nb.folder.endsWith('.board') && existsSync(join(ws, nb.folder)), nb)
const afterNew = broadcasts.filter((b) => b && b.type === 'reconcile').pop()
ok('New Folder broadcasts a reconcile carrying the normal folder as a dir tile', (afterNew?.surfaces || []).some((s) => s.component === 'dir' && s.props?.path === nf.folder))

console.log('\nworkspace-host.ingestPaths — drop real files/folders (Electron path):')
const ext = mkdtempSync(join(tmpdir(), 'aos-ext-'))
mkdirSync(join(ext, 'repo', 'src'), { recursive: true })
writeFileSync(join(ext, 'repo', 'index.js'), 'x')
writeFileSync(join(ext, 'repo', 'src', 'a.js'), 'y')
writeFileSync(join(ext, 'pic.png'), Buffer.from([1, 2, 3]))
const ip = host.ingestPaths([join(ext, 'repo'), join(ext, 'pic.png')], 100, 100)
ok('ingestPaths copied 2 entries', ip && ip.ok && ip.copied === 2, ip)
ok('the repo landed as a real recursive subdir', existsSync(join(ws, 'repo', 'src', 'a.js')))
ok('the file landed in the workspace root', existsSync(join(ws, 'pic.png')))
const afterIngest = broadcasts.filter((b) => b && b.type === 'reconcile').pop()
ok('dropped repo broadcasts as ONE collapsed dir tile (not its files)', (afterIngest?.surfaces || []).some((s) => s.component === 'dir' && s.props?.path === 'repo') && !(afterIngest?.surfaces || []).some((s) => s.props?.path === 'repo/index.js'))

console.log('\nworkspace-host.ingestUpload — server folder upload (subpath, deferred reconcile):')
host.ingestUpload('dropped/sub/a.txt', Buffer.from('A'), 0, 0, false)
host.ingestUpload('dropped/b.txt', Buffer.from('B'), 0, 0, false)
ok('subpath uploads wrote a nested real tree', existsSync(join(ws, 'dropped', 'sub', 'a.txt')) && existsSync(join(ws, 'dropped', 'b.txt')))
const beforeRec = broadcasts.filter((b) => b && b.type === 'reconcile').length
host.reconcileAt(200, 200)
ok('the trailing reconcileAt broadcasts once', broadcasts.filter((b) => b && b.type === 'reconcile').length === beforeRec + 1)

console.log('\nworkspace-host.listDir — the file-manager listing (jailed):')
const ld = host.listDir('repo')
ok('lists the dropped repo contents', !!ld && ld.entries.some((e) => e.name === 'index.js') && ld.entries.some((e) => e.dir && e.name === 'src'))
ok('listDir jails ".." → null', host.listDir('..') === null)

// and it persists: a fresh read of the folder shows the folder tile (real directory on disk)
host.stopWatch?.()
rmSync(ext, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
