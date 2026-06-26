// BlitzOS CDP Bridge — minimal MV3 service worker. ONLY the "debugger" permission.
// Connects out to a localhost WebSocket (our test harness) and relays CDP commands via chrome.debugger.
// Protocol (JSON): {id, cmd:'listTargets'} | {id, cmd:'attach', tabId} | {id, cmd:'detach', tabId}
//                  | {id, cmd:'cdp', tabId, method, params}   ->  {type:'reply', id, result|error}
const PORT = 9234
let ws = null

function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return // already connecting/open — no storms
  try { ws = new WebSocket(`ws://127.0.0.1:${PORT}`) } catch (e) { ws = null; return setTimeout(connect, 1000) }
  ws.onopen = () => send({ type: 'hello', id: chrome.runtime.id })
  ws.onmessage = (ev) => handle(ev.data)
  ws.onclose = () => { ws = null; setTimeout(connect, 1000) }
  ws.onerror = () => { try { ws && ws.close() } catch (_) {} }
}
function send(o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)) } catch (_) {} }

async function handle(data) {
  let m; try { m = JSON.parse(data) } catch { return }
  const { id, cmd } = m
  const reply = (p) => send({ type: 'reply', id, ...p })
  try {
    if (cmd === 'listTargets') {
      chrome.debugger.getTargets((targets) => reply({ result: (targets || []).filter((t) => t.type === 'page').map((t) => ({ tabId: t.tabId, title: t.title, url: t.url, attached: t.attached })) }))
      return
    }
    if (cmd === 'attach') {
      chrome.debugger.attach({ tabId: m.tabId }, '1.3', () => {
        const e = chrome.runtime.lastError
        if (e && !/already attached/i.test(e.message)) return reply({ error: e.message })
        reply({ result: { attached: m.tabId } })
      })
      return
    }
    if (cmd === 'detach') {
      chrome.debugger.detach({ tabId: m.tabId }, () => reply({ result: { detached: m.tabId, err: chrome.runtime.lastError?.message || null } }))
      return
    }
    if (cmd === 'cdp') {
      chrome.debugger.sendCommand({ tabId: m.tabId }, m.method, m.params || {}, (res) => {
        const e = chrome.runtime.lastError
        reply(e ? { error: e.message } : { result: res || {} })
      })
      return
    }
    reply({ error: 'unknown cmd ' + cmd })
  } catch (e) { reply({ error: String(e && e.message || e) }) }
}

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
// alarms keep-alive: wakes the SW even after MV3 eviction so it reconnects to the harness on its own.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => { if (!ws || ws.readyState !== 1) connect() })
connect()
setInterval(() => send({ type: 'ping' }), 15000) // WS traffic keeps the SW alive during a test
