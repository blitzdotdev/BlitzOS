// node scripts/test-connection-tablink.mjs
// END-TO-END integration test of the TAB adapter's main side, with NO Chrome: it drives the REAL modules
// (connection-tab-link.mjs WS server + connection-ops.mjs + the os-tools.mjs handlers + the perception wake)
// against a SIMULATED extension — a `ws` client that speaks exactly the protocol extension/sw.js speaks
// (hello / cmd→reply / events). Proves: Origin auth, the connect entry tool, the read/act/run_js round-trip
// over the socket, and the source-change → connection moment wake.

import { makeConnectionOps } from '../src/main/connection-ops.mjs'
import { makeTabLink, CONNECTOR_EXTENSION_ID } from '../src/main/connection-tab-link.mjs'
import { makeOsTools } from '../src/main/os-tools.mjs'
import { setMomentTap } from '../src/main/perception-core.mjs'
import { WebSocket } from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (name, cond) => (cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.error('  ✗ ' + name)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A stand-in for extension/sw.js: connects with the real Origin, sends hello, answers cmds like sw.js does.
function fakeExtension(port, { origin = `chrome-extension://${CONNECTOR_EXTENSION_ID}`, tabs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/blitz-connector`, { headers: { origin } })
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', extension: CONNECTOR_EXTENSION_ID, tabs }))
      resolve(ws)
    })
    ws.on('error', (e) => reject(e))
    ws.on('unexpected-response', () => reject(new Error('handshake rejected')))
    ws.on('message', (data) => {
      let m
      try {
        m = JSON.parse(String(data))
      } catch {
        return
      }
      if (m.type === 'pong' || m.cmd == null || m.id == null) return
      const reply = (payload) => ws.send(JSON.stringify({ type: 'reply', id: m.id, ...payload }))
      if (m.cmd === 'listTabs') return reply({ result: tabs })
      if (m.cmd === 'read') return reply({ result: { url: 'https://example.com/', title: 'Example Domain', text: 'This domain is for use in illustrative examples.' } })
      if (m.cmd === 'run_js') return reply({ result: { result: 42 } })
      if (m.cmd === 'act') return reply({ result: { clicked: (m.args && m.args.selector) || true, url: 'https://example.com/' } })
      return reply({ error: 'unknown cmd ' + m.cmd })
    })
  })
}

async function main() {
  const wsDir = mkdtempSync(join(tmpdir(), 'blitz-tablink-'))
  const created = []
  const ops = makeConnectionOps({
    getWorkspacePath: () => wsDir,
    createSurface: (d) => {
      const id = 'sfc_' + created.length
      created.push(d)
      return id
    }
  })
  const link = makeTabLink({ connectionOps: ops })
  ops.setTabLink(link)

  const started = await link.start()
  ok('tab link WS server started', started.ok === true && typeof started.port === 'number')
  const port = started.port

  // --- Origin auth: a wrong-origin client is rejected by verifyClient ---
  let rejected = false
  try {
    await fakeExtension(port, { origin: 'chrome-extension://evilevilevilevilevilevilevileeee' })
  } catch {
    rejected = true
  }
  ok('wrong-Origin client is rejected', rejected)

  // --- the real extension connects ---
  const ext = await fakeExtension(port, { tabs: [{ tabId: 7, title: 'Example', url: 'https://example.com/' }] })
  await sleep(120) // let `hello` land so the link caches the tab list

  // drive the REAL os-tools handlers (transport: 'relay', the untrusted path the agent uses)
  const tools = makeOsTools(ops)
  const tool = (p) => tools.find((t) => t.path === p)
  const call = async (p, body) => tool(p).handler({ body: JSON.stringify(body || {}), transport: 'relay' })

  const lt = await call('/connection_list_tabs', {})
  ok('connection_list_tabs returns the extension tab (browser:chrome)', Array.isArray(lt.tabs) && lt.tabs.some((t) => t.tabId === 7 && t.browser === 'chrome'))

  const ct = await call('/connection_connect_tab', { tabId: 7 })
  ok('connection_connect_tab returns connId + surfaceId', !!ct.connId && !!ct.surfaceId)
  ok('connect auto-created a srcdoc representation widget', created.length === 1 && created[0].kind === 'srcdoc' && created[0].props.connection === ct.connId)
  const connId = ct.connId

  const rd = await call('/connection_read', { connection: connId, selector: 'body' })
  ok('connection_read round-trips the page DOM over the socket', rd.result && /illustrative examples/.test(rd.result.text))

  const rj = await call('/connection_run_js', { connection: connId, code: 'return 6*7' })
  ok('connection_run_js round-trips the result', rj.result === 42)

  const ac = await call('/connection_act', { connection: connId, action: 'click', selector: 'a' })
  ok('connection_act returns an effect-verified result', ac.ok === true && !!ac.effect)

  // --- save + call a per-source tool (writes tools.json, runs via run_js) ---
  await call('/connection_save_tool', { connection: connId, name: 'answer', kind: 'read', code: 'return 42' })
  const cc = await call('/connection_call_tool', { connection: connId, name: 'answer' })
  ok('saved tool runs through the adapter', cc.ok === true)

  // --- source-change → an immediate connection wake moment ---
  const moments = []
  setMomentTap((m) => {
    if (m && m.trigger === 'connection') moments.push(m)
  })
  ext.send(JSON.stringify({ type: 'event', kind: 'urlChanged', tabId: 7, url: 'https://example.com/page2' }))
  await sleep(180)
  ok('urlChanged emits a connection wake moment for this connId', moments.some((m) => m.connection && m.connection.connId === connId))

  const cl = await call('/connection_list', {})
  ok('connection_list shows the connection live with its saved tool', cl.connections.some((c) => c.connId === connId && c.status === 'live' && c.savedTools.some((t) => t.name === 'answer')))

  // --- tab closed → the connection goes disconnected ---
  ext.send(JSON.stringify({ type: 'event', kind: 'tabClosed', tabId: 7 }))
  await sleep(120)
  const cl2 = await call('/connection_list', {})
  ok('tabClosed marks the connection disconnected', cl2.connections.some((c) => c.connId === connId && c.status === 'disconnected'))

  link.stop()
  ext.close()
  rmSync(wsDir, { recursive: true, force: true })
  console.log('\n' + (fail ? '✗' : '✓') + ' tab link e2e: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
