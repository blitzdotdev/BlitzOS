// Probe: does creating a terminal surface hang the renderer? Captures console + exceptions, spawns ONE
// session via the BACKEND (so the page only receives it over SSE), and tries to read the DOM with a
// short CDP timeout — a timeout means the page main thread is blocked (infinite loop).
//   node scripts/probe-render.mjs [pageUrl] [backendUrl]
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import http from 'node:http'

const pageUrl = process.argv[2] || 'http://127.0.0.1:5174'
const backend = process.argv[3] || 'http://127.0.0.1:8799'
const LOG = '/tmp/probe-render.log'
try { writeFileSync(LOG, '') } catch { /* ignore */ }
const log = (s) => { try { appendFileSync(LOG, s + '\n') } catch { /* ignore */ } console.log(s) }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'blitz-probe-'))

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {})
    const u = new URL(backend + path)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b))
    })
    req.on('error', reject); req.write(data); req.end()
  })
}

const child = spawn(process.env.CHROMIUM || '/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=1400,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no ws')), 20000)
    child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]) } })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('chromium exited ' + c)) })
  })
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}, sid, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const i = ++id
    const to = setTimeout(() => { if (pending.delete(i)) reject(new Error('CDP TIMEOUT: ' + method)) }, timeoutMs)
    pending.set(i, { resolve: (v) => { clearTimeout(to); resolve(v) }, reject: (e) => { clearTimeout(to); reject(e) } })
    ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params }))
  })
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d) } catch { return }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    else if (m.method === 'Runtime.exceptionThrown') log('  ⚠ EXCEPTION: ' + JSON.stringify(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || m.params).slice(0, 400))
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params?.type === 'error' || m.params?.type === 'warning')) log('  ▸ console.' + m.params.type + ': ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
  })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  const evalJs = async (expr, timeoutMs = 8000) => {
    const r = await send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, returnByValue: true }, sessionId, timeoutMs)
    if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }

  log('navigate ' + pageUrl)
  await send('Page.navigate', { url: pageUrl }, sessionId)
  await delay(5000)

  log('baseline (page responsive?):')
  log('  windows on canvas: ' + (await evalJs(`return document.querySelectorAll('.window').length`)))
  log('  agentOS.sessionSpawn present: ' + (await evalJs(`return !!(window.agentOS&&window.agentOS.sessionSpawn)`)))
  log('  activeWs (toolbar): ' + (await evalJs(`return (document.querySelector('.ws-name')||{}).textContent || '(none)'`)))

  log('spawning ONE session via BACKEND (page receives it via SSE)…')
  const r = await post('/api/os/session-spawn', { command: 'bash', title: 'probe-1' })
  log('  backend reply: ' + r.slice(0, 160))

  log('waiting 4s for the SSE to create the terminal…')
  await delay(4000)

  log('reading DOM after terminal creation (CDP timeout = the main thread is blocked):')
  try {
    const tabs = await evalJs(`return document.querySelectorAll('.window-tabs .wtab').length`, 6000)
    log('  ✓ responsive — terminal tabs: ' + tabs)
    log('  terminal windows: ' + (await evalJs(`return document.querySelectorAll('.window').length`)))
  } catch (e) {
    log('  ✗ ' + e.message + '  →  PAGE MAIN THREAD IS BLOCKED on terminal creation')
  }

  log('DONE')
  ws.close()
  cleanup(0)
}
main().catch((e) => { log('probe failed: ' + e.message); cleanup(1) })
