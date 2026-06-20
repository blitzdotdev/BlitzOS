// Phase 1 — the blitz.tool security seam: a sandboxed widget may call ONLY the closed allowlist, and the
// runner enforces it before dispatch. ONE shared allowlist (widget-tools.mjs) imported by both transports.
import { WIDGET_TOOLS, isWidgetTool, makeWidgetToolRunner, makeWidgetToolHandlers } from '../../src/main/widget-tools.mjs'

let pass = 0
let fail = 0
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)))

console.log('# the allowlist allows the intended OS tools')
for (const t of ['create_surface', 'open_window', 'update_surface', 'close_surface', 'list_state', 'set_theme']) ok('allows ' + t, isWidgetTool(t))

console.log('\n# …and DENIES everything dangerous / off-list (no relay pass-through)')
for (const t of ['eval', 'surface_control', 'read_window', 'save_widget', 'customize_widget', 'group', 'provider_call', '__proto__', 'constructor', '', 'createSurface']) ok('denies ' + JSON.stringify(t), !isWidgetTool(t))
ok('the allowlist is exactly the 8 intended tools', WIDGET_TOOLS.length === 8)

console.log('\n# the runner enforces the allowlist + never throws')
const calls = []
const run = makeWidgetToolRunner({
  create_surface: (a, ctx) => {
    calls.push(['create', a, ctx])
    return { id: 's1' }
  },
  set_theme: () => {
    throw new Error('boom')
  }
})
const r1 = await run('create_surface', { kind: 'note' }, { surfaceId: 'w1' })
ok('allowed + wired tool dispatches', r1.ok === true && r1.result.id === 's1')
ok('args + surfaceId reach the handler ctx', calls[0][1].kind === 'note' && calls[0][2].surfaceId === 'w1')
const r2 = await run('eval', {})
ok('denied tool → ok:false, "not allowed"', r2.ok === false && /not allowed for widgets/.test(r2.error))
const r3 = await run('open_window', {})
ok('allowlisted-but-unwired tool → ok:false, "not available"', r3.ok === false && /not available/.test(r3.error))
const r4 = await run('set_theme', {})
ok('a throwing handler → ok:false with the message (never throws)', r4.ok === false && /boom/.test(r4.error))
ok('non-object args are coerced safely', (await run('create_surface', 'nope')).ok === true)

// The widget HANDLER MAP is now built ONCE (makeWidgetToolHandlers) from a runtime's ops, so the contract is
// identical on Electron and the server (the divergence the consolidation audit found). Lock the shapes here.
console.log('\n# makeWidgetToolHandlers: ONE contract from injected ops (Electron==server)')
const opsCalls = []
const mockOps = {
  createSurface: (a) => (opsCalls.push(['createSurface', a]), 'mock-id-123'),
  openWindow: (a) => (opsCalls.push(['openWindow', a]), 'mock-id-456'),
  moveSurface: (id, x, y) => opsCalls.push(['moveSurface', id, x, y]),
  updateSurface: (id, patch) => opsCalls.push(['updateSurface', id, patch]),
  closeSurface: (id) => opsCalls.push(['closeSurface', id]),
  goToPrimary: () => opsCalls.push(['goToPrimary']),
  // raw full state, incl. html + props (the transcript) the handler must strip:
  getState: () => ({ workspace: 'W', workspace_path: '/w', camera: { x: 1 }, surfaces: [{ id: 'a', kind: 'srcdoc', x: 0, y: 0, w: 2, h: 3, z: 4, zoom: 1, title: 'T', url: 'u', component: 'c', pinned: true, html: '<b>SECRET</b>', props: { messages: ['PRIVATE'] } }] })
}
const H = makeWidgetToolHandlers(mockOps)

// findings #1/#2: create_surface / open_window return { id } OBJECT (not a bare string) — on BOTH transports.
ok('create_surface → { id } object (not string)', JSON.stringify(H.create_surface({ kind: 'note' })) === JSON.stringify({ id: 'mock-id-123' }))
ok('open_window → { id } object (not string)', JSON.stringify(H.open_window({ url: 'http://x' })) === JSON.stringify({ id: 'mock-id-456' }))
// findings #4/#5: validation matches the server (throws → runner returns ok:false) instead of silently no-op'ing.
const threw = (fn) => { try { fn(); return false } catch { return true } }
ok('create_surface throws on missing kind', threw(() => H.create_surface({})))
ok('open_window throws on missing url', threw(() => H.open_window({})))
ok('update_surface throws on missing id', threw(() => H.update_surface({ url: 'u' })))
ok('close_surface throws on missing id', threw(() => H.close_surface({})))
const explicitClose = H.close_surface({ id: 'explicit-widget' }, { surfaceId: 'self-widget' })
ok('close_surface with explicit id closes that surface', explicitClose.ok === true && opsCalls.some((c) => c[0] === 'closeSurface' && c[1] === 'explicit-widget'))
const selfClose = H.close_surface({}, { surfaceId: 'self-widget' })
ok('close_surface defaults to the calling widget id when ctx has surfaceId', selfClose.ok === true && opsCalls.some((c) => c[0] === 'closeSurface' && c[1] === 'self-widget'))
ok('self-close does not change chat status', !opsCalls.some((c) => c[0] === 'setChatStatus'))
// update_surface strips id from a flat patch, returns { ok:true }
const u = H.update_surface({ id: 's', url: 'newurl' })
const upd = opsCalls.find((c) => c[0] === 'updateSurface')
ok('update_surface → ok:true, id stripped from patch', u.ok === true && upd[1] === 's' && upd[2].url === 'newurl' && !('id' in upd[2]))
// finding #3: list_state returns WHITELISTED layout fields only — no html, no props/transcript leak.
const ls = H.list_state()
const s0 = ls.surfaces[0]
ok('list_state keeps surface essentials + workspace (V1: no layout fields)', s0.id === 'a' && s0.kind === 'srcdoc' && s0.title === 'T' && ls.workspace === 'W' && ls.workspace_path === '/w')
ok('list_state DROPS html + props (no transcript leak)', !('html' in s0) && !('props' in s0))
// the handler map is exactly the allowlist (no extra / missing tools)
ok('handler keys === the allowlist', JSON.stringify(Object.keys(H).sort()) === JSON.stringify([...WIDGET_TOOLS].sort()))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
