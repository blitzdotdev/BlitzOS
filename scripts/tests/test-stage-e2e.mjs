// Home desktop E2E over the REAL shared stack — the SAME makeOsTools registry every transport binds,
// a store-faithful ops layer, and the REAL workspace serializer round-trip. No display needed.
// Single-canvas model (plans/blitzos-single-canvas-navigation.md): ONE bounded "home" region, no stages.
// Run: node scripts/tests/test-stage-e2e.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeOsToolsByPath } from '../../src/main/os-tools.mjs'
import { writeWorkspace, readWorkspace } from '../../src/main/workspace.mjs'
import { latticeFor, cardRect, slotOf, spanOf, occupancy, HOME_BUDGET } from '../../src/renderer/src/stage-core.mjs'
import { homeRect } from '../../src/renderer/src/stages-core.mjs'

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

const dir = mkdtempSync(join(tmpdir(), 'home-e2e-'))
const VP = { w: 1600, h: 1000 }
const osState = { surfaces: [], viewport: VP, camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' }
let nextId = 1

// Store-faithful ops: createSurface derives slotted geometry from the cell exactly like the renderer
// (cardRect), updateSurface merges patches (null clears a key) — the contract the tools rely on. There
// is ONE home lattice now, so a slot has no stage and cardRect takes no stage argument.
const ops = {
  createSurface: (a) => {
    const id = a.id || 's' + nextId++
    const s = { id, kind: a.kind, x: a.x ?? 0, y: a.y ?? 0, w: a.w ?? 240, h: a.h ?? 240, z: nextId, title: a.title || a.url || a.kind, url: a.url, html: a.html, component: a.component, props: a.props || {} }
    if (a.pinned) s.pinned = true
    if (a.slot) {
      const r = cardRect(latticeFor(VP), a.slot.col, a.slot.row, a.slot.size)
      s.slot = { ...a.slot }
      Object.assign(s, r)
    }
    osState.surfaces.push(s)
    return id
  },
  openWindow: (a) => ops.createSurface({ ...a, kind: 'web' }),
  updateSurface: (id, patch) => {
    const s = osState.surfaces.find((x) => x.id === id)
    if (!s) return { ok: false, error: `no surface ${id}` }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete s[k]
      else s[k] = v
    }
    return { ok: true }
  },
  moveSurface: (id, x, y) => {
    const s = osState.surfaces.find((w) => w.id === id)
    if (!s) return { ok: false, error: 'missing' }
    s.x = x
    s.y = y
    return { ok: true }
  },
  closeSurface: (id) => {
    const i = osState.surfaces.findIndex((w) => w.id === id)
    if (i < 0) return { ok: false, error: 'missing' }
    osState.surfaces.splice(i, 1)
    return { ok: true }
  },
  goToPrimary: () => {},
  getState: () => osState,
  workspaceContext: () => ({ workspace: 'T', workspace_path: dir, siblings: [] }),
  integrationStatuses: () => []
}
const tools = makeOsToolsByPath(ops)
const call = async (path, body) => {
  const r = await tools[path].handler({ body: JSON.stringify(body || {}), transport: 'localhost' })
  return r && r.status ? { __status: r.status, ...(r.body || {}) } : r
}

// ---- 0. catalog widgets must be spawned as widgets, not native components ----
{
  const before = osState.surfaces.length
  const badCreate = await call('/create_surface', { kind: 'native', component: 'pipeline' })
  ok(badCreate.__status === 400 && /library widget/.test(badCreate.error || '') && /spawn_widget/.test(badCreate.error || ''), 'create_surface rejects catalog widget as native')
  const badPlace = await call('/place_widget', { kind: 'native', component: 'pipeline' })
  ok(badPlace.__status === 400 && /library widget/.test(badPlace.error || '') && /spawn_widget/.test(badPlace.error || ''), 'place_widget rejects catalog widget as native')
  ok(osState.surfaces.length === before, 'bad native widget attempts do not create broken surfaces')
}

// ---- 1. web/app are born OFF-SCREEN: parked on the canvas outside the home rect ----
const outsideHome = (s) => {
  const r = homeRect(VP)
  return s.x + s.w <= r.x || s.x >= r.x + r.w || s.y + s.h <= r.y || s.y >= r.y + r.h
}
{
  const r = await call('/create_surface', { kind: 'web', url: 'https://example.com', title: 'Ex' })
  ok(r.offstage === true && /below home/.test(r.hint || ''), 'create web -> offstage + hint')
  const s = osState.surfaces.find((x) => x.id === r.id)
  ok(!s.slot && outsideHome(s), 'web surface parked OUTSIDE the home frame (below home)')
  const w = await call('/open_window', { url: 'https://news.ycombinator.com' })
  ok(w.offstage === true && outsideHome(osState.surfaces.find((x) => x.id === w.id)), 'open_window -> parked offstage')
}

// ---- 2. srcdoc auto-takes a free slot ----
{
  const r = await call('/create_surface', { kind: 'srcdoc', html: '<b>hi</b>', title: 'W1', w: 320, h: 320 })
  ok(!r.offstage && r.slot && Number.isInteger(r.slot.col), `srcdoc auto-slots (got ${JSON.stringify(r.slot)})`)
  const s = osState.surfaces.find((x) => x.id === r.id)
  const expect = cardRect(latticeFor(VP), r.slot.col, r.slot.row, r.slot.size)
  ok(s.x === expect.x && s.y === expect.y && s.w === expect.w && s.h === expect.h, 'slotted geometry derives from the cell (cardRect)')
}

