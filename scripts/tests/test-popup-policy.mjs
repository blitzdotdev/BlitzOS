// Unit tests for the content-agnostic popup classifier (popup-policy.mjs) — the de-hostnamed core of
// item 3. Asserts every branch by web-platform signal, NOT by site. Plain node; no electron/browser.
import assert from 'node:assert/strict'
import { classifyPopup, parseFeatures } from '../../src/main/popup-policy.mjs'

let passed = 0
function t(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.message || e}`)
    process.exitCode = 1
  }
}

t('parseFeatures lowercases keys + trims', () => {
  assert.deepEqual(parseFeatures(' Width=500, Height=600 ,popup=1'), { width: '500', height: '600', popup: '1' })
})

t('about:blank → hidden utility child (gapi RPC pattern)', () => {
  assert.equal(classifyPopup({ url: 'about:blank' }).kind, 'hidden')
})

t('sized window.open → a real visible window (generalizes OAuth, no hostname)', () => {
  const p = classifyPopup({ url: 'https://login.microsoftonline.com/authorize', features: 'width=500,height=600' })
  assert.equal(p.kind, 'window')
  assert.equal(p.width, 500)
  assert.equal(p.height, 600)
})

t('the SAME rule fires for any provider — google, github, anything', () => {
  for (const u of ['https://accounts.google.com/o/oauth2/auth', 'https://github.com/login/oauth/authorize', 'https://example.com/pay']) {
    assert.equal(classifyPopup({ url: u, features: 'width=480,height=640' }).kind, 'window', u)
  }
})

t('absurd feature sizes are clamped (no 30000px window)', () => {
  const p = classifyPopup({ url: 'https://x.com', features: 'width=99999,height=5' })
  assert.equal(p.width, 1400)
  assert.equal(p.height, 160)
})

t('a link click (foreground-tab, no features) → a new surface', () => {
  assert.equal(classifyPopup({ url: 'https://news.ycombinator.com', disposition: 'foreground-tab' }).kind, 'surface')
  assert.equal(classifyPopup({ url: 'https://news.ycombinator.com', disposition: 'background-tab' }).kind, 'surface')
})

t('a scripted popup to a URL, no size + no gesture (helper frame / popunder) → deny', () => {
  // the Gmail contact-hovercard shape: window.open to a widget URL, no size, disposition new-window/other
  assert.equal(classifyPopup({ url: 'https://contacts.google.com/widget/hovercard', disposition: 'new-window' }).kind, 'deny')
  assert.equal(classifyPopup({ url: 'https://ads.example.com/popunder', disposition: 'other' }).kind, 'deny')
})

t('non-http schemes never become windows', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,<h1>x', 'file:///etc/passwd', 'tel:+1']) {
    assert.equal(classifyPopup({ url: u, features: 'width=500,height=500' }).kind, 'deny', u)
  }
})

console.log(process.exitCode ? `\n${passed} passed, FAILURES above` : `\nall ${passed} passed`)
