// Unit tests for the JSX widget compile core (src/renderer/src/widget-jsx-core.mjs) — the EXACT
// module the renderer runs (dependency-injected, so node exercises it without vite).
//   node scripts/test-widget-jsx.mjs
import { transform } from 'sucrase'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashSource, b64EncodeUtf8, compileJsxSource, buildImportMapScript, composeJsxSrcdoc, errorCardHtml } from '../src/renderer/src/widget-jsx-core.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
let failures = 0
const ok = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : '  ' + detail))
  if (!cond) failures++
}

// 1. golden JSX -> automatic-runtime ESM
{
  const r = compileJsxSource(transform, "export default function A(){ return <div id='x'>hi</div> }", 'jsx')
  ok('jsx compiles', r.ok === true)
  ok('jsx uses automatic runtime', r.ok && r.js.includes('react/jsx-runtime'), r.ok ? r.js : r.error)
  ok('jsx emits jsx() call', r.ok && /_jsx\(/.test(r.js))
  ok('jsx keeps bare imports intact', (() => {
    const r2 = compileJsxSource(transform, "import { X } from 'lucide-react'\nexport default () => <X/>", 'jsx')
    return r2.ok && r2.js.includes("from 'lucide-react'")
  })())
}

// 2. TSX strips types
{
  const r = compileJsxSource(transform, "export default function A({n}:{n:number}){ const s: string = 'v'; return <b>{s}{n}</b> }", 'tsx')
  ok('tsx compiles', r.ok === true, r.ok ? '' : r.error)
  ok('tsx strips annotations', r.ok && !r.js.includes(': string') && !r.js.includes(':{n:number}'))
}

// 3. syntax error -> {ok:false} with location, never a throw
{
  const r = compileJsxSource(transform, 'export default function A(){ return <div', 'jsx')
  ok('syntax error reported', r.ok === false && typeof r.error === 'string' && r.error.length > 0)
}

// 4. hash: stable, source- and lang-sensitive
{
  ok('hash stable', hashSource('abc', 'jsx') === hashSource('abc', 'jsx'))
  ok('hash varies by source', hashSource('abc', 'jsx') !== hashSource('abd', 'jsx'))
  ok('hash varies by lang', hashSource('abc', 'jsx') !== hashSource('abc', 'tsx'))
}

// 5. base64 round-trip: unicode + the </script> attack payload
{
  const nasty = 'const s = "</scr" + "ipt><script>alert(1)</scr" + "ipt>"; const e = "héllo 🚀 </script>"'
  const b64 = b64EncodeUtf8(nasty)
  const back = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
  ok('b64 round-trips unicode + </script>', back === nasty)
  ok('b64 output is tag-safe', !/[<>]/.test(b64))
}

// 6. composed srcdoc: structure + payload safety + registry mapping
{
  const registry = JSON.parse(readFileSync(join(__dirname, '..', 'widgets', 'runtime', 'registry.json'), 'utf8'))
  const r = compileJsxSource(transform, 'const a = "</scr"+"ipt>boom"; export default () => <i>{a}</i>', 'jsx')
  ok('compile for compose', r.ok === true)
  const doc = composeJsxSrcdoc(r.js, registry)
  const mapIdx = doc.indexOf('type="importmap"')
  const bootIdx = doc.indexOf('type="module"')
  const carrierIdx = doc.indexOf('type="text/blitz-jsx"')
  ok('import map present and before bootstrap', mapIdx !== -1 && bootIdx !== -1 && mapIdx < bootIdx)
  ok('carrier present', carrierIdx !== -1)
  // the only </script occurrences must be the carrier/bootstrap/importmap CLOSERS — count tags vs closers
  const opens = (doc.match(/<script/g) || []).length
  const closes = (doc.match(/<\/script>/g) || []).length
  ok('balanced script tags (payload cannot break out)', opens === closes && opens === 3, `opens=${opens} closes=${closes}`)
  ok('registry mapped: react pin', doc.includes(JSON.stringify(registry.react)))
  ok('registry mapped: jsx-runtime subpath', doc.includes('react/jsx-runtime'))
  const im = buildImportMapScript(registry)
  ok('import map is valid JSON', (() => { try { JSON.parse(im.replace(/^<script type="importmap">/, '').replace(/<\/script>$/, '')); return true } catch { return false } })())
}

// 7. error card escapes html
{
  const card = errorCardHtml('Unexpected token <div> & friends', 'jsx')
  ok('error card escapes <', !card.includes('<div>') && card.includes('&lt;div&gt;'))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
