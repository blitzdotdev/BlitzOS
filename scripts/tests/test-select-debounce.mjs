// Item 5a: `select` moments DEBOUNCE (a highlighting burst → one moment), while nav/idle stay immediate.
// perception-core is transport-agnostic + electron-free, so we drive it directly.
import assert from 'node:assert/strict'
import { ingestSignals, waitForEvents, latestSeq } from '../../src/main/perception-core.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0
async function t(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.message || e}`)
    process.exitCode = 1
  }
}

const sel = (text) => ({ type: 'select', text, t: Date.now() })

await t('a burst of 10 selects collapses to ONE moment (~debounce later), not 10', async () => {
  const before = latestSeq()
  const sid = 's-burst'
  for (let i = 0; i < 10; i++) {
    ingestSignals(sid, [sel(`phrase ${i}`)])
    await sleep(120) // faster than the 2.5s debounce → keeps resetting it
  }
  // nothing should have flushed yet (still within the debounce window)
  let ev = await waitForEvents(before, 0)
  assert.equal(ev.length, 0, `expected 0 moments mid-burst, got ${ev.length}`)
  // after the debounce settles, exactly ONE select moment carrying the merged highlights
  await sleep(2800)
  ev = await waitForEvents(before, 0)
  assert.equal(ev.length, 1, `expected 1 merged moment, got ${ev.length}`)
  assert.equal(ev[0].trigger, 'select')
  assert.ok(ev[0].signals.select >= 10, `merged moment should count all selects (got ${ev[0].signals.select})`)
})

await t('a nav flushes IMMEDIATELY and carries any pending selects (no firehose, no lost context)', async () => {
  const before = latestSeq()
  const sid = 's-nav'
  ingestSignals(sid, [sel('looking here')])
  ingestSignals(sid, [{ type: 'nav', url: 'https://example.com/next', t: Date.now() }])
  const ev = await waitForEvents(before, 0) // immediate — no wait
  assert.equal(ev.length, 1, `nav should flush at once, got ${ev.length}`)
  assert.equal(ev[0].trigger, 'nav')
  assert.ok(ev[0].signals.select >= 1, 'the nav moment carries the pending select')
})

await t('idle also flushes immediately', async () => {
  const before = latestSeq()
  const sid = 's-idle'
  ingestSignals(sid, [{ type: 'click', t: Date.now() }])
  ingestSignals(sid, [{ type: 'idle', idleMs: 6000, t: Date.now() }])
  const ev = await waitForEvents(before, 0)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].trigger, 'idle')
})

console.log(process.exitCode ? `\n${passed} passed, FAILURES above` : `\nall ${passed} passed`)
process.exit(process.exitCode || 0)
