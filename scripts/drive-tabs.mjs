// CDP driver to exercise the terminal TAB system end-to-end in a real browser.
// Loads the server-mode renderer, spawns N terminals via window.agentOS.terminalSpawn,
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
  const hasApi = await evalJs('!!(window.agentOS && window.agentOS.terminalSpawn)')
  console.log('agentOS.terminalSpawn present:', hasApi)
  if (!hasApi) { console.error('FAIL: shim/terminalSpawn missing'); cleanup(1) }

  // spawn 3 sessions
  console.log('spawning 3 sessions…')
  await evalJs(`window.agentOS.terminalSpawn({ command: 'bash', title: 'shell-1' })`)
  await delay(1200)
  await evalJs(`window.agentOS.terminalSpawn({ command: 'bash', title: 'shell-2' })`)
  await delay(1200)
  await evalJs(`window.agentOS.terminalSpawn({ command: 'bash', title: 'shell-3' })`)
  await delay(2500)

  // We scope every assertion to OUR shell-N tabs (title prefix 'shell-'), because agents now auto-show
  // their own terminals as tabs (an agent IS a terminal you watch work), so the canvas can hold other
  // terminal windows/tabs we didn't create. The 3 shells must still collapse into ONE window.
  const SHELL = `(t)=>/^shell-/.test((t.querySelector('.wtab-title')||{}).textContent||'')`
  // window that holds our shell tabs + its total tab count + how many of those are shells
  const winInfo = `(()=>{const wins=[...document.querySelectorAll('.window-tabs')];const w=wins.find(w=>[...w.querySelectorAll('.wtab')].some(${SHELL}));if(!w)return{winsWithShell:0,winTabs:0,shellCount:0,shellTitles:[]};const tabs=[...w.querySelectorAll('.wtab')];return{winsWithShell:wins.filter(w=>[...w.querySelectorAll('.wtab')].some(${SHELL})).length,winTabs:tabs.length,shellCount:tabs.filter(${SHELL}).length,shellTitles:tabs.filter(${SHELL}).map(t=>(t.querySelector('.wtab-title')||{}).textContent)}})()`

  const i1 = await evalJs(winInfo)
  console.log('shells:', i1.shellCount, '| in N windows:', i1.winsWithShell, '| titles:', JSON.stringify(i1.shellTitles), '| window total tabs:', i1.winTabs)
  await shot('1-three-tabs')

  // switch to OUR shell-1 tab (by title, not index — the window may also hold the agent tab) and confirm active
  console.log('clicking shell-1…')
  await evalJs(`(()=>{const t=[...document.querySelectorAll('.window-tabs .wtab')].find(t=>(t.querySelector('.wtab-title')||{}).textContent==='shell-1');t&&t.click()})()`)
  await delay(1500)
  const shell1Active = await evalJs(`(()=>{const t=[...document.querySelectorAll('.window-tabs .wtab')].find(t=>(t.querySelector('.wtab-title')||{}).textContent==='shell-1');return !!(t&&t.classList.contains('active'))})()`)
  console.log('shell-1 active after click:', shell1Active)
  await shot('2-tab0-active')

  // close shell-2 via its ✕ and confirm our shell count drops to 2
  console.log('closing shell-2 (the ✕)…')
  await evalJs(`(()=>{const t=[...document.querySelectorAll('.window-tabs .wtab')].find(t=>(t.querySelector('.wtab-title')||{}).textContent==='shell-2');t&&t.querySelector('.wtab-close').click()})()`)
  await delay(1500)
  const i2 = await evalJs(winInfo)
  console.log('shells after close:', i2.shellCount, '| titles:', JSON.stringify(i2.shellTitles))
  await shot('3-after-close')

  // use the "+" on OUR shells' window to spawn a new tab; that window's total tab count grows by 1
  console.log('clicking the + to add a tab…')
  await evalJs(`(()=>{const wins=[...document.querySelectorAll('.window-tabs')];const w=wins.find(w=>[...w.querySelectorAll('.wtab')].some(${SHELL}));w&&w.querySelector('.wtab-add').click()})()`)
  await delay(2500)
  const i3 = await evalJs(winInfo)
  console.log('window total tabs after +:', i3.winTabs, '(was', i2.winTabs + ')')
  await shot('4-after-add')

  // cleanup: remove every terminal this run spawned so the workspace is left as found (only the agents).
  console.log('\n[cleanup] removing spawned terminals')
  await evalJs(`(async()=>{const ts=(await window.agentOS.terminalList()).filter(s=>s.kind==='terminal'); for(const t of ts){try{window.agentOS.terminalRemove(t.id)}catch{}} return ts.length})()`)

  // result summary — scoped to our shells: 3 shells in ONE window, switch works, close→2, + grows the window
  const ok = i1.shellCount === 3 && i1.winsWithShell === 1 && shell1Active && i2.shellCount === 2 && i3.winTabs === i2.winTabs + 1
  console.log(ok ? '\nPASS ✓ tabs behave correctly' : '\nFAIL ✗ see numbers above')
  ws.close()
  cleanup(ok ? 0 : 2)
}
main().catch((e) => { console.error('drive failed:', e.message); cleanup(1) })
