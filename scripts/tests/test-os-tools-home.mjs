// The shared tool registry, home-only contract (plans/blitzos-single-canvas-navigation.md). The
// single-canvas refactor renamed bring_to_stage→bring_home + send_backstage→send_offscreen, dropped the
// per-agent `agent` placement arg, and whitelisted list_state so no stage bookkeeping leaks. This binds
// makeOsTools to a minimal no-op ops and asserts that contract WITHOUT a display or any transport.
// Run: node scripts/tests/test-os-tools-home.mjs
import { makeOsTools } from '../../src/main/os-tools.mjs'

let pass = 0
let fail = 0
const ok = (c, m) => {
  if (c) {
    pass++
  } else {
    fail++
    console.log('  FAIL', m)
  }
}

// A minimal no-op ops: enough for the registry to build and for list_state/place_widget to run. getState
// returns a stub desktop state with one slotted surface so gridSummary has something real to summarize.
const STUB_STATE = {
  viewport: { w: 1600, h: 1000 },
  camera: { x: 0, y: 0, scale: 1 },
  mode: 'desktop',
  workspace: 'T',
  workspace_path: '/tmp/t',
  surfaces: [{ id: 'a', kind: 'srcdoc', x: 0, y: 0, w: 320, h: 320, z: 1, title: 'A', slot: { col: 0, row: 0, size: 'l' } }]
}
const ops = {
  createSurface: () => 'id',
  openWindow: () => 'id',
  moveSurface: () => ({ ok: true }),
  updateSurface: () => ({ ok: true }),
  closeSurface: () => ({ ok: true }),
  goToPrimary: () => {},
  getState: () => STUB_STATE,
  workspaceContext: () => ({ workspace: 'T', workspace_path: '/tmp/t', siblings: [] }),
  listWorkspaces: () => ({ workspaces: [], active: 'T', activePath: '/tmp/t', root: '/tmp' }),
  say: () => {}
}

const tools = makeOsTools(ops)
ok(Array.isArray(tools) && tools.length > 0, 'makeOsTools returns the registry array')

// ---- tool name list: the renames landed, the old names are gone ----
const names = new Set(tools.map((t) => t.path.replace(/^\//, '')))
ok(names.has('bring_home'), 'registry includes bring_home')
ok(names.has('send_offscreen'), 'registry includes send_offscreen')
ok(!names.has('bring_to_stage'), 'registry EXCLUDES the old bring_to_stage')
ok(!names.has('send_backstage'), 'registry EXCLUDES the old send_backstage')
// no path anywhere still carries the stage vocabulary
ok([...names].every((n) => !/stage|backstage/.test(n)), 'no tool path mentions stage/backstage')

// ---- place_widget no longer takes a per-agent stage arg ----
const placeWidget = tools.find((t) => t.path === '/place_widget')
ok(placeWidget, 'place_widget tool present')
ok(placeWidget && placeWidget.input_schema && placeWidget.input_schema.properties && !('agent' in placeWidget.input_schema.properties), 'place_widget input schema has NO `agent` property')
// the surviving placement knobs are size/near/id (slot system), not a stage index
ok(placeWidget.input_schema.properties.size && placeWidget.input_schema.properties.near && placeWidget.input_schema.properties.id, 'place_widget keeps size/near/id')

// ---- create_surface / open_window also drop the `agent` placement arg ----
for (const p of ['/create_surface', '/open_window', '/open_terminal']) {
  const t = tools.find((x) => x.path === p)
  ok(t, `${p} present`)
  const props = (t && t.input_schema && t.input_schema.properties) || {}
  ok(!('agent' in props), `${p} input schema has NO \`agent\` property`)
}

// ---- list_state: home-only whitelist (no stage leak), carries the home grid ----
const listState = tools.find((t) => t.path === '/list_state')
ok(listState, 'list_state tool present')
const ls = await listState.handler({ body: '{}', transport: 'localhost' })
ok(ls && typeof ls === 'object', 'list_state returns an object')
ok('grid' in ls, 'list_state includes `grid`')
ok(ls.grid && ls.grid.grid && ls.grid.budget && Array.isArray(ls.grid.tiles), 'list_state.grid is the gridSummary shape')
for (const banned of ['stage', 'stageCount', 'stageOrder', 'currentStage', 'currentStageRect', 'backstage', 'slotStage']) {
  ok(!(banned in ls), `list_state does NOT expose \`${banned}\``)
}
ok('offstage' in ls && Array.isArray(ls.offstage), 'list_state includes the off-screen pool as `offstage`')
ok(Array.isArray(ls.surfaces) && ls.surfaces[0] && ls.surfaces[0].slot, 'list_state.surfaces carry the slotted tile')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
