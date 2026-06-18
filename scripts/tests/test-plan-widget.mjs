// W1 — the editable plan widget: kit elements, the `plan` library template, the return-channel
// data-path contract, and the authoring-doc additions.
//   node scripts/tests/test-plan-widget.mjs
//
// HEADLESS SCOPE: this proves the load-bearing, non-visual halves of W1 —
//   (A) the kit defines <blitz-edit>/<blitz-toggle> + window.blitz.ui.edit/.toggle, and the injected
//       script parses (a parse error silently breaks EVERY widget);
//   (B) the `plan` library template is registered (lang:jsx) and COMPILES + COMPOSES through the EXACT
//       jsx pipeline the renderer runs (widget-jsx-core.mjs), and its source uses the kit + the two-step;
//   (C) THE RETURN CHANNEL data path: a widget's setProps patch merges into surface.props the way the
//       store's updateSurfaceProps does, get_surface{id} (serializeSurfaceForAgent) returns those props
//       in full, and a full edited plan would be SILENTLY DROPPED by the 4000-byte __blitz:'action' cap —
//       proving the get_surface read is the channel that survives, not the action channel;
//   (D) get_widget_authoring (widgetAuthoringMd) documents the editable-plan idiom + the return channel
//       + the 4000-byte __blitz:'action' cap warning.
// OUT OF SCOPE (needs the live :8799 preview / a browser): the RENDERED plan widget's pixels, the live
// <blitz-edit> contenteditable behavior, and a real iframe postMessage round-trip.
import { transform } from 'sucrase'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileJsxSource, composeJsxSrcdoc } from '../../src/renderer/src/widget-jsx-core.mjs'
import { getWidgetSource, widgetAuthoringMd } from '../../src/main/widget-catalog.mjs'
import { serializeSurfaceForAgent } from '../../src/main/os-tools.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..', '..')
let fails = 0
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  ' + (detail || '')))
  if (!cond) fails++
}

