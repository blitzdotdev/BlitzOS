// Proof that the injected widget code (BRIDGE_SHIM + UI_KIT) is syntactically valid and defines the kit.
// Injected-string JS that fails to parse breaks EVERY widget silently, so this is the cheap guard.
// (Custom-element RENDERING is proven on the live :8799 preview once a widget uses the kit.)
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (n, c) => (c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)))

function scriptsIn(file) {
  const t = readFileSync(file, 'utf8')
  const out = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(t))) out.push(m[1])
  return out
}

console.log('# injected scripts parse (BRIDGE_SHIM + UI_KIT)')
for (const f of ['src/renderer/src/widget-bridge.ts', 'src/renderer/src/widget-ui-kit.ts']) {
  const ss = scriptsIn(f)
  ok(`${f} has injected script(s)`, ss.length >= 1)
  ss.forEach((s, i) => {
    let okk = true
    try {
      // eslint-disable-next-line no-new-func
      new Function(s) // parse-only; never executed (no DOM here)
    } catch (e) {
      okk = false
      console.log('    syntax error:', e.message)
    }
    ok(`${f} script#${i} parses`, okk)
  })
}

console.log('\n# the kit defines the component set + tokens + window.blitz.ui')
const kit = readFileSync('src/renderer/src/widget-ui-kit.ts', 'utf8')
for (const tag of ['blitz-titlebar', 'blitz-list', 'blitz-message', 'blitz-row', 'blitz-input', 'blitz-button']) {
  ok(`defines <${tag}>`, kit.includes(`customElements.define('${tag}'`))
}
ok('declares --blitz-accent token', kit.includes('--blitz-accent'))
ok('exposes window.blitz.ui (imperative helpers)', kit.includes('window.blitz.ui ='))
ok('UI_KIT is exported', kit.includes('export const UI_KIT'))

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
