// Item 2 (effect-verified syscalls) against real headless Chromium, via the SHARED control-core:
//  - 2A: a click resolves to the VISIBLE/hit-testable match, not the first DOM match; a selector that
//        matches only hidden/covered elements is a LOUD error (not a silent ok).
//  - 2B: type returns the field's actual value; click/key return a url/dom-change effect.
// Mirrors preview/test-server-browser.mjs (build the DOM with eval, drive via controlSession).
import { controlSession } from '../src/main/control-core.mjs'
import { startBrowserHost } from './browser-host.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const host = await startBrowserHost({ chromiumPath: process.env.CHROMIUM || process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
await host.createSurface('t', { url: 'about:blank', width: 1024, height: 768 })
await sleep(600)
const sess = host.session('t')
const set = (html) => controlSession(sess, { action: 'eval', expression: `document.body.innerHTML = ${JSON.stringify(html)}; 'ok'` })

// ---- 2A: a HIDDEN twin precedes the visible button in the DOM (the Gmail Send bug shape) ----
await set(
  `<button id="hidden" style="display:none" onclick="window.__hit='HIDDEN'">Send</button>
   <button id="real" onclick="window.__hit='REAL'">Send</button>`
)
await controlSession(sess, { action: 'eval', expression: "window.__hit=''" })
const r1 = await controlSession(sess, { action: 'click', selector: 'button' })
const hit1 = await controlSession(sess, { action: 'eval', expression: 'window.__hit' })
check('2A click skips the hidden first match and clicks the visible one', r1.ok && hit1.result === 'REAL', `got ${JSON.stringify(hit1.result)}`)

// ---- 2A: an overlay covers the target → not hit-testable → LOUD error, not a silent ok ----
await set(
  `<button id="under" onclick="window.__hit='UNDER'" style="position:fixed;left:40px;top:40px;width:120px;height:40px">Buy</button>
   <div style="position:fixed;left:0;top:0;width:400px;height:400px;background:rgba(0,0,0,.2)"></div>`
)
await controlSession(sess, { action: 'eval', expression: "window.__hit=''" })
const r2 = await controlSession(sess, { action: 'click', selector: '#under' })
const hit2 = await controlSession(sess, { action: 'eval', expression: 'window.__hit' })
check('2A covered element → ok:false loud error', r2.ok === false && /covered|hidden|clickable/i.test(r2.error || ''), JSON.stringify(r2))
check('2A covered element was NOT clicked', hit2.result === '', `got ${JSON.stringify(hit2.result)}`)

// ---- 2A: a selector matching nothing is still a clear "not found" ----
const r3 = await controlSession(sess, { action: 'click', selector: '#nope' })
check('2A missing selector → ok:false not found', r3.ok === false && /not found/i.test(r3.error || ''), JSON.stringify(r3))

// ---- 2B: type returns the field's ACTUAL value ----
await set(`<input id="q" />`)
const r4 = await controlSession(sess, { action: 'type', text: 'hello blitz', selector: '#q' })
check('2B type returns effect.value = what landed', r4.ok && r4.effect && r4.effect.value === 'hello blitz', JSON.stringify(r4.effect))

// ---- 2B: a click that changes the DOM reports domChanged ----
await set(`<button onclick="document.body.insertAdjacentHTML('beforeend','<p>more more more</p>')">Grow</button>`)
const r5 = await controlSession(sess, { action: 'click', selector: 'button' })
check('2B click reports an effect object', r5.ok && !!r5.effect, JSON.stringify(r5.effect))
check('2B click effect.domChanged true when the DOM grew', r5.effect && r5.effect.domChanged === true, JSON.stringify(r5.effect))

await host.closeSurface('t')
console.log(failed ? `\n${passed} passed, ${failed} FAILED` : `\nall ${passed} passed`)
process.exit(failed ? 1 : 0)
