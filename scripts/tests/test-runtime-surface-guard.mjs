// Regression test for the runtime-surface-loss fragility (the chat-widget-vanishing + junk-resurrection
// bugs). Drives the REAL shared workspace host with a fake adapter + a real temp dir — exactly what
// backend.mjs / osActions wire. Asserts onStatePush:
//   (A) RE-ASSERTS host-owned runtime surfaces (the agent chat widget) when a renderer push drops them, so
//       a mid-hydrate/incomplete push can never delete the chat from osState;
//   (B) REJECTS a stale re-push of a surface we just authoritatively closed, so a still-connected renderer
//       can't resurrect it.
//   node scripts/test-runtime-surface-guard.mjs
import { createWorkspaceHost } from '../../src/main/workspace-host.mjs'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const ok = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '') }
}
const note = (id, text) => ({ id, kind: 'native', component: 'note', x: 0, y: 0, w: 300, h: 200, z: 1, title: id, props: { text } })

const root = mkdtempSync(join(tmpdir(), 'aos-rtsg-'))
// Seed a file-backed note BEFORE boot so hydrate surfaces it (used for the close-then-resurrect test).
const homeDir = join(root, 'Home')
mkdirSync(homeDir, { recursive: true })
writeFileSync(join(homeDir, 'junk.md'), '# junk note (test)')

let osState = { surfaces: [], camera: { x: 0, y: 0, scale: 1 }, mode: 'canvas' }
let storeItems = [] // the AUTHORITATIVE action-items store (what listActions() returns) — drives the inbox reconcile
const host = createWorkspaceHost({
  root,
  initialName: 'Home',
  getState: () => osState,
  setState: (s) => { osState = s },
  broadcast: () => {},
  onSurfaces: () => {},
  getActionItems: () => storeItems,
  defaultMode: 'canvas'
})

console.log('runtime-surface-loss guard — onStatePush:')
host.hydrateOnBoot()
const chat0 = osState.surfaces.find((s) => s.id === 'chat')
ok('hydrate builds the primary chat widget (id "chat")', !!chat0, osState.surfaces.map((s) => s.id))

// (A) a renderer pushes a state that DROPPED the chat (e.g. mid-hydrate) → the host must re-assert it.
host.onStatePush({ surfaces: [note('x', '# X')] })
ok('A: chat re-asserted after a push that dropped it', osState.surfaces.some((s) => s.id === 'chat'))
ok('A: the dropping push still applied its own surface', osState.surfaces.some((s) => s.id === 'x'))

// (A2) a normal push that INCLUDES the chat → not duplicated.
host.onStatePush({ surfaces: [note('y', '# Y'), { id: 'chat', kind: 'native', component: 'chat', x: 0, y: 0, w: 320, h: 480, role: 'chat', props: {} }] })
ok('A2: chat not duplicated when the push includes it', osState.surfaces.filter((s) => s.id === 'chat').length === 1)

// (B) close a file-backed surface, then a still-connected renderer re-pushes it → must be rejected.
// Seed the id->file mapping (workspace.json `nodes[].path`) that closeSurfaceFile reads, synchronously
// right before the close so no debounced flush intervenes; the .md file backs id 'junk'.
mkdirSync(join(homeDir, '.blitzos'), { recursive: true })
writeFileSync(join(homeDir, '.blitzos', 'workspace.json'), JSON.stringify({ version: 1, nodes: [{ id: 'junk', kind: 'note', path: 'junk.md', x: 0, y: 0, w: 300, h: 200 }] }))
const junkSurf = note('junk', '# junk note (test)')
const r = host.closeSurfaceFile('junk')
ok('B: closeSurfaceFile removed the backing file (ok)', r && r.ok, r)
host.onStatePush({ surfaces: [junkSurf, note('z', '# Z')] }) // renderer's store hasn't caught up — re-pushes junk
ok('B: the closed surface is NOT resurrected by the re-push', !osState.surfaces.some((s) => s.id === 'junk'), osState.surfaces.map((s) => s.id))
ok('B: a fresh surface in the same push still applies', osState.surfaces.some((s) => s.id === 'z'))

// (C) the inbox is a runtime surface; a renderer can push a STALE item list (carried in osState across page
// loads). onStatePush must overwrite it with the authoritative store so phantom items can't survive.
storeItems = [{ id: 'a1', title: 'Real', status: 'pending', kind: 'task', createdAt: 1, resolvedAt: null, resolution: null }]
const staleInbox = { id: 'inbox', kind: 'native', component: 'inbox', x: 0, y: 0, w: 320, h: 300, props: { items: [{ id: 'ghost', title: 'Phantom' }, { id: 'a1', title: 'Real' }] } }
host.onStatePush({ surfaces: [staleInbox] })
const inboxC = osState.surfaces.find((s) => s.component === 'inbox')
ok('C: onStatePush reconciles inbox items to the store (phantom dropped)', !!inboxC && inboxC.props.items.length === 1 && inboxC.props.items[0].id === 'a1', inboxC && inboxC.props.items.map((i) => i.id))

// (D) hydrateSurfaces() also reconciles — a fresh CONNECT can't receive a stale inbox even with no push since.
storeItems = [] // everything cleared in the store (e.g. via the relay/agent path, no renderer attached)
const hy = host.hydrateSurfaces()
const inboxD = hy.find((s) => s.component === 'inbox')
ok('D: hydrateSurfaces empties the inbox when the store is cleared (no phantom on a fresh connect)', !!inboxD && inboxD.props.items.length === 0, inboxD && inboxD.props.items)

rmSync(root, { recursive: true, force: true })
console.log(failures ? `\nFAIL ✗ ${failures}` : '\nPASS ✓ runtime-surface guard holds')
process.exit(failures ? 1 : 0)
