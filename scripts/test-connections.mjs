// node scripts/test-connections.mjs
// Unit-tests the connection layer (connection-ops.mjs): the registry, the per-source tools.json store, the
// verb dispatch, effect/stale handling, capabilities, and per-connId widget scoping — all with a STUB adapter,
// so NO Chrome extension and NO BlitzComputerUse helper are needed. The real adapters are tested separately.

import { makeConnectionOps } from '../src/main/connection-ops.mjs'
import { makeWidgetToolHandlers } from '../src/main/widget-tools.mjs'
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
  const closed = []
  const updated = []
  const persistedSurfaces = [] // simulates surfaces that survived a restart (getSurfaces), for across-restart adoption
  const ops = makeConnectionOps({
    getWorkspacePath: () => ws,
    createSurface: (desc) => {
      const id = 'sfc_' + created.length
      created.push({ id, desc })
      return id
    },
    closeSurface: (id) => closed.push(id),
    updateSurface: (id, patch) => updated.push({ id, patch }),
    getSurfaces: () => persistedSurfaces
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

  // --- the widget bridge: a representation widget runs ITS OWN connection's saved tools (per-connId scoping)
  // exactly as verified live (a button -> window.blitz.tool('connection_call_tool')). The handler derives the
  // connId from the CALLING surface (ctx.surfaceId) and ignores any connection id the widget passes. ---
  const widgetHandlers = makeWidgetToolHandlers(ops)
  const fromWidget = await widgetHandlers.connection_call_tool({ name: 'unread' }, { surfaceId })
  ok('a widget button runs its own connection\'s saved tool', fromWidget && fromWidget.ok === true)
  // even if the widget tries to name ANOTHER connection, the call is scoped to the CALLING surface's connection
  const spoof = await widgetHandlers.connection_call_tool({ name: 'unread', connection: 'conn_some_other_connection' }, { surfaceId })
  ok('a widget cannot target another connection (the passed id is ignored, scoped to its own surface)', spoof && spoof.ok === true)
  let blocked = false
  try {
    await widgetHandlers.connection_call_tool({ name: 'unread' }, { surfaceId: 'sfc_not_a_connection' })
  } catch {
    blocked = true
  }
  ok('a widget not bound to a connection is rejected', blocked)

  // --- reconnecting the SAME source inherits its saved tools (keyed on sourceId) ---
  const { connId: conn2 } = ops.connectionBind({ type: 'tab', sourceId: 'mail.google.com', title: 'Gmail 2', adapter: stubAdapter() })
  ok('a second connection to the same source inherits the saved tools', ops.connectionListTools(conn2).tools.length === 1)

  // --- two LIVE connections to the same source (same site in two tabs): distinct connId+widget, shared tools.
  // verified live with two example.com Chrome tabs; locking the invariant here. ---
  const twA = ops.connectionBind({ type: 'tab', sourceId: 'twosite.example.com', adapter: stubAdapter() })
  const twB = ops.connectionBind({ type: 'tab', sourceId: 'twosite.example.com', adapter: stubAdapter() })
  ok('two live same-source connections are distinct (connId)', twA.connId !== twB.connId)
  ok('two live same-source connections have distinct widgets', twA.surfaceId !== twB.surfaceId && twA.surfaceId && twB.surfaceId)
  ok('both same-source connections are live (no incorrect dedup/adoption)', ops.connectionList().connections.filter((c) => c.sourceId === 'twosite.example.com' && c.status === 'live').length === 2)
  ops.connectionSaveTool(twA.connId, { name: 'shared_x', kind: 'read', code: 'return 1' })
  ok("the second live connection sees the first's saved tool (shared per-source)", ops.connectionListTools(twB.connId).tools.some((t) => t.name === 'shared_x'))

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
  const dropSurface = surfaceId
  const dropped = await ops.connectionDrop(connId)
  ok('drop ok', dropped.ok === true)
  ok('drop ran the adapter teardown', adapter.calls.some((c) => c.verb === 'drop'))
  ok('drop removed it from the registry', ops.connectionList().connections.every((c) => c.connId !== connId))
  ok('drop closed the representation widget (no orphan card)', closed.includes(dropSurface))
  ok('saved tools persist on disk after drop', existsSync(toolsFile))

  // --- a source vanishing (unbind) keeps the widget but repaints it to a disconnected state ---
  const va = stubAdapter()
  const vb = ops.connectionBind({ type: 'tab', sourceId: 'vanish.example.com', adapter: va })
  ops.connectionUnbind(vb.connId, { status: 'disconnected' })
  ok('unbind marks the connection disconnected', ops.connectionList().connections.some((c) => c.connId === vb.connId && c.status === 'disconnected'))
  ok('unbind repaints the widget to a disconnected state (kept, not closed)', updated.some((u) => u.id === vb.surfaceId && /disconnected/i.test(JSON.stringify(u.patch))) && !closed.includes(vb.surfaceId))

  // reconnecting a disconnected source ADOPTS its lingering widget — no orphan dead card, no duplicate connection
  const reAdapter = stubAdapter()
  const rebind = ops.connectionBind({ type: 'tab', sourceId: 'vanish.example.com', adapter: reAdapter })
  ok('reconnecting a disconnected source reuses its widget (adoption)', rebind.surfaceId === vb.surfaceId)
  ok('after adoption only ONE connection exists for the source', ops.connectionList().connections.filter((c) => c.sourceId === 'vanish.example.com').length === 1)
  ok('the adopted connection is live', ops.connectionList().connections.some((c) => c.connId === rebind.connId && c.status === 'live'))

  // the "Reconnect" affordance on a disconnected widget: connectionReconnectSource re-finds the source among
  // connectable tabs (via the tab link) and connects it. Wire a stub tab link with one matching tab.
  const reconnTabLink = {
    listTabs: async () => [{ tabId: 99, url: 'https://reconnect.example.com/x', title: 'R' }],
    connectTab: async (tabId) => ({ connId: 'conn_reconnected', surfaceId: 'sfc_re', tabId })
  }
  ops.setTabLink(reconnTabLink)
  const rr = await ops.connectionReconnectSource('reconnect.example.com', 'tab')
  ok('connectionReconnectSource finds + connects a matching open tab', rr && rr.connId === 'conn_reconnected')
  const rrMiss = await ops.connectionReconnectSource('notopen.example.com', 'tab')
  ok('connectionReconnectSource returns a navigable error when the source is not open', rrMiss && rrMiss.notFound === true)

  // the Reconnect BUTTON path: window.blitz.tool('connection_reconnect') → widget handler derives the source
  // from the CALLING (disconnected) surface's props and reconnects it. Exercise the exact handler the button runs.
  const reconnHandlers = makeWidgetToolHandlers({
    ...ops,
    getState: () => ({ surfaces: [{ id: 'sfc_dead', props: { connection: 'conn_old', connType: 'tab', connSource: 'reconnect.example.com' } }] })
  })
  const btn = await reconnHandlers.connection_reconnect({}, { surfaceId: 'sfc_dead' })
  ok('the Reconnect button reconnects the widget\'s own source', btn && btn.connId === 'conn_reconnected')
  let rejected2 = false
  try {
    await reconnHandlers.connection_reconnect({}, { surfaceId: 'sfc_not_a_connection' })
  } catch {
    rejected2 = true
  }
  ok('Reconnect on a non-connection surface is rejected', rejected2)

  // across-restart adoption: a persisted connection widget (in getSurfaces, NOT in the registry) is adopted on
  // reconnect — covers the case where the app restarted and the disconnected widget survived but the
  // connection didn't.
  persistedSurfaces.push({ id: 'sfc_persisted_restart', kind: 'srcdoc', title: 'restart.example.com', props: { connection: 'conn_pre_restart', connType: 'tab', connSource: 'restart.example.com' } })
  const afterRestart = ops.connectionBind({ type: 'tab', sourceId: 'restart.example.com', adapter: stubAdapter() })
  ok('reconnect after restart adopts the PERSISTED widget (no new surface)', afterRestart.surfaceId === 'sfc_persisted_restart')

  // --- on (re)hydrate, a persisted connection widget whose connection isn't live is repainted to disconnected ---
  const liveBind = ops.connectionBind({ type: 'tab', sourceId: 'rehydrate.example.com', adapter: stubAdapter() })
  const liveProps = { connection: liveBind.connId, connType: 'tab', connSource: 'rehydrate.example.com' }
  ok('rehydrate leaves a STILL-LIVE connection widget untouched', ops.rewriteHydratedSurface({ id: liveBind.surfaceId, props: liveProps, html: 'x' }) === null)
  const deadWidget = { id: 'sfc_persisted', title: 'mail.google.com', html: '<old/>', props: { connection: 'conn_gone_after_restart', connType: 'tab', connSource: 'mail.google.com' } }
  const rew = ops.rewriteHydratedSurface(deadWidget)
  ok('rehydrate repaints a DEAD connection widget to disconnected', rew && /disconnected/i.test(rew.html) && /mail\.google\.com/.test(rew.html))
  ok('rehydrate ignores a non-connection surface', ops.rewriteHydratedSurface({ id: 'note1', props: { text: 'hi' }, html: 'note' }) === null)

  rmSync(ws, { recursive: true, force: true })
  console.log('\n' + (fail ? '✗' : '✓') + ' connections: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
