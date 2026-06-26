// Headless proof for the "do folders properly" work: recursive file/folder DROP ingest, server
// subpath upload (jailed), and empty New Folder / New Board creation — all against the REAL
// workspace.mjs FS primitives. No display needed. Run: node scripts/test-folder-drop.mjs
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { copyDroppedEntry, writeDroppedFileAt, createFolder, renameFolder, moveIntoFolder, moveOutOfFolder, openFolderEntry, listDir, removeSurfaceFile, writeWorkspace, readWorkspace, reconcileWorkspace } from '../../src/main/workspace.mjs'

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
const rn = renameFolder(ws, nf.folder, 'Renamed Stuff')
ok('renameFolder renames the real directory', !!rn && rn.ok && rn.path === 'Renamed Stuff' && existsSync(join(ws, rn.path)) && !existsSync(join(ws, nf.folder)))
ok('renameFolder rejects traversal-ish names', renameFolder(ws, rn.path, '../bad').ok === false)
const titleWs = join(tmp, 'titlews')
mkdirSync(titleWs, { recursive: true })
writeWorkspace(titleWs, { surfaces: [{ id: 'seed', kind: 'native', component: 'note', title: 'Seed', x: 0, y: 0, w: 240, h: 200, z: 1, props: { text: 'seed' } }], camera: { x: 0, y: 0, scale: 1 } })
const titleFolder = createFolder(titleWs, 'Folder')
const titleRec = reconcileWorkspace(titleWs, {})
writeWorkspace(titleWs, { surfaces: titleRec.surfaces, camera: titleRec.camera, mode: titleRec.mode })
const titleRename = renameFolder(titleWs, titleFolder.folder, 'Client Docs')
writeWorkspace(titleWs, { surfaces: titleRec.surfaces, camera: titleRec.camera, mode: titleRec.mode })
const titleHydrated = readWorkspace(titleWs)?.surfaces.find((s) => s.component === 'dir' && s.props?.path === titleRename.path)
const titleReconciled = reconcileWorkspace(titleWs, {})?.surfaces.find((s) => s.component === 'dir' && s.props?.path === titleRename.path)
ok('renameFolder survives a stale renderer write and hydrates/reconciles from the path basename', !!titleRename.ok && titleHydrated?.title === 'Client Docs' && titleReconciled?.title === 'Client Docs')

console.log('\n# reconcile — a dropped FOLDER surfaces as ONE collapsed dir tile')
const rec = reconcileWorkspace(ws, { cx: 500, cy: 300 })
const dirTiles = (rec?.surfaces || []).filter((s) => s.component === 'dir')
const repoTile = dirTiles.find((s) => s.props?.path === d1.rel)
ok('dropped repo shows as a dir tile', !!repoTile)
ok('repo tile is ONE tile, not its files splayed (non-recursive)', !(rec?.surfaces || []).some((s) => s.props?.path === `${d1.rel}/README.md`))
ok('empty renamed New Folder shows as a dir tile', dirTiles.some((s) => s.props?.path === rn.path))

console.log('\n# listDir — the file manager for a normal folder (both modes share this)')
const top = listDir(ws, '')
ok('lists the workspace root', !!top && Array.isArray(top.entries))
ok('the dropped repo appears as a dir entry', !!top && top.entries.some((e) => e.dir && e.name === d1.rel))
ok('dirs sort before files', !!top && (() => { const fi = top.entries.findIndex((e) => !e.dir); const di = top.entries.map((e) => e.dir).lastIndexOf(true); return fi === -1 || di < fi })())
ok('hides dotfiles (no .blitzos)', !!top && !top.entries.some((e) => e.name.startsWith('.')))
const inRepo = listDir(ws, d1.rel)
ok('drills into the repo (README.md + src)', !!inRepo && inRepo.entries.some((e) => e.name === 'README.md') && inRepo.entries.some((e) => e.dir && e.name === 'src'))
ok('directory entries include their own item counts', !!inRepo && inRepo.entries.find((e) => e.dir && e.name === 'src')?.entries === 2)
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

