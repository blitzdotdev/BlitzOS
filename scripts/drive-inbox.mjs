// CDP driver for the Action-items inbox: resume on load (persisted pending items rebuild the inbox),
// the toolbar badge, ticking Done (resolve → SSE update + persist), choosing an option, and Clear.
//   node scripts/drive-inbox.mjs [pageUrl] [backendUrl]
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import http from 'node:http'

const pageUrl = process.argv[2] || 'http://127.0.0.1:5174'
const backend = process.argv[3] || 'http://127.0.0.1:8799'
const LOG = '/tmp/inbox-driver.log'
try { writeFileSync(LOG, '') } catch { /* ignore */ }
const log = (s) => { try { appendFileSync(LOG, s + '\n') } catch { /* ignore */ } console.log(s) }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'blitz-inbox-'))
const fails = []
const check = (c, m) => { log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails.push(m) }

function post(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {}); const u = new URL(backend + path)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(b)) })
    req.on('error', () => resolve('')); req.write(data); req.end()
  })
}

const child = spawn(process.env.CHROMIUM || '/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=1600,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
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
  const send = (method, params = {}, sid, ms = 12000) => new Promise((resolve, reject) => {
    const i = ++id; const to = setTimeout(() => { if (pending.delete(i)) reject(new Error('CDP TIMEOUT ' + method)) }, ms)
    pending.set(i, { resolve: (v) => { clearTimeout(to); resolve(v) }, reject: (e) => { clearTimeout(to); reject(e) } })
    ws.send(JSON.stringify(sid ? { id: i, method, params, sessionId: sid } : { id: i, method, params }))
  })
  ws.on('message', (d) => { let m; try { m = JSON.parse(d) } catch { return } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId)
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200)); return r.result.value }
  const shot = async (n) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(`/tmp/inbox-${n}.png`, Buffer.from(data, 'base64')); log('  shot → /tmp/inbox-' + n + '.png') }

  log('navigate'); await send('Page.navigate', { url: pageUrl }, sessionId); await delay(6500)

  // 1. resume-on-load: the 2 persisted PENDING items rebuild the inbox
  log('\n[1] inbox reconstructs from persisted items on load')
  check(await ev(`return !!document.querySelector('.inbox-panel')`), 'inbox panel auto-appeared from persisted pending items')
  const titles = await ev(`return Array.from(document.querySelectorAll('.inbox-title')).map(e=>e.textContent)`)
  check(titles.includes('Sign in to GitHub') && titles.some(t=>/branch/.test(t)), `inbox shows the 2 seeded items (${JSON.stringify(titles)})`)
  const badge = await ev(`return (document.querySelector('.inbox-badge')||{}).textContent || '0'`)
  check(badge === '2', `toolbar badge shows 2 pending (got ${badge})`)
  const choiceBtns = await ev(`return document.querySelectorAll('.inbox-choice').length`)
  check(choiceBtns === 3, `the choose item renders its 3 choice buttons (got ${choiceBtns})`)
  await shot('1-loaded')

  // 2. tick Done on the signin item → resolves (SSE updates UI + persists)
  log('\n[2] tick Done on the sign-in item')
  await ev(`const it=Array.from(document.querySelectorAll('.inbox-item')).find(e=>/Sign in to GitHub/.test(e.textContent)); it.querySelector('.inbox-done-btn').click(); return 1`)
  await delay(1500)
  const resolvedShown = await ev(`const it=Array.from(document.querySelectorAll('.inbox-item')).find(e=>/Sign in to GitHub/.test(e.textContent)); return it && it.classList.contains('resolved')`)
  check(resolvedShown, 'sign-in item shows resolved in the UI (SSE action-item broadcast applied)')
  const badge2 = await ev(`return (document.querySelector('.inbox-badge')||{textContent:''}).textContent || '0'`)
  check(badge2 === '1', `badge drops to 1 (got ${badge2})`)
  await shot('2-after-done')

  // 3. pick a choice on the choose item
  log('\n[3] pick a branch on the choose item')
  await ev(`const bs=Array.from(document.querySelectorAll('.inbox-choice')); const b=bs.find(x=>x.textContent==='develop'); b.click(); return 1`)
  await delay(1500)
  const persisted = JSON.parse(await post('/api/os/action-list', {}))
  const chooseItem = persisted.actions.find(a => a.id === 'act-choose')
  check(chooseItem && chooseItem.status === 'done' && chooseItem.resolution === 'develop', `choose item persisted as done with resolution 'develop' (got ${JSON.stringify(chooseItem && {s:chooseItem.status, r:chooseItem.resolution})})`)
  const badge3 = await ev(`return (document.querySelector('.inbox-badge')||{textContent:''}).textContent || '0'`)
  check(badge3 === '0', `no pending left, badge gone (got '${badge3}')`)
  await shot('3-after-choose')

  // 4. Clear a resolved item → removed from the list
  log('\n[4] Clear a resolved item')
  const before = await ev(`return document.querySelectorAll('.inbox-item').length`)
  await ev(`const x=document.querySelector('.inbox-item.resolved .inbox-x'); x.click(); return 1`)
  await delay(1200)
  const after = await ev(`return document.querySelectorAll('.inbox-item').length`)
  check(after === before - 1, `Clear removed one item (${before} → ${after})`)
  await shot('4-after-clear')

  log(fails.length ? `\nFAIL ✗ ${fails.length}: ${fails.join(' | ')}` : '\nPASS ✓ all inbox checks')
  ws.close(); cleanup(fails.length ? 2 : 0)
}
main().catch((e) => { log('drive failed: ' + e.message); cleanup(1) })
