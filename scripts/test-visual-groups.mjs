// Visual iPhone-style groups persist in workspace.json as layout metadata only.
// They must NOT move member files into real folders (that is groupIntoFolder's separate job).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeWorkspace, readWorkspace, reconcileWorkspace } from '../src/main/workspace.mjs'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '')
  }
}
const fresh = () => mkdtempSync(join(tmpdir(), 'aos-visual-group-'))
const web = (id, title, url, tabs) => ({
  id,
  kind: 'web',
  title,
  url,
  x: id === 'w1' ? 10 : 420,
  y: 20,
  w: 360,
  h: 260,
  z: id === 'w1' ? 1 : 2,
  ...(tabs ? { tabs, activeTab: 1 } : {})
})
const folder = (members) => ({
  id: 'folder-1',
  kind: 'native',
  component: 'folder',
  title: 'Research',
  x: 80,
  y: 90,
  w: 232,
  h: 248,
  z: 9,
  props: { members, open: true }
})
const metaPath = (d) => join(d, '.blitzos', 'workspace.json')

console.log('visual groups — workspace.json round trip:')
{
  const d = fresh()
  const tabs = [
    { id: 't1', title: 'One', url: 'https://example.com/one', favicon: 'runtime-only' },
    { id: 't2', title: 'Two', url: 'https://example.com/two', loading: true }
  ]
  writeWorkspace(d, {
    surfaces: [
      { ...web('w1', 'One', 'https://example.com/one', tabs), groupId: 'folder-1' },
      { ...web('w2', 'Two', 'https://example.org/two'), groupId: 'folder-1' },
      folder(['w1', 'w2'])
    ],
    camera: { x: 0, y: 0, scale: 1 },
    mode: 'desktop'
  })

  const meta = JSON.parse(readFileSync(metaPath(d), 'utf8'))
  ok('workspace.json has one visual group', Array.isArray(meta.groups) && meta.groups.length === 1, meta.groups)
  ok('visual group carries members + closed-restorable metadata', meta.groups?.[0]?.id === 'folder-1' && meta.groups[0].members.length === 2 && meta.groups[0].title === 'Research', meta.groups?.[0])
  ok('visual group is NOT a node', !meta.nodes.some((n) => n.id === 'folder-1'), meta.nodes.map((n) => n.id))
  ok('member browsers stayed as root .weblink files', readdirSync(d).filter((n) => n.endsWith('.weblink')).length === 2, readdirSync(d))
  ok('no real folder was created for the visual group', !existsSync(join(d, 'Research')) && !existsSync(join(d, 'research')), readdirSync(d))

  const w1File = readdirSync(d).find((n) => n.endsWith('.weblink') && readFileSync(join(d, n), 'utf8').includes('example.com/one'))
  const link = JSON.parse(readFileSync(join(d, w1File), 'utf8'))
  ok('browser tabs still persist inside .weblink', Array.isArray(link.tabs) && link.tabs.length === 2 && link.activeTab === 1, link)

  const back = readWorkspace(d)
  const w1 = back?.surfaces.find((s) => s.id === 'w1')
  const w2 = back?.surfaces.find((s) => s.id === 'w2')
  const gf = back?.surfaces.find((s) => s.id === 'folder-1')
  ok('hydrated members regain groupId', w1?.groupId === 'folder-1' && w2?.groupId === 'folder-1', { w1, w2 })
  ok('hydrated folder surface is recreated closed', gf?.component === 'folder' && gf.props?.open === false && gf.props?.members?.length === 2, gf)
  rmSync(d, { recursive: true, force: true })
}

console.log('\nvisual groups — missing members are sanitized:')
{
  const d = fresh()
  writeWorkspace(d, {
    surfaces: [web('w1', 'One', 'https://example.com/one'), web('w2', 'Two', 'https://example.org/two'), web('w3', 'Three', 'https://example.net/three')],
    camera: { x: 0, y: 0, scale: 1 },
    mode: 'desktop'
  })
  const meta = JSON.parse(readFileSync(metaPath(d), 'utf8'))
  meta.groups = [
    { id: 'keep', title: 'Keep', x: 1, y: 2, w: 232, h: 248, z: 4, members: ['w1', 'missing', 'w2'] },
    { id: 'drop', title: 'Drop', x: 1, y: 2, w: 232, h: 248, z: 5, members: ['w3', 'missing'] }
  ]
  writeFileSync(metaPath(d), JSON.stringify(meta, null, 2))
  const back = readWorkspace(d)
  ok('group with at least two restored members survives reduced', back?.surfaces.find((s) => s.id === 'keep')?.props?.members?.join(',') === 'w1,w2', back?.surfaces)
  ok('group with fewer than two restored members is ignored', !back?.surfaces.some((s) => s.id === 'drop'), back?.surfaces)
  rmSync(d, { recursive: true, force: true })
}

console.log('\nvisual groups — reconcile preserves persisted group metadata:')
{
  const d = fresh()
  writeWorkspace(d, {
    surfaces: [
      { ...web('w1', 'One', 'https://example.com/one'), groupId: 'folder-1' },
      { ...web('w2', 'Two', 'https://example.org/two'), groupId: 'folder-1' },
      folder(['w1', 'w2'])
    ],
    camera: { x: 0, y: 0, scale: 1 },
    mode: 'desktop'
  })
  writeFileSync(join(d, 'new-note.md'), '# new\n')
  reconcileWorkspace(d, { cx: 0, cy: 0 })
  const meta = JSON.parse(readFileSync(metaPath(d), 'utf8'))
  ok('reconcile rewrite keeps valid visual group', meta.groups?.length === 1 && meta.groups[0].members.join(',') === 'w1,w2', meta.groups)
  rmSync(d, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