console.log('\n# moveIntoFolder + openFolderEntry — real folders contain real Blitz items')
const mdir = join(tmp, 'movews')
mkdirSync(mdir, { recursive: true })
writeFileSync(join(ext, 'asset.png'), Buffer.from([9, 9, 9]))
copyDroppedEntry(mdir, join(ext, 'asset.png'))
mkdirSync(join(mdir, 'Docs'))
writeFileSync(join(mdir, 'Docs', 'inside.md'), 'nested doc')
writeWorkspace(mdir, {
  surfaces: [
    { id: 'note1', kind: 'native', component: 'note', title: 'Project Note', x: 0, y: 0, w: 240, h: 240, z: 1, props: { text: 'inside folder' } },
    { id: 'web1', kind: 'web', title: 'Example', url: 'https://example.com', x: 0, y: 0, w: 640, h: 420, z: 2, props: {} },
    { id: 'app1', kind: 'app', title: 'App Link', url: 'https://app.blitz.dev/demo', x: 0, y: 0, w: 640, h: 420, z: 3, props: {} },
    { id: 'wid1', kind: 'srcdoc', title: 'Widget', html: '<main>hello</main>', x: 0, y: 0, w: 360, h: 240, z: 4, props: {} }
  ],
  camera: { x: 0, y: 0, scale: 1 }
})
const target = createFolder(mdir, 'Archive')
const recMoveSeed = reconcileWorkspace(mdir, {})
const png = (recMoveSeed?.surfaces || []).find((s) => s.props?.path === 'asset.png')
const docs = (recMoveSeed?.surfaces || []).find((s) => s.props?.path === 'Docs')
const mv = moveIntoFolder(mdir, target.folder, ['note1', 'web1', 'app1', 'wid1', png?.id, docs?.id, 'missing'])
ok('moveIntoFolder skips web browsers and unknown ids', !!mv && mv.ok && mv.moved === 5 && mv.skipped === 2 && mv.movedIds?.includes('note1') && mv.movedIds?.includes('app1') && mv.movedIds?.includes('wid1') && mv.movedIds?.includes(png?.id) && mv.movedIds?.includes(docs?.id) && mv.skippedIds?.includes('web1') && mv.skippedIds?.includes('missing'))
const inArchive = listDir(mdir, target.folder)
ok('moved entries are browseable inside the folder', !!inArchive && ['project-note.md', 'app-blitz-dev.weblink', 'widget.html', 'asset.png', 'Docs'].every((name) => inArchive.entries.some((e) => e.name === name)) && !inArchive.entries.some((e) => e.name === 'example-com.weblink'))
writeFileSync(join(mdir, target.folder, 'manual-web.weblink'), JSON.stringify({ url: 'https://example.com', kind: 'web' }, null, 2) + '\n')
const recMoved = reconcileWorkspace(mdir, {})
ok('moved Blitz items leave the root canvas after reconcile while web browsers remain', !(recMoved?.surfaces || []).some((s) => ['note1', 'app1', 'wid1', docs?.id].includes(s.id)) && (recMoved?.surfaces || []).some((s) => s.id === 'web1'))
const openedNote = openFolderEntry(mdir, `${target.folder}/project-note.md`, { x: 500, y: 300 })
const openedWeb = openFolderEntry(mdir, `${target.folder}/manual-web.weblink`, { x: 500, y: 300 })
const openedApp = openFolderEntry(mdir, `${target.folder}/app-blitz-dev.weblink`, { x: 500, y: 300 })
const openedWidget = openFolderEntry(mdir, `${target.folder}/widget.html`, { x: 500, y: 300 })
const openedPng = openFolderEntry(mdir, `${target.folder}/asset.png`, { x: 500, y: 300 })
const openedSubfolder = openFolderEntry(mdir, `${target.folder}/Docs`, { x: 500, y: 300 })
const openedNestedDoc = openFolderEntry(mdir, `${target.folder}/Docs/inside.md`, { x: 500, y: 300 })
ok('openFolderEntry restores .md as a note surface', openedNote.ok && openedNote.surface?.component === 'note')
ok('openFolderEntry restores .weblink as web/app using metadata', openedWeb.ok && openedWeb.surface?.kind === 'web' && openedApp.ok && openedApp.surface?.kind === 'app')
ok('openFolderEntry restores html as srcdoc widget', openedWidget.ok && openedWidget.surface?.kind === 'srcdoc')
ok('openFolderEntry opens ordinary files as file tiles', openedPng.ok && openedPng.surface?.component === 'file')
ok('openFolderEntry restores subfolders as dir surfaces', openedSubfolder.ok && openedSubfolder.surface?.component === 'dir')
ok('openFolderEntry restores nested descendants inside subfolders', openedNestedDoc.ok && openedNestedDoc.surface?.component === 'note')
const keepNested = removeSurfaceFile(mdir, openedNote.id)
ok('closing an opened nested Blitz item removes the canvas node but keeps the file', keepNested.ok && keepNested.keptFile === true && existsSync(join(mdir, target.folder, 'project-note.md')))
writeFileSync(join(mdir, 'asset.png'), Buffer.from([1, 1, 1]))
const movedOut = moveOutOfFolder(
  mdir,
  [
    `${target.folder}/project-note.md`,
    `${target.folder}/manual-web.weblink`,
    `${target.folder}/app-blitz-dev.weblink`,
    `${target.folder}/widget.html`,
    `${target.folder}/asset.png`,
    `${target.folder}/Docs`,
    'example-com.weblink',
    `${target.folder}/missing.md`,
    `${target.folder}/../bad.md`,
    `${target.folder}/.hidden`
  ],
  { x: 700, y: 420 }
)
ok('moveOutOfFolder moves nested entries to root and rejects unsafe/root paths', movedOut.ok && movedOut.moved === 6 && movedOut.skipped === 4 && movedOut.movedPaths?.includes('project-note.md') && movedOut.movedPaths?.includes('manual-web.weblink') && movedOut.movedPaths?.includes('app-blitz-dev.weblink') && movedOut.movedPaths?.includes('widget.html') && movedOut.movedPaths?.includes('asset-2.png') && movedOut.movedPaths?.includes('Docs') && movedOut.skippedPaths?.includes('example-com.weblink'))
const outKinds = new Map((movedOut.surfaces || []).map((s) => [s.id, s]))
ok('moveOutOfFolder returns real Blitz surfaces and preserves open ids', outKinds.get(openedWeb.id)?.kind === 'web' && outKinds.get(openedApp.id)?.kind === 'app' && outKinds.get(openedWidget.id)?.kind === 'srcdoc' && outKinds.get(openedPng.id)?.component === 'file' && outKinds.get(openedSubfolder.id)?.component === 'dir')
const afterOutArchive = listDir(mdir, target.folder)
ok('moveOutOfFolder removes moved entries from folder listing', !!afterOutArchive && ['project-note.md', 'manual-web.weblink', 'app-blitz-dev.weblink', 'widget.html', 'asset.png', 'Docs'].every((name) => !afterOutArchive.entries.some((e) => e.name === name)))
const recOut = reconcileWorkspace(mdir, {})
const outNote = (movedOut.surfaces || []).find((s) => s.component === 'note')
ok('moveOutOfFolder surfaces moved root entries on reconcile', (recOut?.surfaces || []).some((s) => s.id === outNote?.id) && (recOut?.surfaces || []).some((s) => s.props?.path === 'asset-2.png') && (recOut?.surfaces || []).some((s) => s.props?.path === 'Docs'))
const movedOutMeta = JSON.parse(readFileSync(join(mdir, '.blitzos', 'workspace.json'), 'utf8'))
const movedNestedDocNode = (movedOutMeta.nodes || []).find((n) => n.id === openedNestedDoc.id)
ok('moveOutOfFolder returns updated already-open descendants when moving a parent folder', movedOut.pathMoves?.some((m) => m.from === `${target.folder}/Docs` && m.to === 'Docs') && movedOut.updatedIds?.includes(openedNestedDoc.id) && movedNestedDocNode?.path === 'Docs/inside.md')
ok('moveOutOfFolder leaves the source folder tile with the updated item count', (recOut?.surfaces || []).find((s) => s.component === 'dir' && s.props?.path === target.folder)?.props?.entries === 0)

