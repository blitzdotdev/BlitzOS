// The TAB adapter's transport: a localhost WebSocket server that the BlitzOS Connector Chrome extension
// (extension/) connects to. ONE shared module (Electron + server both bind it via `ws`, which both already
// depend on). It validates the extension (Origin: chrome-extension://<our id> + an optional per-install
// token), tracks the single service-worker connection + the browser's tabs, and — when a tab is connected —
// binds a connection in the registry whose ADAPTER forwards read/act/run_js to the extension over the socket.
// Tab nav/title/close events become connectionNotify() so the representation widget stays fresh.
//
// CDP (chrome.debugger) IS available now (cdp-browser plan): the adapter forwards a raw `cdp` verb and a
// `navigate` verb, and screenshot/trusted-input reads+acts ride the normal read/act verbs (the SW routes them
// to CDP by their args). openAgentWindow opens a per-agent BACKGROUND window in the dedicated AI Chrome.

import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'

// Stable id of the self-hosted extension (derived from extension/manifest.json `key`). The force-install
// policy, the Origin check, and the managed-storage config all key on this.
export const CONNECTOR_EXTENSION_ID = 'paknignciplamgbppaejghpbpikdekdc'
export const DEFAULT_TAB_LINK_PORT = 7682

/**
 * @param {object} opts
 * @param {import('./connection-ops.d.mts').ConnectionOps} opts.connectionOps  the registry to bind tabs into
 * @param {number} [opts.port]   localhost port to listen on (probes a small range if taken)
 * @param {string} [opts.token]  per-install token the extension must present (Origin is forgeable by non-browser procs)
 * @param {(s:{ok:boolean, port?:number, connected?:boolean, error?:string})=>void} [opts.onStatus]
 */
