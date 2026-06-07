// Headless proof for the "do folders properly" work: recursive file/folder DROP ingest, server
// subpath upload (jailed), and empty New Folder / New Board creation — all against the REAL
// workspace.mjs FS primitives. No display needed. Run: node scripts/test-folder-drop.mjs
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { copyDroppedEntry, writeDroppedFileAt, createFolder, listDir, writeWorkspace, reconcileWorkspace } from '../src/main/workspace.mjs'

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.log('  ✗ ' + name)
  }
}

const tmp = join(tmpdir(), 'blitz-drop-' + randomUUID().slice(0, 8))
const ws = join(tmp, 'workspace')
const ext = join(tmp, 'external') // files/folders "outside" the workspace, like a Finder source
mkdirSync(ws, { recursive: true })
mkdirSync(ext, { recursive: true })

// Seed a workspace.json so reconcile has something to scan (one note surface).
writeWorkspace(ws, { surfaces: [{ id: 's1', kind: 'native', component: 'note', title: 'n', x: 0, y: 0, w: 200, h: 200, z: 1, props: { text: 'hi' } }], camera: { x: 0, y: 0, scale: 1 } })

console.log('\n# copyDroppedEntry — single FILE')
writeFileSync(join(ext, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
const f1 = copyDroppedEntry(ws, join(ext, 'photo.png'))
ok('returns rel + isDir:false', !!f1 && f1.isDir === false)
ok('file copied into workspace', !!f1 && existsSync(join(ws, f1.rel)))
ok('bytes match', !!f1 && readFileSync(join(ws, f1.rel)).length === 7)

console.log('\n# copyDroppedEntry — recursive FOLDER (a "repo")')
const repo = join(ext, 'myrepo')
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'README.md'), '# repo')
writeFileSync(join(repo, 'src', 'app.js'), 'console.log(1)')
writeFileSync(join(repo, 'src', 'util.js'), 'export {}')
const d1 = copyDroppedEntry(ws, repo)
ok('returns rel + isDir:true', !!d1 && d1.isDir === true)
ok('folder copied as a real subdir', !!d1 && statSync(join(ws, d1.rel)).isDirectory())
ok('nested file copied recursively', !!d1 && existsSync(join(ws, d1.rel, 'src', 'app.js')))
ok('all 3 files present', !!d1 && existsSync(join(ws, d1.rel, 'README.md')) && existsSync(join(ws, d1.rel, 'src', 'util.js')))

console.log('\n# copyDroppedEntry — unique naming on collision')
const f2 = copyDroppedEntry(ws, join(ext, 'photo.png'))
ok('second drop of same name gets a distinct rel', !!f2 && f2.rel !== f1.rel && existsSync(join(ws, f2.rel)))

console.log('\n# copyDroppedEntry — security: refuse self-copy')
ok('copying the workspace into itself → null', copyDroppedEntry(ws, ws) === null)
const inside = join(ws, d1.rel) // a real subdir already inside the workspace
ok('copying a dir INSIDE the workspace → null (no recursion bomb)', copyDroppedEntry(ws, inside) === null)
ok('copying a vanished path → null', copyDroppedEntry(ws, join(ext, 'nope.bin')) === null)

console.log('\n# writeDroppedFileAt — server folder upload (subpath, jailed)')
const u1 = writeDroppedFileAt(ws, 'uploaded/sub/a.txt', Buffer.from('A'))
ok('writes a nested subpath', !!u1 && u1.rel === 'uploaded/sub/a.txt' && existsSync(join(ws, 'uploaded', 'sub', 'a.txt')))
const escBefore = existsSync(join(tmp, 'escape.txt'))
const u2 = writeDroppedFileAt(ws, '../escape.txt', Buffer.from('X'))
ok('".." segments are stripped (no traversal)', !existsSync(join(tmp, 'escape.txt')) && escBefore === false)
ok('".." drop still lands jailed inside workspace', !!u2 && existsSync(join(ws, u2.rel)))
const realMetaBefore = readFileSync(join(ws, '.blitzos', 'workspace.json'), 'utf8')
const u3 = writeDroppedFileAt(ws, '.blitzos/workspace.json', Buffer.from('PWNED'))
ok('leading-dot segment neutralized (real .blitzos untouched)', readFileSync(join(ws, '.blitzos', 'workspace.json'), 'utf8') === realMetaBefore)
ok('the neutralized drop went to a NEW non-dot dir', !!u3 && u3.rel.startsWith('blitzos/') && existsSync(join(ws, 'blitzos', 'workspace.json')))

console.log('\n# createFolder — New Folder / New Board')
const nf = createFolder(ws, 'My Stuff')
ok('normal folder created (slugged)', !!nf && nf.ok && statSync(join(ws, nf.folder)).isDirectory() && !nf.folder.endsWith('.board'))
const nb = createFolder(ws, 'My Stuff', 'board')
ok('board folder gets .board suffix', !!nb && nb.ok && nb.folder.endsWith('.board') && statSync(join(ws, nb.folder)).isDirectory())
const nf2 = createFolder(ws, 'My Stuff')
ok('duplicate name → unique', !!nf2 && nf2.ok && nf2.folder !== nf.folder)

console.log('\n# reconcile — a dropped FOLDER surfaces as ONE collapsed dir tile')
const rec = reconcileWorkspace(ws, { cx: 500, cy: 300 })
const dirTiles = (rec?.surfaces || []).filter((s) => s.component === 'dir')
const repoTile = dirTiles.find((s) => s.props?.path === d1.rel)
ok('dropped repo shows as a dir tile', !!repoTile)
ok('repo tile is ONE tile, not its files splayed (non-recursive)', !(rec?.surfaces || []).some((s) => s.props?.path === `${d1.rel}/README.md`))
ok('empty New Folder shows as a dir tile', dirTiles.some((s) => s.props?.path === nf.folder))

console.log('\n# listDir — the file manager for a normal folder (both modes share this)')
const top = listDir(ws, '')
ok('lists the workspace root', !!top && Array.isArray(top.entries))
ok('the dropped repo appears as a dir entry', !!top && top.entries.some((e) => e.dir && e.name === d1.rel))
ok('dirs sort before files', !!top && (() => { const fi = top.entries.findIndex((e) => !e.dir); const di = top.entries.map((e) => e.dir).lastIndexOf(true); return fi === -1 || di < fi })())
ok('hides dotfiles (no .blitzos)', !!top && !top.entries.some((e) => e.name.startsWith('.')))
const inRepo = listDir(ws, d1.rel)
ok('drills into the repo (README.md + src)', !!inRepo && inRepo.entries.some((e) => e.name === 'README.md') && inRepo.entries.some((e) => e.dir && e.name === 'src'))
ok('jail: listDir("..") → null', listDir(ws, '..') === null)
ok('jail: listDir(".blitzos") → null', listDir(ws, '.blitzos') === null)
ok('jail: listDir(a real file) → null', listDir(ws, f1.rel) === null)

console.log('\n# listDir — a folder with THOUSANDS of files stays browsable (1000 cap + honest truncation)')
const big = join(ws, 'bigfolder')
mkdirSync(big, { recursive: true })
for (let k = 0; k < 1005; k++) writeFileSync(join(big, `f${k}.txt`), 'x')
const bigList = listDir(ws, 'bigfolder')
ok('caps the listing at 1000', !!bigList && bigList.entries.length === 1000)
ok('reports the true total (1005)', !!bigList && bigList.total === 1005)
ok('flags truncated:true (UI shows "1000 of 1005")', !!bigList && bigList.truncated === true)

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
