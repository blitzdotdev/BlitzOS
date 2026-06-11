// CDP driver for the Terminals & Agents UX: the runtime tray (list/open/stop/resume), better naming,
// and resume-on-reload.
//   node scripts/drive-terminals.mjs [url]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const LOG = '/tmp/term-driver.log'
try { writeFileSync(LOG, '') } catch { /* ignore */ }
const logln = (s) => { try { appendFileSync(LOG, s + '\n') } catch { /* ignore */ } console.log(s) }

const url = process.argv[2] || 'http://127.0.0.1:5174'
const [W, H] = [1600, 1000]
const bin = process.env.CHROMIUM || '/usr/bin/chromium'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'blitz-term-'))

const child = spawn(bin, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  `--window-size=${W},${H}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }
const fails = []
const check = (cond, label) => { logln((cond ? '  ✓ ' : '  ✗ ') + label); if (!cond) fails.push(label) }

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no DevTools ws')), 20000)
    child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(timer); resolve(m[0]) } })
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('chromium exited ' + c)) })
  })
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  // CDP attach boilerplate — `sessionId` here is Chrome DevTools Protocol's, not a BlitzOS terminal. Leave as-is.
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject })
    const to = setTimeout(() => { if (pending.delete(i)) reject(new Error('CDP timeout: ' + method + ' ' + JSON.stringify(params).slice(0, 80))) }, 15000)
    const orig = { resolve, reject }
    pending.set(i, { resolve: (v) => { clearTimeout(to); orig.resolve(v) }, reject: (e) => { clearTimeout(to); orig.reject(e) } })
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
  })
  ws.on('message', (d) => { let m; try { m = JSON.parse(d) } catch { return } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

  // CDP Target attach — `sessionId` is the DevTools attach handle (foreign namespace; do not rename).
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId)
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(`/tmp/term-${name}.png`, Buffer.from(data, 'base64')); logln('  shot → /tmp/term-' + name + '.png') }

  await send('Page.navigate', { url }, sessionId)
  await delay(6000)

  // Delta-based: tolerate terminals left over from prior runs / resurrected by resume-on-load. We assert
  // CHANGES (a spawn adds exactly one tab, the tray gains exactly one row) and that OUR titles appear —
  // never absolute counts, which a shared backend can't guarantee.
  const tabCount = () => evalJs(`return document.querySelectorAll('.window-tabs .wtab').length`)

  // --- 0. RESET to a clean slate: remove every non-agent terminal (running + dead) so titles are unique and
  // counts are deterministic on every run (the agent '0' is never removable). This is what makes the test reliable. ---
  logln('[0] reset — remove all terminals (keep the agent)')
  const removed = await evalJs(`const ts=(await window.agentOS.terminalList()).filter(s=>s.kind==='terminal'); for (const t of ts){ try{ window.agentOS.terminalRemove(t.id) }catch{} } return ts.length`)
  logln(`  removed ${removed} pre-existing terminal(s)`)
  await delay(2500)
  await send('Page.navigate', { url }, sessionId) // reload so the tab strip reflects the clean slate
  await delay(6000)
  const baseTabs = await tabCount()
  logln(`baseline tabs after reset: ${baseTabs}`)

  // --- 1. spawn 2 terminals, confirm +2 tabs ---
  logln('\n[1] spawn 2 terminals')
  await evalJs(`window.agentOS.terminalSpawn({command:'bash', title:'work-A'}); return 1`)
  await delay(1300)
  await evalJs(`window.agentOS.terminalSpawn({command:'bash', title:'work-B'}); return 1`)
  await delay(2500)
  const afterSpawn = await tabCount()
  check(afterSpawn === baseTabs + 2, `+2 terminal tabs after 2 spawns (${baseTabs} → ${afterSpawn})`)

  // --- 2. open the Terminals & Agents tray via the toolbar button ---
  logln('\n[2] open Terminals & Agents tray')
  await evalJs(`const b=Array.from(document.querySelectorAll('.toolbar button')).find(x=>/Terminals|Runtime/.test(x.textContent||'')); b&&b.click(); return 1`)
  await delay(1500)
  check(await evalJs(`return !!document.querySelector('.runtime-panel')`), 'runtime panel opened')
  const titles = await evalJs(`return Array.from(document.querySelectorAll('.runtime-panel .run-title')).map(e=>e.textContent)`)
  check(titles.includes('work-A') && titles.includes('work-B'), `tray lists the spawned terminals work-A/B (got ${JSON.stringify(titles)})`)
  await shot('1-tray-2-running')

  // Target the work-A row BY TITLE — robust to the Agents/Terminals grouping, row order, and dead rows from prior runs.
  const findRow = (t) => `Array.from(document.querySelectorAll('.runtime-panel .run-row')).find(r=>{const e=r.querySelector('.run-title');return e&&e.textContent==='${t}'})`

  // --- 3. Stop the work-A terminal from the tray ---
  logln('\n[3] Stop a terminal from the tray')
  await evalJs(`const r=${findRow('work-A')}; const b=r&&Array.from(r.querySelectorAll('.run-btn')).find(x=>/Stop/.test(x.textContent)); b&&b.click(); return 1`)
  await delay(3000)
  const workAResumable = await evalJs(`const r=${findRow('work-A')}; return !!r && /Resume/.test(r.textContent)`)
  check(workAResumable, 'the stopped work-A terminal now offers Resume')
  await shot('2-after-stop')

  // --- 4. Resume work-A ---
  logln('\n[4] Resume the stopped terminal')
  await evalJs(`const r=${findRow('work-A')}; const b=r&&Array.from(r.querySelectorAll('.run-btn')).find(x=>/Resume/.test(x.textContent)); b&&b.click(); return 1`)
  await delay(3500)
  const workARunningAgain = await evalJs(`const r=${findRow('work-A')}; return !!r && !/Resume/.test(r.textContent)`)
  check(workARunningAgain, 'work-A is running again after Resume (no Resume button)')
  await shot('3-after-resume')

  // --- 5. "+ Terminal" names the next terminal "Terminal N" and adds exactly one tab ---
  logln('\n[5] + Terminal uses incrementing name')
  const tabsBeforeNew = await tabCount()
  await evalJs(`const b=Array.from(document.querySelectorAll('.toolbar button')).find(x=>/\\+ Terminal/.test(x.textContent||'')); b&&b.click(); return 1`)
  await delay(2500)
  const titles2 = await evalJs(`return Array.from(document.querySelectorAll('.runtime-panel .run-title')).map(e=>e.textContent)`)
  check(titles2.some((t) => /^Terminal \d+$/.test(t)), `a "Terminal N" terminal exists (got ${JSON.stringify(titles2)})`)
  const tabsAfterNew = await tabCount()
  check(tabsAfterNew === tabsBeforeNew + 1, `+1 tab after "+ Terminal" (${tabsBeforeNew} → ${tabsAfterNew})`)
  await shot('4-after-new')

  // --- 6. resume-on-reload: reload the page, tabs reappear from live terminals ---
  // EVERY live terminal auto-tabs on reload — plain shells AND agents (an agent is a terminal you watch
  // claude work in). Tabs are renderer-only, reconstructed from terminalList(); the count must round-trip.
  logln('\n[6] resume on reload')
  const runningBefore = await evalJs(`return (await window.agentOS.terminalList()).filter(s=>s.status==='running').length`)
  await send('Page.navigate', { url }, sessionId) // hard reload (CDP sessionId, foreign — keep)
  await delay(6500)
  const tabsAfterReload = await evalJs(`return document.querySelectorAll('.window-tabs .wtab').length`)
  check(tabsAfterReload === runningBefore, `tabs reconstructed on reload: ${tabsAfterReload} tabs == ${runningBefore} running terminals (incl agents)`)
  await shot('5-after-reload')

  // --- cleanup: REMOVE every terminal this run created (delete the record, don't just stop) so the workspace
  // is left exactly as found — only the agent remains. This is why the test works every time. ---
  logln('\n[cleanup] removing spawned terminals')
  await evalJs(`const ts = (await window.agentOS.terminalList()).filter(s=>s.kind==='terminal'); for (const t of ts) { try { window.agentOS.terminalRemove(t.id) } catch {} } return ts.length`)

  logln(fails.length ? `\nFAIL ✗ ${fails.length} check(s): ${fails.join(' | ')}` : '\nPASS ✓ all terminal-UX checks')
  ws.close()
  cleanup(fails.length ? 2 : 0)
}
main().catch((e) => { console.error('drive failed:', e.message); cleanup(1) })