export function makeTabLink({ connectionOps, port = DEFAULT_TAB_LINK_PORT, token = '', onStatus = () => {} } = {}) {
  let wss = null
  let sock = null // the single service-worker connection (one browser)
  let boundPort = null
  let knownTabs = [] // last tab list the SW reported (for the picker)
  const pending = new Map() // requestId -> { resolve, timer }
  const tabToConn = new Map() // tabId -> connId

  const expectedOrigin = () => `chrome-extension://${CONNECTOR_EXTENSION_ID}`
  const isUp = () => !!(sock && sock.readyState === 1 /* OPEN */)

  function start(bindPort = port) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (v) => {
        if (settled) return
        settled = true
        resolve(v)
      }
      let server
      try {
        server = new WebSocketServer({
          host: '127.0.0.1',
          port: bindPort,
          verifyClient: (info, done) => {
            const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin) || ''
            if (origin !== expectedOrigin()) return done(false, 403, 'forbidden origin')
            if (token) {
              let presented = ''
              try {
                presented = new URL(info.req.url, 'http://x').searchParams.get('token') || ''
              } catch {
                presented = ''
              }
              if (presented !== token) return done(false, 401, 'bad token')
            }
            done(true)
          }
        })
      } catch (e) {
        return finish({ ok: false, error: String(e), port: null })
      }
      server.on('error', (e) => {
        // port busy → probe the next one in a small range; otherwise report failure
        if (e && e.code === 'EADDRINUSE' && bindPort < port + 8) {
          try {
            server.close()
          } catch {
            /* ignore */
          }
          finish(start(bindPort + 1))
        } else {
          onStatus({ ok: false, error: String((e && e.message) || e) })
          finish({ ok: false, error: String((e && e.message) || e), port: null })
        }
      })
      server.on('listening', () => {
        wss = server
        boundPort = bindPort
        onStatus({ ok: true, port: bindPort, connected: false })
        finish({ ok: true, port: bindPort })
      })
      server.on('connection', (s) => {
        sock = s
        onStatus({ ok: true, port: boundPort, connected: true })
        s.on('message', (data) => onMessage(String(data)))
        s.on('close', () => {
          if (sock === s) sock = null
          // the link dropped: every connected tab is now unreachable
          for (const connId of tabToConn.values()) connectionOps.connectionUnbind(connId, { status: 'disconnected' })
          onStatus({ ok: true, port: boundPort, connected: false })
        })
      })
    })
  }

  function onMessage(data) {
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (msg.type === 'hello') {
      knownTabs = Array.isArray(msg.tabs) ? msg.tabs : []
      return
    }
    if (msg.type === 'ping') {
      try {
        if (sock) sock.send(JSON.stringify({ type: 'pong' }))
      } catch {
        /* ignore */
      }
      return
    }
    if (msg.type === 'reply' && msg.id != null) {
      const p = pending.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(msg.id)
        p.resolve(msg.error ? { error: msg.error } : msg.result)
      }
      return
    }
    if (msg.type === 'event') onTabEvent(msg)
  }

  function onTabEvent(ev) {
    if (ev.kind === 'tabClosed') {
      knownTabs = knownTabs.filter((t) => t.tabId !== ev.tabId)
      const connId = tabToConn.get(ev.tabId)
      if (connId) {
        connectionOps.connectionUnbind(connId, { status: 'disconnected' })
        tabToConn.delete(ev.tabId)
      }
      return
    }
    const connId = tabToConn.get(ev.tabId)
    if (!connId) return
    // CROSS-ORIGIN nav → re-key the connection's sourceId so its per-source tools track the page the tab is
    // actually on (the design contract: never run example.com's tools against the site it navigated to). The
    // re-key emits its own moment, so we're done if the host changed.
    if (ev.url && (ev.kind === 'navigationCommitted' || ev.kind === 'urlChanged') && typeof connectionOps.connectionRekey === 'function') {
      let host = ''
      try {
        host = new URL(ev.url).host
      } catch {
        host = ''
      }
      if (host) {
        const r = connectionOps.connectionRekey(connId, host)
        if (r && r.changed) return
      }
    }
    // a nav / cross-origin url change is a SIGNIFICANT source change (immediate wake); a title-only
    // change is minor (still notify, but not significant). BlitzOS-side significance, per the doc.
    const significant = ev.kind === 'navigationCommitted' || ev.kind === 'urlChanged'
    connectionOps.connectionNotify(connId, { significant, summary: ev.kind === 'titleChanged' ? 'title changed' : 'navigated' })
  }

  function cmd(payload, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!isUp()) return resolve({ error: 'the BlitzOS Connector extension is not connected' })
      const id = randomUUID().slice(0, 8)
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ error: 'the extension did not reply (the tab may be gone or busy)' })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      try {
        sock.send(JSON.stringify({ id, ...payload }))
      } catch (e) {
        clearTimeout(timer)
        pending.delete(id)
        resolve({ error: String((e && e.message) || e) })
      }
    })
  }

  async function listTabs() {
    const r = await cmd({ cmd: 'listTabs' })
    if (Array.isArray(r)) {
      knownTabs = r
      return r
    }
    return knownTabs // fall back to the last hello/cache when the live query fails
  }

  // Browser windows + their on-screen bounds + active tab (for the picker's bounds bridge: drop a Chrome window →
  // its active tab). Returns [] when the extension isn't connected / the query fails.
  async function listWindows() {
    const r = await cmd({ cmd: 'listWindows' })
    return Array.isArray(r) ? r : []
  }

  function sourceIdForUrl(url) {
    try {
      return new URL(url).host || 'tab'
    } catch {
      return 'tab'
    }
  }

  // The per-tab ADAPTER the registry calls (read/act/run_js/cdp/navigate forwarded to the extension over the
  // socket). Shared by connectTab (a user-connected tab) and openAgentWindow (a fresh AI-browser window).
  // run_js/act/navigate keep their existing shapes; `cdp` is a raw passthrough (method/params at top level so
  // the SW's cdp verb reads them); screenshot/trusted reads+acts ride the normal read/act verbs (the SW routes
  // those to CDP based on their args), so nothing special is needed here for them.
  function buildAdapter(id) {
    return {
      call: async (verb, args) => {
        if (verb === 'run_js') {
          return cmd({ cmd: 'run_js', tabId: id, code: String((args && args.code) || ''), args: (args && args.args) || {} })
        }
        if (verb === 'cdp') {
          return cmd({ cmd: 'cdp', tabId: id, method: args && args.method, params: (args && args.params) || {} })
        }
        if (verb === 'navigate') {
          const r = await cmd({ cmd: 'navigate', tabId: id, url: (args && args.url) || '' })
          return r && r.error ? r : { effect: r }
        }
        if (verb === 'act') {
          const r = await cmd({ cmd: 'act', tabId: id, args: args || {} })
          return r && r.error ? r : { effect: r }
        }
        return cmd({ cmd: verb, tabId: id, args: args || {} })
      },
      drop: () => {
        tabToConn.delete(id)
      }
    }
  }

  // Open a fresh BACKGROUND window in the AI Chrome (one per agent) and bind it as a tab connection owned by
  // that agent. The new window is focused:false (no focus steal); its tab is driven by CDP (trusted input +
  // screenshots) the same as any connected tab. Reuses the per-agent window via the dedup in connectionBind only
  // indirectly — callers (connectionOpenBrowser) decide whether to reuse an existing live window for the agent.
  async function openAgentWindow(agentId, opts = {}) {
    const url = opts.url || 'about:blank'
    const r = await cmd({ cmd: 'newWindow', url })
    if (!r || r.error) return { error: (r && r.error) || 'could not open an AI-browser window (is the connector loaded in the AI Chrome?)' }
    const id = Number(r.tabId)
    if (!Number.isFinite(id)) return { error: 'the AI Chrome opened a window but returned no tab id' }
    const sourceId = opts.sourceId || sourceIdForUrl(url)
    const adapter = buildAdapter(id)
    const bound = connectionOps.connectionBind({
      type: 'tab',
      sourceId,
      title: opts.title || 'AI browser',
      capabilities: { run_js: true, act: true, cdp: true },
      adapter,
      ref: id,
      agentId
    })
    tabToConn.set(id, bound.connId)
    return { connId: bound.connId, surfaceId: bound.surfaceId, sourceId, tab: { tabId: id, url } }
  }

  async function connectTab(tabId, opts = {}) {
    const id = Number(tabId)
    // DEDUP: this exact tab is already connected (and live) → re-attach, don't spawn a duplicate connection+widget.
    const existing = tabToConn.get(id)
    if (existing && typeof connectionOps.connectionIsLive === 'function' && connectionOps.connectionIsLive(existing)) {
      const info = connectionOps.connectionInfo(existing)
      if (info) {
        // re-attaching an already-live tab from a (possibly different) chat → transfer ownership so it lists in
        // THIS chat's dropbox + wakes this chat's agent, instead of staying owned by the first chat and vanishing.
        if (typeof connectionOps.connectionSetOwner === 'function') connectionOps.connectionSetOwner(existing, opts.agentId)
        return { ...info, tab: { tabId: id } }
      }
    }
    let tab = knownTabs.find((t) => t.tabId === id)
    if (!tab) tab = (await listTabs()).find((t) => t.tabId === id)
    if (!tab) return { error: `tab ${tabId} not found (is it still open?)` }
    const sourceId = opts.sourceId || sourceIdForUrl(tab.url)
    const adapter = buildAdapter(id)
    const bound = connectionOps.connectionBind({ type: 'tab', sourceId, title: opts.title || tab.title, capabilities: { run_js: true, act: true, cdp: true }, adapter, ref: id, agentId: opts.agentId })
    tabToConn.set(id, bound.connId)
    return { connId: bound.connId, surfaceId: bound.surfaceId, sourceId, tab: { tabId: id, title: tab.title, url: tab.url } }
  }

  function stop() {
    try {
      if (wss) wss.close()
    } catch {
      /* ignore */
    }
    wss = null
    sock = null
  }

  return {
    start,
    stop,
    listTabs,
    listWindows,
    connectTab,
    openAgentWindow,
    isConnected: isUp,
    get extensionId() {
      return CONNECTOR_EXTENSION_ID
    },
    get port() {
      return boundPort || port
    }
  }
}
