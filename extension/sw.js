// BlitzOS Connector — MV3 service worker.
//
// Talks to BlitzOS over a LOCALHOST WebSocket. The link config (host/port/token) comes from
// chrome.storage.managed — BlitzOS writes it into the managed-preferences plist at force-install, so there
// is NO user step (no pairing code). Falls back to 127.0.0.1:7682 for unpacked dev.
//
// Executes the connection verbs on the tabs BlitzOS connects, via chrome.scripting:
//   - read / act  -> ISOLATED world (DOM read + element click/set; no eval, works everywhere)
//   - run_js      -> MAIN world (arbitrary page-context code; needs page globals)
// Coordinate clicks / key events / screenshots are deliberately NOT done here (no chrome.debugger) — BlitzOS
// drives those through the native macOS path (a Chrome window is just a macOS window).
//
// Reports tab nav/title/close so BlitzOS can keep each connection's representation widget fresh.

const DEFAULTS = { host: '127.0.0.1', port: 7682, token: '' }
let cfg = { ...DEFAULTS }
let ws = null
let backoff = 1000
let probe = 0 // cycles through the localhost port range so the extension self-discovers BlitzOS (no managed port needed)

async function loadConfig() {
  try {
    const m = await chrome.storage.managed.get(['host', 'port', 'token'])
    cfg = { host: m.host || DEFAULTS.host, port: Number(m.port) || DEFAULTS.port, token: m.token || '', portExplicit: m.port != null }
  } catch {
    cfg = { ...DEFAULTS, portExplicit: false }
  }
}

// BlitzOS binds a fixed port but probes upward if it's taken; the extension tries the same small range so
// no managed-storage port is needed (the force-install policy alone is enough — "no gates").
function portsToTry() {
  const base = cfg.port || DEFAULTS.port
  return cfg.portExplicit ? [base] : Array.from({ length: 9 }, (_, i) => base + i)
}

const connected = () => ws && ws.readyState === WebSocket.OPEN

function send(obj) {
  try {
    if (connected()) ws.send(JSON.stringify(obj))
  } catch {
    /* dropped */
  }
}

async function connect() {
  if (connected() || (ws && ws.readyState === WebSocket.CONNECTING)) return
  await loadConfig()
  const ports = portsToTry()
  const port = ports[probe % ports.length]
  const url = `ws://${cfg.host}:${port}/blitz-connector${cfg.token ? `?token=${encodeURIComponent(cfg.token)}` : ''}`
  try {
    ws = new WebSocket(url)
  } catch {
    probe++
    return scheduleReconnect()
  }
  ws.onopen = async () => {
    backoff = 1000
    probe = 0 // found it — stick to this port
    send({ type: 'hello', extension: chrome.runtime.id, tabs: await listTabs() })
  }
  ws.onmessage = (ev) => handle(ev.data)
  ws.onclose = () => {
    ws = null
    probe++ // try the next port in the range next time
    scheduleReconnect()
  }
  ws.onerror = () => {
    try {
      if (ws) ws.close()
    } catch {
      /* ignore */
    }
  }
}

function scheduleReconnect() {
  backoff = Math.min(backoff * 2, 20000)
  setTimeout(connect, backoff)
}

// Keep the SW alive: a WS message every 15s resets Chrome's 30s idle timer (Chrome 116+); the alarm is the
// backup that re-wakes + reconnects if the SW is evicted anyway.
setInterval(() => {
  if (connected()) send({ type: 'ping' })
}, 15000)
chrome.alarms.create('blitz-keepalive', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'blitz-keepalive') connect()
})

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return tabs
    .filter((t) => t.id != null && /^https?:/i.test(t.url || ''))
    .map((t) => ({ tabId: t.id, title: t.title || t.url, url: t.url, windowId: t.windowId, active: !!t.active }))
}

// ---- in-page functions (serialized into the tab by chrome.scripting; no closures over SW state) ----
function fnRead(spec) {
  const root = spec.selector ? document.querySelector(spec.selector) : document.body
  if (!root) return { error: 'no match for selector ' + spec.selector }
  const max = spec.max || 8000
  const out = { url: location.href, title: document.title, text: (root.innerText || '').slice(0, max) }
  if (spec.html) out.html = (root.outerHTML || '').slice(0, max)
  return out
}
function fnAct(spec) {
  const el = spec.selector ? document.querySelector(spec.selector) : document.activeElement
  if (spec.action === 'click') {
    if (!el) return { error: 'no match for ' + spec.selector }
    const before = location.href
    el.click()
    return { clicked: spec.selector || true, urlBefore: before, url: location.href }
  }
  if (spec.action === 'set' || spec.action === 'type') {
    if (!el) return { error: 'no match for ' + spec.selector }
    if (el.focus) el.focus()
    if ('value' in el) {
      el.value = spec.text == null ? '' : String(spec.text)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { value: el.value }
    }
    el.textContent = spec.text == null ? '' : String(spec.text)
    return { value: el.textContent }
  }
  if (spec.action === 'key') {
    const t = el || document.activeElement || document.body
    const opts = { key: spec.key, bubbles: true }
    t.dispatchEvent(new KeyboardEvent('keydown', opts))
    t.dispatchEvent(new KeyboardEvent('keyup', opts))
    return { key: spec.key }
  }
  return { error: 'unknown action ' + spec.action }
}
function fnRunJs(code, args) {
  try {
    // arbitrary page-context code (the escape hatch). Subject to the PAGE's CSP in MAIN world — a strict
    // 'unsafe-eval'-free site blocks this; use read/act (or the native coordinate path) there instead.
    // eslint-disable-next-line no-new-func
    const r = new Function('args', code)(args)
    return { result: r === undefined ? null : r }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}

async function exec(tabId, world, func, args) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, world, func, args })
    return res && res[0] ? res[0].result : { error: 'no result (tab not scriptable)' }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
}

async function handle(data) {
  let msg
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }
  if (msg.type === 'pong' || msg.type === 'ack') return
  const { id, cmd } = msg
  const reply = (payload) => send({ type: 'reply', id, ...payload })
  try {
    if (cmd === 'listTabs') return reply({ result: await listTabs() })
    if (cmd === 'ping') return reply({ result: { pong: true } })
    const tabId = msg.tabId
    if (tabId == null) return reply({ error: 'tabId required' })
    if (cmd === 'read') return reply({ result: await exec(tabId, 'ISOLATED', fnRead, [msg.args || {}]) })
    if (cmd === 'act') return reply({ result: await exec(tabId, 'ISOLATED', fnAct, [msg.args || {}]) })
    if (cmd === 'run_js') return reply({ result: await exec(tabId, 'MAIN', fnRunJs, [String(msg.code || ''), msg.args || {}]) })
    return reply({ error: 'unknown cmd ' + cmd })
  } catch (e) {
    reply({ error: String((e && e.message) || e) })
  }
}

// ---- tab lifecycle -> BlitzOS (keeps each connection's representation fresh; BlitzOS classifies significance) ----
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) send({ type: 'event', kind: 'urlChanged', tabId, url: info.url, title: tab.title })
  else if (info.title) send({ type: 'event', kind: 'titleChanged', tabId, title: info.title, url: tab.url })
  else if (info.status === 'complete') send({ type: 'event', kind: 'navigationCommitted', tabId, url: tab.url, title: tab.title })
})
chrome.tabs.onRemoved.addListener((tabId) => send({ type: 'event', kind: 'tabClosed', tabId }))

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
connect()
