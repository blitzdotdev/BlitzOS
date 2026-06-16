// #52 — prove "group into folder" is a REAL filesystem op: mkdir a subdir + mv the members' files in;
// the result is ONE folder tile (reconcile is non-recursive, so a many-file folder/repo stays one tile).
import { writeWorkspace, readWorkspace, reconcileWorkspace, groupIntoFolder, removeSurfaceFile } from '../../src/main/workspace.mjs'
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
const fresh = () => mkdtempSync(join(tmpdir(), 'aos-folder-'))
const note = (id, text) => ({ id, kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 1, title: id, props: { text } })

console.log('groupIntoFolder — real mkdir + mv:')
{
  const d = fresh()
  // a board with 3 notes (each becomes a real .md content file at root)
  writeWorkspace(d, { surfaces: [note('a', '# A'), note('b', '# B'), note('c', '# C')], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' })
  const rootBefore = readdirSync(d).filter((n) => n.endsWith('.md') && n !== 'BLITZOS.md')
  ok('3 root .md files written', rootBefore.length === 3, rootBefore)

  const r = groupIntoFolder(d, 'My Notes', ['a', 'b'])
  ok('groupIntoFolder ok, moved 2', r.ok && r.moved === 2, r)
  ok('a REAL subdirectory was created', existsSync(join(d, r.folder)) && readdirSync(d).includes(r.folder), r.folder)
  const inFolder = readdirSync(join(d, r.folder)).filter((n) => n.endsWith('.md') && n !== 'BLITZOS.md')
  ok('the 2 members physically MOVED into the subdir', inFolder.length === 2, inFolder)
  const rootAfter = readdirSync(d).filter((n) => n.endsWith('.md') && n !== 'BLITZOS.md')
  ok('moved files are GONE from the root (real mv, not copy)', rootAfter.length === 1, rootAfter)

  // reconcile: the new subdir surfaces as ONE folder/dir tile; the moved notes are no longer loose root tiles.
  const rec = reconcileWorkspace(d, { cx: 0, cy: 0 })
  const dirTiles = rec.surfaces.filter((s) => s.component === 'dir')
  const looseNotes = rec.surfaces.filter((s) => s.component === 'note')
  ok('the folder is exactly ONE dir tile', dirTiles.length === 1, dirTiles.map((t) => t.title))
  ok('only the un-grouped note remains loose on the canvas', looseNotes.length === 1, looseNotes.map((t) => t.title))
  rmSync(d, { recursive: true, force: true })
}

console.log('\nscale: a folder/repo with MANY files inside is still ONE tile (non-recursive):')
{
  const d = fresh()
  writeWorkspace(d, { surfaces: [note('keep', '# keep')], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' })
  // simulate a cloned repo: a real subdir with 200 files inside (stand-in for 10k)
  const repo = join(d, 'big-repo')
  mkdirSync(repo, { recursive: true })
  for (let i = 0; i < 200; i++) writeFileSync(join(repo, `f${i}.txt`), 'x')
  const rec = reconcileWorkspace(d, { cx: 0, cy: 0 })
  const dirTiles = rec.surfaces.filter((s) => s.component === 'dir')
  const allTiles = rec.surfaces.length
  ok('the 200-file repo is ONE dir tile (contents NOT materialized)', dirTiles.length === 1 && dirTiles[0].title.toLowerCase().includes('repo'), dirTiles.map((t) => t.title))
  ok('total canvas tiles stays tiny (1 note + 1 repo tile), not 200', allTiles <= 3, allTiles)
  rmSync(d, { recursive: true, force: true })
}

console.log('\nedge: grouping a member that is itself a subdir nests it (real mv of a directory):')
{
  const d = fresh()
  writeWorkspace(d, { surfaces: [note('n1', '# n1')], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' })
  mkdirSync(join(d, 'sub'), { recursive: true })
  writeFileSync(join(d, 'sub', 'inner.txt'), 'x')
  // reconcile so 'sub' gets a node (id→path) we can reference
  let rec = reconcileWorkspace(d, { cx: 0, cy: 0 })
  const subTile = rec.surfaces.find((s) => s.component === 'dir')
  ok('the subdir surfaced as a dir tile (has an id)', !!subTile && !!subTile.id, subTile)
  if (subTile) {
    const r = groupIntoFolder(d, 'Group', [subTile.id])
    ok('moved the subdir into the new folder', r.ok && r.moved === 1 && existsSync(join(d, r.folder, 'sub', 'inner.txt')), r)
  }
  rmSync(d, { recursive: true, force: true })
}

console.log('\n#54: a .board folder SPLAYS its children onto the canvas (normal folder stays collapsed):')
{
  const d = fresh()
  writeWorkspace(d, { surfaces: [note('a', '# A'), note('b', '# B'), note('c', '# C')], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' })
  // group a+b into a NORMAL folder, and (separately) make a board from c by grouping with kind:'board'
  const norm = groupIntoFolder(d, 'Normal', ['a', 'b'], 'folder')
  ok('normal group → a plain subdir (no .board suffix)', norm.ok && !norm.folder.endsWith('.board'), norm.folder)
  const board = groupIntoFolder(d, 'My Board', ['c'], 'board')
  ok('board group → a ".board" subdir on disk', board.ok && board.folder.endsWith('.board') && existsSync(join(d, board.folder)), board.folder)

  const rec = reconcileWorkspace(d, { cx: 0, cy: 0 })
  const dirTiles = rec.surfaces.filter((s) => s.component === 'dir')
  const noteTiles = rec.surfaces.filter((s) => s.component === 'note')
  // the NORMAL folder is one collapsed dir tile (no .board path); the BOARD produced NO dir tile — its
  // child note was SPLAYED onto the canvas instead (a separate note surface carrying the child's content).
  ok('the normal folder is ONE collapsed dir tile (board did NOT add a tile)', dirTiles.length === 1 && !String(dirTiles[0].props?.path || '').endsWith('.board'), dirTiles.map((t) => t.props?.path))
  ok("the board's child note is splayed as a canvas tile (not collapsed)", noteTiles.length === 1 && String(noteTiles[0].props?.text || '').includes('C'), noteTiles.map((s) => s.props?.text))
  const boardFiles = readdirSync(join(d, board.folder)).filter((n) => n.endsWith('.md'))
  const closedBoardChild = noteTiles[0] ? removeSurfaceFile(d, noteTiles[0].id) : null
  ok("closing a board child still deletes that board file", !!closedBoardChild?.ok && !!boardFiles[0] && !existsSync(join(d, board.folder, boardFiles[0])), closedBoardChild)
  rmSync(d, { recursive: true, force: true })
}

console.log('\n#54 scale guard: an over-full .board falls back to ONE collapsed tile (never explodes):')
{
  const d = fresh()
  writeWorkspace(d, { surfaces: [note('keep', '# keep')], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' })
  mkdirSync(join(d, 'huge.board'), { recursive: true })
  for (let i = 0; i < 40; i++) writeFileSync(join(d, 'huge.board', `n${i}.md`), `# ${i}`) // > BOARD_CAP (24)
  const rec = reconcileWorkspace(d, { cx: 0, cy: 0 })
  const fromBoard = rec.surfaces.filter((s) => String(s.props?.path || s.props?.name || '').includes('huge'))
  ok('an over-cap board does NOT splay 40 tiles (stays one collapsed tile)', fromBoard.length === 1 && fromBoard[0].component === 'dir', fromBoard.length)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
