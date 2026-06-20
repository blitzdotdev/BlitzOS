// Unit tests for the window-drop routing decision (src/main/browser-drop.mjs). Asserts the rule that a dropped
// browser resolves to a TAB or fails loudly — never a silent whole-window grab. Plain node; no electron/browser.
import assert from 'node:assert/strict'
import { isChromiumBrowser, decideDrop } from '../../src/main/browser-drop.mjs'

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

// ---- isChromiumBrowser ----
t('Chrome / Chromium / Brave / Arc / Edge bundleIds → browser', () => {
  for (const id of ['com.google.Chrome', 'org.chromium.Chromium', 'com.brave.Browser', 'company.thebrowser.Browser', 'com.microsoft.edgemac'])
    assert.equal(isChromiumBrowser(id, ''), true, id)
})

t('Safari is NOT a chromium browser (no extension link) → native window path', () => {
  assert.equal(isChromiumBrowser('com.apple.Safari', 'Safari'), false)
})

t('non-browser apps → not a browser', () => {
  for (const id of ['com.apple.finder', 'com.apple.Notes', 'com.tinyspeck.slackmacgap'])
    assert.equal(isChromiumBrowser(id, 'whatever'), false, id)
})

t('missing bundleId falls back to the app-name backstop', () => {
  assert.equal(isChromiumBrowser('', 'Google Chrome'), true)
  assert.equal(isChromiumBrowser(undefined, 'Brave Browser'), true)
  assert.equal(isChromiumBrowser('', 'Safari'), false) // backstop still excludes Safari
  assert.equal(isChromiumBrowser('', 'Finder'), false)
})

t('a real (non-empty) bundleId is trusted over the fuzzy name', () => {
  // an app literally named "Google Chrome Helper" but with its own bundleId must NOT be treated as the browser
  assert.equal(isChromiumBrowser('com.acme.app', 'Google Chrome'), false)
})

t('garbage / empty input → not a browser (no throw)', () => {
  assert.equal(isChromiumBrowser(undefined, undefined), false)
  assert.equal(isChromiumBrowser(null, null), false)
})

// ---- decideDrop ----
t('browser + resolved tab → connect the tab', () => {
  assert.equal(decideDrop({ isBrowser: true, tabId: 12345 }), 'tab')
})

t('browser + NO tab → error (never a whole-window grab)', () => {
  assert.equal(decideDrop({ isBrowser: true, tabId: null }), 'error')
})

t('non-browser → connect the native window', () => {
  assert.equal(decideDrop({ isBrowser: false, tabId: null }), 'window')
})

t('non-browser never becomes a tab even with a stray tabId', () => {
  assert.equal(decideDrop({ isBrowser: false, tabId: 999 }), 'window')
})

console.log(`\n${passed} passed`)
