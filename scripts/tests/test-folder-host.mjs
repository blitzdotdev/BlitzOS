// #52 — end-to-end proof of the WIRING: the shared workspace host's group() does flush → mkdir+mv →
// reconcile, with the new folder broadcast to renderers. Drives the real host with a fake adapter +
// a real temp dir (the host is transport-agnostic; this is exactly what backend.mjs / osActions call).
import { createWorkspaceHost } from '../../src/main/workspace-host.mjs'
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.BLITZ_CHAT_STATUS_QUIET_MS = '20'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}
const note = (id, text) => ({ id, kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 1, title: id, props: { text } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

console.log('\nworkspace-host chat — file-backed widget (appendChat → chat.md + broadcast):')
osState = { surfaces: [{ id: 'chat', kind: 'srcdoc', role: 'chat', x: 0, y: 0, w: 360, h: 460, z: 5, props: { messages: [] } }], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' }
const chatProps = () => osState.surfaces.find((s) => s.role === 'chat')?.props || {}
const m1 = host.appendChat('user', 'hello chat')
ok('appendChat writes chat.md', existsSync(join(ws, 'chat.md')) && m1.length === 1 && m1[0].text === 'hello chat', m1)
ok('appendChat broadcasts {type:chat, messages}', broadcasts.some((b) => b && b.type === 'chat' && Array.isArray(b.messages) && b.messages.length === 1))
ok('appendChat syncs osState chat surface props (fresh hydrate shows it)', (osState.surfaces.find((s) => s.role === 'chat')?.props?.messages || []).length === 1)
ok('appendChat exposes hub threads', Array.isArray(osState.surfaces.find((s) => s.role === 'chat')?.props?.threads?.['0']))
ok('user chat marks the agent working', chatProps().status?.['0'] === 'working', chatProps().status)
host.appendChat('agent', 'hi there')
ok('agent /say does not force idle', chatProps().status?.['0'] === 'working', chatProps().status)
host.noteAgentActivity('0', 'tool')
ok('tool activity keeps the agent working', chatProps().status?.['0'] === 'working', chatProps().status)
await sleep(45)
ok('quiet running agent transitions to watching', chatProps().status?.['0'] === 'watching', chatProps().status)
ok('both roles append in order', host.appendChat('user', 'x').slice(0, 2).map((m) => m.role).join() === 'user,agent')
const added = host.addAgent('1', 'Agent 1')
ok('new agent starts in warmup', added.id === '1' && chatProps().status?.['1'] === 'starting', chatProps().status)
host.noteAgentActivity('1', 'terminal')
ok('startup terminal output keeps warmup status', chatProps().status?.['1'] === 'starting', chatProps().status)
host.noteAgentActivity('1', 'say')
host.appendChat('agent', 'BlitzOS here, live on your desktop. What are we working on?', '1')
ok('startup ready message settles to watching', chatProps().status?.['1'] === 'watching', chatProps().status)
host.noteAgentActivity('1', 'terminal')
ok('passive wait-loop terminal output stays watching', chatProps().status?.['1'] === 'watching', chatProps().status)
await sleep(45)
ok('quiet new agent becomes watching', chatProps().status?.['1'] === 'watching', chatProps().status)
host.setChatStatus('1', 'stopped')
ok('terminal stop marks stopped immediately', chatProps().status?.['1'] === 'stopped', chatProps().status)
host.setChatStatus('1', 'error')
ok('terminal failure marks error immediately', chatProps().status?.['1'] === 'error', chatProps().status)

console.log('\nworkspace-host customizeWidget — the agent rewrites the chat UI (live-reload):')
const cu = host.customizeWidget('chat', '<blitz-titlebar>Custom Chat</blitz-titlebar>')
ok('customizeWidget writes blitz-chat.html', cu.ok && readFileSync(join(ws, 'blitz-chat.html'), 'utf8').includes('Custom Chat'))
ok('customizeWidget broadcasts a live-reload update for the chat', broadcasts.some((b) => b && b.type === 'update' && b.id === 'chat' && (b.patch?.html || '').includes('Custom Chat')))
ok('systemUi returns the customized source', (host.systemUi('chat') || '').includes('Custom Chat'))
ok('customize rejects an unknown widget', host.customizeWidget('nope', 'x').ok === false)

// and it persists: a fresh read of the folder shows the folder tile (real directory on disk)
host.stopWatch?.()
rmSync(ext, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
