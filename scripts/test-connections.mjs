// node scripts/test-connections.mjs
// Unit-tests the connection layer (connection-ops.mjs): the registry, the per-source tools.json store, the
// verb dispatch, effect/stale handling, capabilities, and per-connId widget scoping — all with a STUB adapter,
// so NO Chrome extension and NO BlitzComputerUse helper are needed. The real adapters are tested separately.

import { makeConnectionOps } from '../src/main/connection-ops.mjs'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function ok(name, cond) {
  if (cond) {
    pass++
    console.log('  ✓ ' + name)
  } else {
    fail++
    console.error('  ✗ ' + name)
  }
}

// a stub adapter records the verbs it was asked to run + returns canned results
function stubAdapter(canned = {}) {
  const calls = []
  return {
    calls,
    call: async (verb, args) => {
      calls.push({ verb, args })
      return verb in canned ? canned[verb] : { result: verb + '-ok' }
    },
    drop: async () => {
      calls.push({ verb: 'drop' })
    }
  }
}

async function main() {
  const ws = mkdtempSync(join(tmpdir(), 'blitz-conn-'))
  const created = []
  const ops = makeConnectionOps({
    getWorkspacePath: () => ws,
    createSurface: (desc) => {
      const id = 'sfc_' + created.length
      created.push({ id, desc })
      return id
    }
  })

  // --- empty registry ---
  ok('connection_list starts empty', ops.connectionList().connections.length === 0)

  // --- bind a TAB connection: auto-creates + binds the representation widget ---
  const adapter = stubAdapter({ read: { result: '<dom>' }, act: { effect: { clicked: true } }, run_js: { result: 42 } })
  const { connId, surfaceId } = ops.connectionBind({ type: 'tab', sourceId: 'mail.google.com', title: 'Gmail', adapter })
  ok('bind returns a connId', typeof connId === 'string' && connId.startsWith('conn_'))
  ok('bind auto-created a srcdoc representation widget', !!surfaceId && created.length === 1 && created[0].desc.kind === 'srcdoc')
  ok('widget descriptor carries its connId in props', created[0].desc.props && created[0].desc.props.connection === connId)

  const list = ops.connectionList().connections
  ok('list shows the connection live', list.length === 1 && list[0].sourceId === 'mail.google.com' && list[0].status === 'live')
  ok('tab advertises run_js capability', list[0].capabilities.run_js === true)

  // --- read / act / run_js dispatch through the adapter ---
  ok('read dispatches + returns result', (await ops.connectionRead(connId, { selector: 'body' })).result === '<dom>')
  const acted = await ops.connectionAct(connId, { action: 'click', selector: 'a' })
  ok('act returns the observed effect', acted.ok === true && JSON.stringify(acted.effect) === JSON.stringify({ clicked: true }))
  ok('run_js dispatches + returns result', (await ops.connectionRunJs(connId, { code: 'return 42' })).result === 42)

  // --- read cap: a huge result is truncated, never dumped whole ---
  const big = stubAdapter({ read: { result: 'x'.repeat(20000) } })
  const { connId: bigConn } = ops.connectionBind({ type: 'tab', sourceId: 'big.example.com', adapter: big })
  const bigRead = await ops.connectionRead(bigConn, {})
  ok('read is capped (never dumps a whole tree)', bigRead.result && bigRead.result.truncated === true && bigRead.result.bytes === 20000)

  // --- save a tool -> writes tools.json under the workspace, keyed on sourceId ---
  const saved = ops.connectionSaveTool(connId, { name: 'unread', description: 'unread count', kind: 'read', code: "return document.querySelectorAll('tr.zE').length" })
  ok('save_tool succeeds', saved.ok === true && saved.count === 1)
  const toolsFile = join(ws, '.blitzos', 'connections', 'mail.google.com', 'tools.json')
  ok('tools.json written at .blitzos/connections/<sourceId>/', existsSync(toolsFile))
  ok('tools.json holds the saved tool', JSON.parse(readFileSync(toolsFile, 'utf8'))[0].name === 'unread')
  ok('list_tools reflects it', ops.connectionListTools(connId).tools.length === 1)

  // --- call_tool: a tab tool runs via run_js (the saved code), kind read returns its value ---
  const called = await ops.connectionCallTool(connId, 'unread', {})
  ok('call_tool ran the saved code via run_js', adapter.calls.some((c) => c.verb === 'run_js' && c.args.code.includes('querySelectorAll')))
  ok('call_tool ok for a read tool', called.ok === true)

  // --- description ---
  ok('describe writes + list shows it', ops.connectionSetDescription(connId, 'the user inbox').ok === true && ops.connectionListTools(connId).description === 'the user inbox')

  // --- per-connId widget scoping ---
  ok('connectionForSurface resolves the bound widget -> connId', ops.connectionForSurface(surfaceId) === connId)
  ok('connectionForSurface rejects an unknown surface', ops.connectionForSurface('sfc_does_not_exist') === null)

  // --- reconnecting the SAME source inherits its saved tools (keyed on sourceId) ---
  const { connId: conn2 } = ops.connectionBind({ type: 'tab', sourceId: 'mail.google.com', title: 'Gmail 2', adapter: stubAdapter() })
  ok('a second connection to the same source inherits the saved tools', ops.connectionListTools(conn2).tools.length === 1)

  // --- capability gate: a WINDOW has no run_js ---
  const win = stubAdapter({ act: { effect: null } })
  const { connId: winConn } = ops.connectionBind({ type: 'window', sourceId: 'com.tinyspeck.slackmacgap', title: 'Slack', adapter: win })
  const rj = await ops.connectionRunJs(winConn, { code: '1' })
  ok('run_js on a window -> capability_unavailable (soft, not an error)', rj.error === 'capability_unavailable')

  // --- stale detection: an ACT tool that produces no effect is flagged stale (not silently "ok") ---
  ops.connectionSaveTool(winConn, { name: 'send', kind: 'act', steps: [{ find: "AXButton 'Send'", action: 'AXPress' }] })
  const staleCall = await ops.connectionCallTool(winConn, 'send', {})
  ok('an act tool with no effect is flagged stale -> re-derive', staleCall.ok === false && staleCall.stale === true)

  // --- a saved tool that does not exist is a clear error ---
  ok('call_tool on a missing tool errors', (await ops.connectionCallTool(connId, 'nope', {})).error)

  // --- an op on a missing connection is a clear error ---
  ok('read on a missing connection errors', (await ops.connectionRead('conn_nope', {})).error)

  // --- closing the representation widget drops the connection (no orphaned adapter) ---
  const orphanAdapter = stubAdapter()
  const ob = ops.connectionBind({ type: 'tab', sourceId: 'orphan.example.com', adapter: orphanAdapter })
  ok('a fresh connection is registered', ops.connectionList().connections.some((c) => c.connId === ob.connId))
  await ops.handleSurfaceClosed(ob.surfaceId)
  ok('closing its widget surface drops the connection', !ops.connectionList().connections.some((c) => c.connId === ob.connId))
  ok('closing the widget ran the adapter teardown', orphanAdapter.calls.some((c) => c.verb === 'drop'))
  ok('handleSurfaceClosed on a non-connection surface is a no-op', (await ops.handleSurfaceClosed('sfc_not_a_connection')) === undefined)

  // --- drop tears down + removes from registry; the widget + saved tools persist on disk ---
  const dropped = await ops.connectionDrop(connId)
  ok('drop ok', dropped.ok === true)
  ok('drop ran the adapter teardown', adapter.calls.some((c) => c.verb === 'drop'))
  ok('drop removed it from the registry', ops.connectionList().connections.every((c) => c.connId !== connId))
  ok('saved tools persist on disk after drop', existsSync(toolsFile))

  rmSync(ws, { recursive: true, force: true })
  console.log('\n' + (fail ? '✗' : '✓') + ' connections: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