console.log('\n# close = delete the file, EXPLICITLY by id (the "window pops back up" bug)')
const cdir = join(tmp, 'closews')
mkdirSync(cdir, { recursive: true })
const noteA = { id: 'A', kind: 'native', component: 'note', title: 'A', x: 0, y: 0, w: 200, h: 200, z: 1, props: { text: 'aaa' } }
const noteB = { id: 'B', kind: 'native', component: 'note', title: 'B', x: 0, y: 0, w: 200, h: 200, z: 2, props: { text: 'bbb' } }
const webC = { id: 'C', kind: 'web', title: 'C', url: 'https://example.com', x: 0, y: 0, w: 200, h: 200, z: 3, props: {} }
const contentFiles = () => readdirSync(cdir).filter((f) => /\.(md|weblink|html)$/.test(f) && f !== 'BLITZOS.md')
writeWorkspace(cdir, { surfaces: [noteA, noteB, webC], camera: { x: 0, y: 0, scale: 1 } })
ok('3 content files written (2 notes + 1 weblink)', contentFiles().length === 3)
// the user closes note B → the renderer calls closeSurfaceFile('B') (explicit, by id)
const rmB = removeSurfaceFile(cdir, 'B')
ok('removeSurfaceFile reports the deleted file', rmB.ok && /\.md$/.test(rmB.removed))
ok('only B was deleted (2 content files left)', contentFiles().length === 2)
const recAfterClose = reconcileWorkspace(cdir, {})
ok('reconcile does NOT resurrect closed B (A + C remain)', (recAfterClose?.surfaces || []).filter((s) => s.component === 'note' || s.kind === 'web').length === 2)
ok('closing a non-existent id is a safe no-op', removeSurfaceFile(cdir, 'NOPE').ok === false)

console.log('\n# SAFETY: an empty/partial state push must NEVER mass-delete (explicit-only)')
writeWorkspace(cdir, { surfaces: [], camera: { x: 0, y: 0, scale: 1 } }) // e.g. a pre-hydrate or buggy push
ok('writeWorkspace with [] does NOT delete the surviving files', contentFiles().length === 2)

console.log('\n# close NEVER deletes a real dropped file (only BlitzOS content files)')
writeFileSync(join(ext, 'keep.png'), Buffer.from([1, 2, 3, 4]))
copyDroppedEntry(cdir, join(ext, 'keep.png'))
const recPng = reconcileWorkspace(cdir, {}) // registers keep.png as a file node with an id
const pngSurface = (recPng?.surfaces || []).find((s) => s.props?.path === 'keep.png')
ok('dropped png present + has a surface id', existsSync(join(cdir, 'keep.png')) && !!pngSurface)
ok('closing the file tile does NOT delete the real file', removeSurfaceFile(cdir, pngSurface.id).ok === false && existsSync(join(cdir, 'keep.png')))

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
