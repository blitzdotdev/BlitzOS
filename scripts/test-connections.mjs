// node scripts/test-connections.mjs
// Unit-tests the connection layer (connection-ops.mjs): the registry, the per-source tools.json store, the
// verb dispatch, effect/stale handling, capabilities, and per-connId widget scoping — all with a STUB adapter,
// so NO Chrome extension and NO BlitzComputerUse helper are needed. The real adapters are tested separately.

import { makeConnectionOps } from '../src/main/connection-ops.mjs'
import { makeWidgetToolHandlers } from '../src/main/widget-tools.mjs'
import { _seedCache as seedDetect, clearDetectCache } from '../src/main/mcp-detect.mjs'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
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
  ok('a capped STRING read returns a clean text prefix (not a head blob)', bigRead.result && typeof bigRead.result.text === 'string' && bigRead.result.head === undefined)

  // a too-big STRUCTURED read ({url,title,text}) truncates the text field IN PLACE, keeping clean structure
  const structAdapter = stubAdapter({ read: { result: { url: 'https://big.example.com/', title: 'Big', text: 'y'.repeat(20000) } } })
  const { connId: structConn } = ops.connectionBind({ type: 'tab', sourceId: 'struct.example.com', adapter: structAdapter })
  const structRead = await ops.connectionRead(structConn, {})
  ok('a capped structured read keeps url/title intact', structRead.result && structRead.result.url === 'https://big.example.com/' && structRead.result.title === 'Big' && structRead.result.truncated === true)
  ok('a capped structured read truncates the text field (not a JSON blob)', structRead.result && typeof structRead.result.text === 'string' && structRead.result.text.length < 20000 && structRead.result.preview === undefined)

  // a too-big DEEP object (no text field — e.g. an AX/DOM tree) returns a LABELED preview, never a `head`
  const treeAdapter = stubAdapter({ read: { result: { root: { children: Array.from({ length: 2000 }, (_, i) => ({ role: 'AXButton', i })) } } } })
  const { connId: treeConn } = ops.connectionBind({ type: 'window', sourceId: 'tree.app', adapter: treeAdapter, capabilities: { act: true } })
  const treeRead = await ops.connectionRead(treeConn, {})
  ok('a capped deep tree returns a labeled preview (not head)', treeRead.result && treeRead.result.truncated === true && typeof treeRead.result.preview === 'string' && treeRead.result.head === undefined)

  // H3: a structured read whose NON-text field is itself over the cap must STILL be capped (not pass through)
  const fatAdapter = stubAdapter({ read: { result: { url: 'https://x/' + 'u'.repeat(20000), text: 'short' } } })
  const { connId: fatConn } = ops.connectionBind({ type: 'tab', sourceId: 'fat.example.com', adapter: fatAdapter })
  const fatRead = await ops.connectionRead(fatConn, { max: 2000 })
  ok('a read with a huge NON-text field is still capped (no pass-through)', fatRead.result && fatRead.result.truncated === true && JSON.stringify(fatRead.result).length <= 2600)

  // H2: a malicious/degenerate sourceId can NEVER produce a path-traversal dir, and distinct sources never collide
  ops.connectionSaveTool(ops.connectionBind({ type: 'tab', sourceId: '..', adapter: stubAdapter() }).connId, { name: 't', kind: 'read', code: '1' })
  ok("a '..' sourceId does NOT escape the connections dir", !existsSync(join(ws, '.blitzos', 'tools.json')) && existsSync(join(ws, '.blitzos', 'connections')))
  const cA = ops.connectionBind({ type: 'tab', sourceId: 'a/b', adapter: stubAdapter() }).connId
  const cB = ops.connectionBind({ type: 'tab', sourceId: 'a_b', adapter: stubAdapter() }).connId
  ops.connectionSaveTool(cA, { name: 'fromA', kind: 'read', code: '1' })
  ok("distinct sources 'a/b' and 'a_b' do NOT collide onto one tools.json", !ops.connectionListTools(cB).tools.some((t) => t.name === 'fromA'))

  // --- save a tool -> writes tools.json under the workspace, keyed on sourceId ---
  const saved = ops.connectionSaveTool(connId, { name: 'unread', description: 'unread count', kind: 'read', code: "return document.querySelectorAll('tr.zE').length" })
  ok('save_tool succeeds', saved.ok === true && saved.count === 1)
  // the dir is a hash-suffixed safe name (no traversal / no collisions), so locate it dynamically
  const connRoot = join(ws, '.blitzos', 'connections')
  const findToolsFile = () => {
    for (const d of existsSync(connRoot) ? readdirSync(connRoot) : []) {
      const f = join(connRoot, d, 'tools.json')
      if (existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).some((t) => t.name === 'unread')) return f
    }
    return null
  }
  const toolsFile = findToolsFile()
  ok('tools.json written under .blitzos/connections/<safeSourceId>/', !!toolsFile)
  ok('tools.json holds the saved tool', toolsFile && JSON.parse(readFileSync(toolsFile, 'utf8'))[0].name === 'unread')
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

  // --- cross-origin nav re-keys the connection's sourceId (same connId+widget; per-source tools follow) ---
  const navAdapter = stubAdapter()
  const navConn = ops.connectionBind({ type: 'tab', sourceId: 'mail.google.com', title: 'Gmail', adapter: navAdapter })
  ops.connectionSaveTool(navConn.connId, { name: 'gmail_only', kind: 'read', code: 'return 1' })
  const rk = ops.connectionRekey(navConn.connId, 'accounts.google.com')
  ok('rekey reports the change', rk && rk.changed === true && rk.from === 'mail.google.com' && rk.to === 'accounts.google.com')
  ok('connection_list shows the NEW sourceId after cross-origin nav', ops.connectionList().connections.some((c) => c.connId === navConn.connId && c.sourceId === 'accounts.google.com'))
  ok("the connection no longer sees the old source's tools (re-keyed tools.json)", !ops.connectionListTools(navConn.connId).tools.some((t) => t.name === 'gmail_only'))
  ok('same connId + widget survive the re-key', ops.connectionList().connections.some((c) => c.connId === navConn.connId && c.surfaceId === navConn.surfaceId))
  ok('re-key to the SAME host is a no-op', ops.connectionRekey(navConn.connId, 'accounts.google.com').changed === false)
  // navigating BACK re-keys back and the original tools reappear
  ops.connectionRekey(navConn.connId, 'mail.google.com')
  ok("navigating back restores the original source's tools", ops.connectionListTools(navConn.connId).tools.some((t) => t.name === 'gmail_only'))

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
  ops.setChromeAsLink(reconnTabLink)
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

  // --- per-chat ownership + transfer-on-reattach (the dropbox "disappears, works on another chat" fix) ---
  // A source is owned by the chat that attached it; connectionList(forAgent) scopes to that owner. Re-attaching an
  // already-live source from a different chat must TRANSFER ownership (connectionSetOwner, called by the dedup path
  // in the tab/safari/window links) so it lists under the chat now attaching it instead of vanishing.
  const ownBind = ops.connectionBind({ type: 'tab', sourceId: 'owned.example.com', adapter: stubAdapter(), agentId: 'A' })
  ok('a connection is scoped to its owner chat', ops.connectionList('A').connections.some((c) => c.connId === ownBind.connId))
  ok('another chat does NOT see it', !ops.connectionList('B').connections.some((c) => c.connId === ownBind.connId))
  const moved = ops.connectionSetOwner(ownBind.connId, 'B')
  ok('connectionSetOwner transfers ownership', moved.ok === true && moved.changed === true)
  ok('after transfer the NEW chat sees it', ops.connectionList('B').connections.some((c) => c.connId === ownBind.connId))
  ok('after transfer the OLD chat no longer sees it', !ops.connectionList('A').connections.some((c) => c.connId === ownBind.connId))
  ok('re-setting the same owner is a no-op', ops.connectionSetOwner(ownBind.connId, 'B').changed === false)
  ok('connectionSetOwner on an unknown connId errors', !!ops.connectionSetOwner('conn_nope', 'B').error)
  ok('an unscoped list (undefined) still sees every owner', ops.connectionList().connections.some((c) => c.connId === ownBind.connId))

  // ---------- the first-party TOOL REGISTRY (connection_registry_search / _get / _add) ----------
  // a fake registry server via an injected fetchImpl — proves search(meta)/get(full)/add(into tools.json) without HTTP.
  const REG = {
    'docs.google.com': [
      { name: 'read_text', description: 'doc text', kind: 'read', code: "return document.body.innerText", sourceId: 'docs.google.com', version: '1', contentHash: 'sha256:abc' }
    ]
  }
  const mkRes = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj })
  const fakeFetch = async (url) => {
    const u = new URL(url)
    const sid = u.searchParams.get('sourceId')
    if (u.pathname === '/v1/tools') return mkRes(200, { sourceId: sid, entries: (REG[sid] || []).map(({ code, steps, ...m }) => m) })
    if (u.pathname === '/v1/tool') {
      const e = (REG[sid] || []).find((t) => t.name === u.searchParams.get('name'))
      return e ? mkRes(200, { entry: e }) : mkRes(404, { error: 'not found' })
    }
    return mkRes(404, { error: 'not found' })
  }
  const regWs = mkdtempSync(join(tmpdir(), 'blitz-reg-'))
  const rops = makeConnectionOps({ getWorkspacePath: () => regWs, createSurface: () => 'rs', registryUrl: 'http://reg.test', fetchImpl: fakeFetch })
  const rconn = rops.connectionBind({ type: 'tab', sourceId: 'docs.google.com', title: 'Doc', adapter: stubAdapter() }).connId

  // bind warms registryCache (fire-and-forget) so connection_list SURFACES available registry tools — the fix
  // for the registry being invisible-until-queried (agents re-deriving because they never saw vetted tools).
  await new Promise((r) => setTimeout(r, 60))
  const briefing = rops.connectionList().connections.find((c) => c.connId === rconn)
  ok('connection_list briefing SURFACES registryTools for the source', Array.isArray(briefing.registryTools) && briefing.registryTools.some((t) => t.name === 'read_text'))
  ok('surfaced registryTools are metadata only (no code)', briefing.registryTools.every((t) => t.code === undefined))

  // the CONNECT RESULT itself must carry the briefing — the agent's connect→act flow can skip connection_list
  rops.setChromeAsLink({ listTabs: async () => [{ tabId: 9, url: 'https://docs.google.com/x', title: 'D' }], connectTab: async (id) => { const b = rops.connectionBind({ type: 'tab', sourceId: 'docs.google.com', title: 'D', adapter: stubAdapter(), ref: id }); return { connId: b.connId, surfaceId: b.surfaceId, sourceId: 'docs.google.com' } } })
  const cres = await rops.connectionConnectTab(9, {})
  ok('connect_tab RESULT carries registryTools (unmissable briefing)', Array.isArray(cres.registryTools) && cres.registryTools.some((t) => t.name === 'read_text'))
  ok('connect_tab RESULT carries savedTools', Array.isArray(cres.savedTools))

  const search = await rops.connectionRegistrySearch({ connection: rconn })
  ok('registry_search returns entries for the connection sourceId', search.sourceId === 'docs.google.com' && search.entries.length === 1 && search.entries[0].name === 'read_text')
  ok('registry_search returns METADATA ONLY (no code)', search.entries[0].code === undefined)
  const sById = await rops.connectionRegistrySearch({ sourceId: 'docs.google.com', query: 'text' })
  ok('registry_search works by sourceId + query', sById.entries.length === 1)
  ok('registry_search for an unknown source is empty (not an error)', (await rops.connectionRegistrySearch({ sourceId: 'nope.com' })).entries.length === 0)

  const full = await rops.connectionRegistryGet({ sourceId: 'docs.google.com', name: 'read_text' })
  ok('registry_get returns the full entry incl. code', full.entry && full.entry.code === 'return document.body.innerText')
  ok('registry_get for a missing tool errors', !!(await rops.connectionRegistryGet({ sourceId: 'docs.google.com', name: 'nope' })).error)

  const added = await rops.connectionRegistryAdd({ connection: rconn, name: 'read_text' })
  ok('registry_add installs the tool into tools.json', added.ok === true && added.name === 'read_text')
  const listed = rops.connectionListTools(rconn).tools
  ok('the added tool now shows in connection_list_tools', listed.some((t) => t.name === 'read_text'))
  ok('the added tool is stamped source:registry + contentHash', listed.find((t) => t.name === 'read_text')?.source === 'registry' && !!listed.find((t) => t.name === 'read_text')?.contentHash)
  ok('the added tool is runnable via connection_call_tool', (await rops.connectionCallTool(rconn, 'read_text')).ok === true)

  // not-configured + guard cases
  const noUrl = makeConnectionOps({ getWorkspacePath: () => regWs, createSurface: () => 'x', fetchImpl: fakeFetch })
  ok('an unconfigured registry reports a clear error', /not configured/.test((await noUrl.connectionRegistrySearch({ sourceId: 'docs.google.com' })).error || ''))
  rmSync(regWs, { recursive: true, force: true })

  // ---------- MCP as an INVISIBLE tool provenance (plans/blitzos-mcp-connections.md) ----------
  // The agent never sees "MCP": a connected source's connection_list_tools surfaces an `unlock` affordance when the
  // source has a DCR-eligible official integration, and connection_call_tool returns needsApproval for an unknown
  // tool on such a source. We drive detection deterministically by pre-seeding mcp-detect's module cache (NO network),
  // so ensureMcpDetected (fired on connect / on list) resolves the seeded result. The LIVE broker merge + routing is
  // covered end-to-end by scripts/tests/test-mcp-broker.mjs (live servers); here we cover the agent-facing surface.
  const mcpWs = mkdtempSync(join(tmpdir(), 'blitz-mcp-'))
  const mops = makeConnectionOps({ getWorkspacePath: () => mcpWs, createSurface: () => 'ms' })

  // A source WITH a DCR-eligible official integration → lockable.
  clearDetectCache()
  seedDetect('lockable.example.com', { available: true, dcr: true, endpoint: 'https://mcp.lockable.example.com/mcp', asMeta: { registration_endpoint: 'https://as.example.com/register', authorization_endpoint: 'https://as.example.com/auth', token_endpoint: 'https://as.example.com/token' }, scopes: ['read'], via: 'test' })
  const lockBind = mops.connectionBind({ type: 'tab', sourceId: 'lockable.example.com', title: 'Lockable', adapter: stubAdapter() })
  // connectionBind fires ensureMcpDetected fire-and-forget; await it so the cache is primed for the sync list below.
  await mops.ensureMcpDetected('lockable.example.com')
  const lockTools = mops.connectionListTools(lockBind.connId)
  ok('a hidden MCP connection is NEVER listed as a connection (filtered out)', mops.connectionList().connections.every((c) => c.type !== 'mcp'))
  ok('connection_list_tools surfaces an `unlock` for a source with an official integration', Array.isArray(lockTools.unlock) && lockTools.unlock.length === 1 && lockTools.unlock[0].source === 'lockable.example.com')
  ok('the unlock entry carries a plain-language prompt (no "MCP"/"OAuth" wording)', typeof lockTools.unlock[0].prompt === 'string' && !/MCP|OAuth/i.test(lockTools.unlock[0].prompt))
  // an unknown tool on a lockable source → needsApproval (pops the approve card), not a bare "no saved tool" error.
  const needs = await mops.connectionCallTool(lockBind.connId, 'create_issue', {})
  ok('connection_call_tool returns needsApproval for an unknown tool on a lockable source', needs.needsApproval === true && needs.source === 'lockable.example.com')
  ok('needsApproval prompt is MCP/OAuth-free', typeof needs.prompt === 'string' && !/MCP|OAuth/i.test(needs.prompt))

  // A source WITHOUT an official integration (or non-DCR) → NOT lockable: no `unlock`, and an unknown tool is the
  // ordinary "no saved tool" error (the agent stays on the browser path), never a needsApproval loop.
  seedDetect('plain.example.com', { available: false, dcr: false, via: 'test' })
  const plainBind = mops.connectionBind({ type: 'tab', sourceId: 'plain.example.com', title: 'Plain', adapter: stubAdapter() })
  await mops.ensureMcpDetected('plain.example.com')
  const plainTools = mops.connectionListTools(plainBind.connId)
  ok('a non-integration source has NO unlock affordance', plainTools.unlock === undefined)
  const plainCall = await mops.connectionCallTool(plainBind.connId, 'create_issue', {})
  ok('an unknown tool on a non-integration source is the ordinary no-saved-tool error (no needsApproval)', !plainCall.needsApproval && /no saved tool/.test(plainCall.error || ''))
  // a source that is available BUT non-DCR (e.g. Google) is also NOT lockable (can't self-register) → no unlock.
  seedDetect('nondcr.example.com', { available: true, dcr: false, endpoint: 'https://mcp.nondcr.example.com/mcp', via: 'test' })
  const ndBind = mops.connectionBind({ type: 'tab', sourceId: 'nondcr.example.com', title: 'NonDCR', adapter: stubAdapter() })
  await mops.ensureMcpDetected('nondcr.example.com')
  ok('an available-but-non-DCR source is not lockable (no unlock)', mops.connectionListTools(ndBind.connId).unlock === undefined)

  // banked JS tools still surface for a lockable source (a source can be usable now AND have tools to unlock).
  mops.connectionSaveTool(lockBind.connId, { name: 'banked_read', description: 'a banked tool', kind: 'read', code: 'return 1' })
  const merged = mops.connectionListTools(lockBind.connId)
  ok('a lockable source still lists its banked tools alongside the unlock affordance', merged.tools.some((t) => t.name === 'banked_read') && Array.isArray(merged.unlock))
  clearDetectCache()
  rmSync(mcpWs, { recursive: true, force: true })

  rmSync(ws, { recursive: true, force: true })
  console.log('\n' + (fail ? '✗' : '✓') + ' connections: ' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
