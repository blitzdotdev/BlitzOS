// Phase 1 — the blitz.tool security seam: a sandboxed widget may call ONLY the closed allowlist, and the
// runner enforces it before dispatch. ONE shared allowlist (widget-tools.mjs) imported by both transports.
import { WIDGET_TOOLS, isWidgetTool, makeWidgetToolRunner } from '../src/main/widget-tools.mjs'

let pass = 0
let fail = 0
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)))

console.log('# the allowlist allows the intended OS tools')
for (const t of ['create_surface', 'open_window', 'move_surface', 'update_surface', 'close_surface', 'group', 'go_to_primary', 'list_state', 'provider_call']) ok('allows ' + t, isWidgetTool(t))

console.log('\n# …and DENIES everything dangerous / off-list (no relay pass-through)')
for (const t of ['eval', 'surface_control', 'read_window', 'save_widget', 'customize_widget', '__proto__', 'constructor', '', 'createSurface']) ok('denies ' + JSON.stringify(t), !isWidgetTool(t))
ok('the allowlist is exactly the 9 intended tools', WIDGET_TOOLS.length === 9)

console.log('\n# the runner enforces the allowlist + never throws')
const calls = []
const run = makeWidgetToolRunner({
  create_surface: (a, ctx) => {
    calls.push(['create', a, ctx])
    return { id: 's1' }
  },
  group: () => {
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
const r4 = await run('group', {})
ok('a throwing handler → ok:false with the message (never throws)', r4.ok === false && /boom/.test(r4.error))
ok('non-object args are coerced safely', (await run('create_surface', 'nope')).ok === true)

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
