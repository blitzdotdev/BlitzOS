// CDP driver to exercise the terminal TAB system end-to-end in a real browser.
// Loads the server-mode renderer, spawns N sessions via window.agentOS.sessionSpawn,
// asserts they collapse into ONE terminal window with N tabs, switches a tab, and
// screenshots each step. Wall-clock waits (the page holds an SSE open → never idles).
//
//   node scripts/drive-tabs.mjs [url]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const url = process.argv[2] || 'http://127.0.0.1:5174'
const [W, H] = [1600, 1000]
const bin = process.env.CHROMIUM || '/usr/bin/chromium'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'blitz-tabs-'))

const child = spawn(bin, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  `--window-size=${W},${H}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no DevTools ws in 20s\n' + stderr.slice(-600))), 20000)
    child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(timer); resolve(m[0]) } })
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('chromium exited ' + c)) })
  })
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject })
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
  })
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d) } catch { return }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
  })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId)
  await send('Page.navigate', { url }, sessionId)
  await delay(6000) // page load + SSE connect + hydrate

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const path = `/tmp/tabs-${name}.png`
    writeFileSync(path, Buffer.from(data, 'base64'))
    console.log('  shot →', path, `(${Buffer.from(data, 'base64').length}b)`)
  }

  // sanity: shim present?
  const hasApi = await evalJs('!!(window.agentOS && window.agentOS.sessionSpawn)')
  console.log('agentOS.sessionSpawn present:', hasApi)
  if (!hasApi) { console.error('FAIL: shim/sessionSpawn missing'); cleanup(1) }

  // spawn 3 sessions
  console.log('spawning 3 sessions…')
  await evalJs(`window.agentOS.sessionSpawn({ command: 'bash', title: 'shell-1' })`)
  await delay(1200)
  await evalJs(`window.agentOS.sessionSpawn({ command: 'bash', title: 'shell-2' })`)
  await delay(1200)
  await evalJs(`window.agentOS.sessionSpawn({ command: 'bash', title: 'shell-3' })`)
  await delay(2500)

  // assert: ONE terminal window, THREE tabs
  const termCount = await evalJs(`document.querySelectorAll('.window-tabs').length`)
  const tabCount = await evalJs(`document.querySelectorAll('.window-tabs .wtab').length`)
  const tabTitles = await evalJs(`Array.from(document.querySelectorAll('.window-tabs .wtab .wtab-title')).map(e=>e.textContent)`)
  const activeIdx = await evalJs(`(()=>{const t=Array.from(document.querySelectorAll('.window-tabs .wtab'));return t.findIndex(e=>e.classList.contains('active'))})()`)
  console.log('terminal windows:', termCount, '| tabs:', tabCount, '| titles:', JSON.stringify(tabTitles), '| active idx:', activeIdx)
  await shot('1-three-tabs')

  // switch to the FIRST tab and confirm the active class moves + body shows it
  console.log('clicking tab 0…')
  await evalJs(`document.querySelectorAll('.window-tabs .wtab')[0].click()`)
  await delay(1500)
  const activeAfter = await evalJs(`(()=>{const t=Array.from(document.querySelectorAll('.window-tabs .wtab'));return t.findIndex(e=>e.classList.contains('active'))})()`)
  console.log('active idx after clicking tab 0:', activeAfter)
  await shot('2-tab0-active')

  // close the MIDDLE tab via its ✕ and confirm count drops to 2
  console.log('closing tab 1 (the ✕)…')
  await evalJs(`(()=>{const t=document.querySelectorAll('.window-tabs .wtab');const c=t[1].querySelector('.wtab-close');c.click()})()`)
  await delay(1500)
  const tabCount2 = await evalJs(`document.querySelectorAll('.window-tabs .wtab').length`)
  const titles2 = await evalJs(`Array.from(document.querySelectorAll('.window-tabs .wtab .wtab-title')).map(e=>e.textContent)`)
  console.log('tabs after close:', tabCount2, '| titles:', JSON.stringify(titles2))
  await shot('3-after-close')

  // use the "+" to spawn a new tab
  console.log('clicking the + to add a tab…')
  await evalJs(`document.querySelector('.window-tabs .wtab-add').click()`)
  await delay(2500)
  const tabCount3 = await evalJs(`document.querySelectorAll('.window-tabs .wtab').length`)
  console.log('tabs after +:', tabCount3)
  await shot('4-after-add')

  // result summary
  const ok = termCount === 1 && tabCount === 3 && activeAfter === 0 && tabCount2 === 2 && tabCount3 === 3
  console.log(ok ? '\nPASS ✓ tabs behave correctly' : '\nFAIL ✗ see numbers above')
  ws.close()
  cleanup(ok ? 0 : 2)
}
main().catch((e) => { console.error('drive failed:', e.message); cleanup(1) })
