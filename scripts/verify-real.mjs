// Verify the REAL server-mode deployment (the page the user actually uses): does the Home workspace
// hydrate, is the canvas usable (no render-flood / main-thread block), are the new toolbar buttons there,
// and does a live session spawn produce a terminal tab — all in SERVER MODE on the real workspace.
//   node scripts/verify-real.mjs [pageUrl]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const url = process.argv[2] || 'http://127.0.0.1:5174'
const LOG = '/tmp/verify-real.log'
try { writeFileSync(LOG, '') } catch { /* ignore */ }
const log = (s) => { try { appendFileSync(LOG, s + '\n') } catch { /* ignore */ } console.log(s) }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'blitz-real-'))
const fails = []
const check = (c, m) => { log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails.push(m) }

const child = spawn(process.env.CHROMIUM || '/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=1600,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }
let consoleErrors = 0

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no ws')), 20000)
    child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]) } })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('chromium exited ' + c)) })
  })
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}, sid, ms = 10000) => new Promise((resolve, reject) => {
    const i = ++id; const to = setTimeout(() => { if (pending.delete(i)) reject(new Error('CDP TIMEOUT ' + method)) }, ms)
    pending.set(i, { resolve: (v) => { clearTimeout(to); resolve(v) }, reject: (e) => { clearTimeout(to); reject(e) } })
    ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params }))
  })
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d) } catch { return }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') consoleErrors++
    else if (m.method === 'Runtime.exceptionThrown') log('  ⚠ EXCEPTION: ' + JSON.stringify(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || '').slice(0, 200))
  })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId)
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${e}})()`, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value }
  const shot = async (n) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(`/tmp/verify-${n}.png`, Buffer.from(data, 'base64')); log('  shot → /tmp/verify-' + n + '.png') }

  log('navigate ' + url)
  await send('Page.navigate', { url }, sessionId)
  await delay(7000) // server-mode SSE connect + hydrate of Home

  log('\n[1] page loads, hydrates Home, and is RESPONSIVE (no render-flood / main-thread block)')
  check(await ev(`return !!(window.agentOS && window.agentOS.serverMode)`), 'window.agentOS present in server mode')
  const ws1 = await ev(`return (document.querySelector('.ws-name')||{}).textContent || ''`)
  check(/Home/.test(ws1), `toolbar shows the Home workspace (got '${ws1}')`)
  const surfaces = await ev(`return document.querySelectorAll('.window, .file-tile, .dir-tile').length`)
  check(surfaces > 0, `Home surfaces hydrated onto the canvas (${surfaces} rendered)`)
  check(consoleErrors < 50, `no render-flood: console error count is sane (${consoleErrors}) — the duplicate-key hang would be in the thousands`)
  await shot('1-home')

  log('\n[2] toolbar affordances present (+ Terminal / + Agent / Go to chat / Terminals & Agents / Inbox)')
  const btns = await ev(`return Array.from(document.querySelectorAll('.toolbar button')).map(b=>(b.textContent||'').replace(/\\s+/g,' ').trim())`)
  check(btns.some(b=>/\+ Terminal/.test(b)), '+ Terminal button')
  check(btns.some(b=>/\+ Agent/.test(b)), '+ Agent button')
  check(btns.some(b=>/Go to chat/.test(b)), 'Go to chat button')
  check(btns.some(b=>/Terminals & Agents/.test(b)), 'Terminals & Agents tray button')
  check(btns.some(b=>/Inbox/.test(b)), 'Inbox button')

  log('\n[3] a live session spawn works in server mode on Home (the real tmux path)')
  const before = await ev(`return document.querySelectorAll('.window-tabs .wtab').length`)
  await ev(`window.agentOS.terminalSpawn({command:'bash', title:'verify-shell'}); return 1`)
  await delay(3500)
  const after = await ev(`return document.querySelectorAll('.window-tabs .wtab').length`)
  check(after === before + 1, `spawning a session adds a terminal tab (${before} → ${after})`)
  // clean up the verify session so we don't leave junk in Home
  const sid = await ev(`const ss = await window.agentOS.terminalList(); const s = ss.find(x=>x.title==='verify-shell' && x.status==='running'); return s ? s.id : ''`)
  if (sid) { await ev(`window.agentOS.terminalRemove(${JSON.stringify(sid)}); return 1`); log('  (removed the verify-shell terminal)') }
  await shot('2-after-spawn')

  log(fails.length ? `\nFAIL ✗ ${fails.length}: ${fails.join(' | ')}` : '\nPASS ✓ real server-mode deployment is usable')
  ws.close(); cleanup(fails.length ? 2 : 0)
}
main().catch((e) => { log('verify failed: ' + e.message); cleanup(1) })