// ---- 3. place_widget create + near-id adjacency ----
{
  const a = await call('/place_widget', { kind: 'srcdoc', html: '<i>a</i>', size: 's', title: 'A' })
  ok(a.slot && a.id, 'place_widget creates into a slot')
  const b = await call('/place_widget', { kind: 'srcdoc', html: '<i>b</i>', size: 's', near: a.id, title: 'B' })
  const d = Math.abs(b.slot.col - a.slot.col) + Math.abs(b.slot.row - a.slot.row)
  ok(d === 1, `near:id lands adjacent (dist ${d})`)
}

// ---- 4. overlap invariant across everything on home so far ----
{
  const occ = occupancy(osState.surfaces)
  const sum = osState.surfaces.reduce((n, s) => {
    const sl = slotOf(s)
    if (!sl) return n
    const sp = spanOf(sl.size)
    return n + sp.c * sp.r
  }, 0)
  ok(occ.size === sum, `no double-booked cell (occ ${occ.size} = spans ${sum})`)
}

// ---- 5. budget -> home_full, pinned exempt ----
{
  let full = null
  for (let i = 0; i < 40 && !full; i++) {
    const r = await call('/place_widget', { kind: 'srcdoc', html: '<u>x</u>', size: 's', title: 'fill' + i })
    if (r.__status === 409) full = r
  }
  ok(full && full.error === 'home_full', 'budget overflow returns home_full (409)')
  ok(full.budget && full.budget.total === HOME_BUDGET && full.budget.used <= HOME_BUDGET, `reply carries budget (used ${full?.budget?.used}/${full?.budget?.total})`)
  ok(Array.isArray(full.tiles) && full.tiles.length > 0, 'reply lists current tiles (evict targets)')
  // pinned (system chat) is EXEMPT: a pinned create with a slot passes straight through
  const chat = await call('/create_surface', { kind: 'srcdoc', html: '<b>chat</b>', title: 'Chat', role: 'chat', pinned: true, slot: { col: 6, row: 0, size: 'tall' } })
  const cs = osState.surfaces.find((x) => x.id === chat.id)
  ok(cs && cs.slot && cs.pinned, 'pinned chat tile bypasses the budget')
}

// ---- 6. send_offscreen / bring_home round-trip ----
{
  const victim = osState.surfaces.find((s) => s.slot && !s.pinned)
  const r1 = await call('/send_offscreen', { id: victim.id })
  ok(r1.ok && r1.offstage && !victim.slot && outsideHome(victim), 'send_offscreen clears the slot + parks below home')
  const r2 = await call('/bring_home', { id: victim.id, size: 's' })
  ok(r2.slot && victim.slot && !outsideHome(victim), 'bring_home re-slots it inside home')
}

// ---- 7. list_state carries the home grid + the off-screen pool + per-surface fields ----
{
  const ls = await call('/list_state', {})
  ok(ls.grid && ls.grid.grid && ls.grid.budget && typeof ls.grid.free_cells === 'number', 'list_state.grid summary present')
  ok(Array.isArray(ls.offstage) && ls.offstage.length >= 2, `list_state.offstage = off-screen pool (${ls.offstage?.length})`)
  const anySlot = ls.surfaces.find((s) => s.slot)
  ok(anySlot && anySlot.slot.size, 'surfaces carry slot')
  ok(ls.surfaces.some((s) => s.offstage === true), 'surfaces carry computed offstage')
  ok(ls.grid.fits && typeof ls.grid.fits.xl === 'boolean', 'grid.fits per size')
  // The whitelist must NOT leak any stage bookkeeping (the live-state leak the refactor closed).
  ok(!('stage' in ls) && !('stageCount' in ls) && !('stageOrder' in ls) && !('currentStage' in ls) && !('currentStageRect' in ls) && !('backstage' in ls), 'list_state exposes NO stage/backstage fields (whitelist)')
}

// ---- 8. persistence round-trip through the REAL serializer ----
{
  writeWorkspace(dir, osState)
  const back = readWorkspace(dir)
  ok(back && Array.isArray(back.surfaces), 'workspace round-trip readable')
  const slotted = back.surfaces.filter((s) => s.slot)
  const offstage = back.surfaces.filter((s) => !s.slot && outsideHome(s))
  ok(slotted.length >= 3, `slots survive persistence (${slotted.length} tiles)`)
  ok(slotted.every((s) => Number.isInteger(s.slot.col) && typeof s.slot.size === 'string'), 'persisted slots are normalized')
  ok(offstage.length >= 2, `offstage parking survives persistence as plain geometry (${offstage.length})`)
  ok(back.surfaces.every((s) => s.zone === undefined), 'no zone field persisted — offstage is geometric')
  ok(back.surfaces.every((s) => s.slotStage === undefined && s.slotArea === undefined), 'no stage fields persisted — there is one home region')
}

console.log(`\n${pass} passed, ${fail} failed`)
rmSync(dir, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
