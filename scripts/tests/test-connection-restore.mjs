// Unit test for connectionRestoreAll (boot / link-reconnect auto-restore) in connection-ops.mjs. Simulates a
// post-restart state: persisted connection widgets (getSurfaces) with NO live registry entries, then asserts each
// is re-bound to its still-open tab/window — preserving the owning agent, deduped, skipping already-live ones, and
// leaving a gone source disconnected. Stub links; no Chrome extension / helper needed.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeConnectionOps } from '../../src/main/connection-ops.mjs'

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

async function main() {
  const ws = mkdtempSync(join(tmpdir(), 'blitz-restore-'))
  // persisted surfaces that "survived a restart": connection widgets with props but no live registry entry.
  const surfaces = [
    { id: 'sfc_gmail', props: { connection: 'old_a', connType: 'tab', connSource: 'mail.google.com', connAgent: '17' } },
    { id: 'sfc_cal', props: { connection: 'old_b', connType: 'tab', connSource: 'calendar.google.com', connAgent: '' } },
    { id: 'sfc_dup', props: { connection: 'old_c', connType: 'tab', connSource: 'mail.google.com', connAgent: '17' } }, // same source as gmail → deduped
    { id: 'sfc_gone', props: { connection: 'old_d', connType: 'tab', connSource: 'no-longer-open.com', connAgent: '0' } }, // tab not open → stays dead
    { id: 'sfc_win', props: { connection: 'old_e', connType: 'window', connSource: 'com.apple.Notes', connAgent: '3' } },
    { id: 'sfc_plain', props: {} } // a normal (non-connection) surface → ignored
  ]
  let newSfc = 0
  const ops = makeConnectionOps({
    getWorkspacePath: () => ws,
    createSurface: () => 'sfc_new_' + ++newSfc,
    closeSurface: (id) => {
      // faithful: closing a surface removes it from the store, so getSurfaces no longer returns it (mirrors Electron)
      const i = surfaces.findIndex((s) => s.id === id)
      if (i >= 0) surfaces.splice(i, 1)
    },
    updateSurface: () => {},
    getSurfaces: () => surfaces
  })

  // mock tab link: listTabs reports the currently-open tabs; connectTab records the call AND binds (so it goes live).
  const openTabs = [
    { tabId: 111, url: 'https://mail.google.com/mail/u/0', title: 'Gmail' },
    { tabId: 222, url: 'https://calendar.google.com/calendar', title: 'Calendar' }
  ]
  const tabConnectCalls = []
  ops.setChromeAsLink({
    listTabs: async () => openTabs,
    connectTab: async (tabId, opts) => {
      tabConnectCalls.push({ tabId, opts })
      const tab = openTabs.find((x) => x.tabId === tabId)
      const host = new URL(tab.url).host
      const b = ops.connectionBind({ type: 'tab', sourceId: host, title: tab.title, adapter: { call: async () => ({}), drop: () => {} }, ref: tabId, agentId: opts && opts.agentId })
      return { connId: b.connId, surfaceId: b.surfaceId, sourceId: host }
    }
  })
  // mock window link
  const winConnectCalls = []
  ops.setWindowLink({
    listWindows: async () => ({ windows: [{ windowId: 9, bundleId: 'com.apple.Notes', app: 'Notes' }] }),
    connectWindow: async (windowId, opts) => {
      winConnectCalls.push({ windowId, opts })
      const b = ops.connectionBind({ type: 'window', sourceId: 'com.apple.Notes', title: 'Notes', adapter: { call: async () => ({}), drop: () => {} }, ref: windowId, agentId: opts && opts.agentId })
      return { connId: b.connId, surfaceId: b.surfaceId, sourceId: 'com.apple.Notes' }
    }
  })

  const res = await ops.connectionRestoreAll()

  t('restored the open tabs + window, deduped same-source, skipped the gone one', () => {
    // targets: mail.google.com, calendar.google.com, no-longer-open.com, com.apple.Notes (dup mail collapsed) = 4 total
    assert.equal(res.total, 4)
    assert.equal(res.restored, 3) // gmail + calendar + notes; the gone tab is not restored
  })
  t('Gmail reconnected to the still-open tab (111), once (deduped)', () => {
    const gmail = tabConnectCalls.filter((c) => c.tabId === 111)
    assert.equal(gmail.length, 1)
  })
  t('owning agent is preserved through the restore (Gmail → agent 17)', () => {
    const gmail = tabConnectCalls.find((c) => c.tabId === 111)
    assert.equal(gmail.opts.agentId, '17')
  })
  t('window connection reconnected, preserving its agent (3)', () => {
    assert.equal(winConnectCalls.length, 1)
    assert.equal(winConnectCalls[0].windowId, 9)
    assert.equal(winConnectCalls[0].opts.agentId, '3')
  })
  t('the now-live connections show in the registry', () => {
    const live = ops.connectionList().connections
    const sources = live.map((c) => c.sourceId).sort()
    assert.deepEqual(sources, ['calendar.google.com', 'com.apple.Notes', 'mail.google.com'])
  })

  // second run = idempotent: everything is live now (skipped by surfaceId), so nothing reconnects again
  const before = tabConnectCalls.length + winConnectCalls.length
  const res2 = await ops.connectionRestoreAll()
  t('second restore is a no-op (already live → skipped)', () => {
    assert.equal(tabConnectCalls.length + winConnectCalls.length, before)
    assert.equal(res2.restored, 0)
  })

  rmSync(ws, { recursive: true, force: true })
  console.log(`\n${passed} passed`)
}

main()