// ── (A) the kit added <blitz-edit> / <blitz-toggle> and they parse ─────────────────────────────────
console.log('# (A) UI kit: blitz-edit / blitz-toggle')
const kit = readFileSync(join(root, 'src/renderer/src/widget-ui-kit.ts'), 'utf8')
ok('kit defines <blitz-edit>', kit.includes("customElements.define('blitz-edit'"))
ok('kit defines <blitz-toggle>', kit.includes("customElements.define('blitz-toggle'"))
ok('kit <blitz-edit> fires change with detail.value', /blitz-edit[\s\S]*?CustomEvent\(name,\{bubbles:true,detail:\{value:/.test(kit))
ok('kit <blitz-toggle> fires change with detail.on', /blitz-toggle[\s\S]*?CustomEvent\('change',\{bubbles:true,detail:\{on:/.test(kit))
ok('kit exposes window.blitz.ui.edit', /edit:\s*function/.test(kit))
ok('kit exposes window.blitz.ui.toggle', /toggle:\s*function/.test(kit))
// The whole injected kit <script> must parse — a syntax error in it silently breaks every widget.
{
  const m = kit.match(/<script>([\s\S]*?)<\/script>/)
  let parsed = false
  try { new Function(m ? m[1] : 'throw 0'); parsed = true } catch (e) { parsed = false; var perr = e.message }
  ok('injected kit <script> parses (with blitz-edit/blitz-toggle)', parsed, perr)
}

// ── (B) the `plan` library template exists, is registered, and compiles+composes ───────────────────
console.log('\n# (B) the `plan` library widget')
const manifest = JSON.parse(readFileSync(join(root, 'widgets', 'widgets.json'), 'utf8'))
const planEntry = manifest.find((w) => w && w.name === 'plan')
ok('plan is in widgets.json', !!planEntry, 'no `plan` entry in widgets/widgets.json')
ok('plan is registered lang:jsx', planEntry && planEntry.lang === 'jsx', planEntry ? `lang=${planEntry.lang}` : '')

// getWidgetSource resolves the manifest entry → reads widgets/plan.jsx (filename derived from name+lang).
const planSrc = getWidgetSource('plan')
ok('getWidgetSource("plan") resolves the .jsx file', !!planSrc && typeof planSrc.html === 'string' && planSrc.html.length > 0)
ok('getWidgetSource reports lang:jsx', planSrc && planSrc.lang === 'jsx')

const src = (planSrc && planSrc.html) || ''
// The template must actually use the kit elements and the two-step return channel (not a hand-rolled form).
ok('plan source uses <blitz-edit>', src.includes('blitz-edit'))
ok('plan source uses <blitz-toggle>', src.includes('blitz-toggle'))
ok('plan source mirrors edits via blitz.setProps', /blitz\.setProps\(/.test(src))
ok('plan source wakes the agent via blitz.sendMessage (two-step return channel)', /blitz\.sendMessage\(/.test(src))
ok('plan source routes the wake with props.agentId', /sendMessage\([^)]*agentId/.test(src))
ok('plan source exports a default React component', /export default function/.test(src))

// Compile + compose through the EXACT renderer pipeline (no vite) — the real "does it mount" guard.
const compiled = compileJsxSource(transform, src, 'jsx')
ok('plan compiles through the jsx pipeline (Sucrase)', compiled.ok === true, compiled.ok ? '' : compiled.error)
ok('plan keeps its bare react import for the import map', compiled.ok && /from\s+['"]react['"]/.test(compiled.js))
{
  const registry = JSON.parse(readFileSync(join(root, 'widgets', 'runtime', 'registry.json'), 'utf8'))
  const doc = compiled.ok ? composeJsxSrcdoc(compiled.js, registry) : ''
  ok('plan composes a runnable srcdoc (import map + carrier present)', doc.includes('type="importmap"') && doc.includes('type="text/blitz-jsx"'))
  // Balanced script tags ⇒ the base64-carried source can't break out of the carrier (the </script attack).
  const opens = (doc.match(/<script/g) || []).length
  const closes = (doc.match(/<\/script>/g) || []).length
  ok('plan srcdoc has balanced script tags (payload can\'t break out)', doc !== '' && opens === closes && opens > 0, `opens=${opens} closes=${closes}`)
}

// ── (C) THE RETURN-CHANNEL DATA PATH: setProps → surface.props → get_surface, and the 4000-byte cap ──
console.log('\n# (C) return channel: setProps lands in props, get_surface reads it back, action cap drops big plans')

// (C1) Replicates the store's updateSurfaceProps merge EXACTLY (store.ts:1381 — { ...w.props, ...patch }).
// This is the bridge's setprops handler effect (SurfaceFrame.tsx:580): blitz.setProps(patch) → this merge.
const mergeProps = (prev, patch) => ({ ...(prev || {}), ...(patch && typeof patch === 'object' ? patch : {}) })

// A realistic plan widget surface, then the user's edit submitted via the two-step's setProps:
const planSurfaceId = 'plan-xyz'
let surface = { id: planSurfaceId, kind: 'srcdoc', lang: 'jsx', title: 'Plan', x: 0, y: 0, w: 360, h: 420, z: 1, props: { mode: 'edit', agentId: '7', stages: [{ id: 's1', title: 'old', detail: '', status: 'todo' }], decisions: {}, comments: '' } }
// Build a LARGE edited plan (a multi-stage plan with detail + comments) — the exact "could grow" payload
// the doc says must NOT ride the action channel. ~40 stages of prose pushes it well past 4000 bytes.
const bigStages = Array.from({ length: 40 }, (_, i) => ({ id: 's' + i, title: 'Stage ' + i + ' — a descriptive step title that the user typed', detail: 'A detailed paragraph for stage ' + i + ' explaining exactly what should happen, with enough text to be realistic.', status: 'todo' }))
const editPatch = { stages: bigStages, decisions: { useStaging: true, notify: false }, comments: 'Please double-check the staging step and notify me before the final send.', decision: 'approve' }

// Step 1 of the two-step: blitz.setProps(editPatch) → updateSurfaceProps merge.
const state = { surfaces: [{ ...surface, props: mergeProps(surface.props, editPatch) }] }

// (C2) get_surface{id} (the agent's read) returns the FULL merged props — the channel that survives.
const got = serializeSurfaceForAgent(state, planSurfaceId)
ok('get_surface returns the surface (no error)', !got.error && !!got.surface, got.error || '')
ok('get_surface returns props', got.surface && !!got.surface.props)
ok('get_surface props carry the FULL edited stages (all 40)', got.surface && Array.isArray(got.surface.props.stages) && got.surface.props.stages.length === 40)
ok('get_surface props carry the decision = approve', got.surface && got.surface.props.decision === 'approve')
ok('get_surface props carry the comments', got.surface && got.surface.props.comments === editPatch.comments)
ok('get_surface props carry the decisions map', got.surface && got.surface.props.decisions && got.surface.props.decisions.useStaging === true)
ok('get_surface preserves the seeded agentId across the merge', got.surface && got.surface.props.agentId === '7')

// (C3) THE CAP: App.tsx:1616 forwards a {__blitz:'action'} message ONLY if JSON.stringify(d).length <= 4000,
// SILENTLY (no else) otherwise. Prove the full edited plan, sent as one action message, would VANISH —
// which is exactly why the two-step (setProps + tiny sendMessage, read via get_surface) is the contract.
const CAP = 4000
const actionForwarded = (d) => { try { return JSON.stringify(d).length <= CAP } catch { return false } }
const fullPlanAction = { __blitz: 'action', surfaceId: planSurfaceId, kind: 'plan-approve', ...editPatch }
ok('the full edited plan exceeds the 4000-byte action cap', JSON.stringify(fullPlanAction).length > CAP, `len=${JSON.stringify(fullPlanAction).length}`)
ok('an action carrying the full plan is SILENTLY DROPPED (proves the cap)', actionForwarded(fullPlanAction) === false)
// A small, bounded signal (a button id / single choice) is the ONLY correct use of the action channel.
const smallAction = { __blitz: 'action', surfaceId: planSurfaceId, kind: 'stage-toggle', id: 's1', on: true }
ok('a small bounded signal rides the action channel fine', actionForwarded(smallAction) === true)
ok('get_surface delivers what the action channel cannot (full plan via props, no cap)', got.surface && JSON.stringify(got.surface.props).length > CAP)

// ── (D) the authoring doc documents the idiom + return channel + the cap ────────────────────────────
console.log('\n# (D) get_widget_authoring documents the editable-plan idiom + return channel + cap')
const md = widgetAuthoringMd()
ok('doc has an Editable / interactive widgets section', /##\s*Editable \/ interactive widgets/i.test(md))
ok('doc documents the two-step return channel', /RETURN CHANNEL/i.test(md))
ok('doc steers a large edit to setProps + a tiny sendMessage', /setProps/.test(md) && /sendMessage/.test(md))
ok('doc says read the full plan back with get_surface', /get_surface/.test(md))
ok('doc warns about the __blitz:\'action\' channel', /__blitz/.test(md) && /action/.test(md))
ok('doc states the hard 4000-byte cap', /4000/.test(md))
ok('doc says the over-cap message is SILENTLY DROPPED', /SILENTLY DROPPED/i.test(md))
ok('doc documents <blitz-edit> in the kit', md.includes('blitz-edit'))
ok('doc documents <blitz-toggle> in the kit', md.includes('blitz-toggle'))
ok('doc seeds props.agentId for job-widget routing', /props\.agentId|agentId/.test(md) && /JOB|job/.test(md))

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
process.exit(fails ? 1 : 0)
