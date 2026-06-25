// CDP driver for the Action-items inbox: resume on load (persisted pending items rebuild the inbox),
// the toolbar badge, ticking Done (resolve → SSE update + persist), choosing an option, and Clear.
// SELF-CONTAINED: it resets the live inbox to empty, SEEDS two items via the relay `request_action`
// tool (a signin + a choose), runs the checks, then resets again so Home is left clean — like the other
// drive-*.mjs. (The inbox holds transient asks, so reset-to-empty is the clean baseline, mirroring how
// drive-terminals removes all terminals.)
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

// Drive an agent-socket tool ($BASE/<tool>) the way a connected agent would — used to SEED items via the
// real request_action path (so this exercises the agent→inbox contract, not a backdoor).
async function relay(tool, body) {
  const r = await fetch(`${backend}/api/os/agent-url`).then((x) => x.json()).catch(() => ({}))
  const base = String(r.url || '').replace(/\/agents\.md$/, '')
  if (!base) throw new Error('no agent base (relay offline?)')
  return fetch(`${base}/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null)
}

async function listItems() {
  try { const r = JSON.parse(await post('/api/os/action-list', {})); return Array.isArray(r.actions) ? r.actions : [] } catch { return [] }
}
// Reset the inbox to empty: pending items can't be cleared (core rule), so dismiss-then-clear each.
async function resetInbox() {
  for (const it of await listItems()) {
    if (it.status === 'pending') await post('/api/os/action-resolve', { id: it.id, resolution: 'dismissed' })
    await post('/api/os/action-clear', { id: it.id })
  }
}

const child = spawn(process.env.CHROMIUM || '/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--window-size=1600,1000', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }

async function main() {
  // SEED FIRST (before the page loads), so check [1] exercises the resume/reconstruct path: the persisted
  // pending items must rebuild the inbox on load. Reset to a known-empty baseline, then seed exactly two.
  log('seed: reset inbox to empty, then request_action × 2 (signin + choose) via the relay')
  await resetInbox()
  await relay('request_action', { title: 'Sign in to GitHub', kind: 'signin', detail: 'Authorize the GitHub app so the agent can open PRs.' })
  await relay('request_action', { id: 'act-choose', title: 'Choose a branch to deploy', kind: 'choose', choices: ['main', 'develop', 'release/1.0'] })
  const seeded = await listItems()
  check(seeded.filter((i) => i.status === 'pending').length === 2, `2 pending items seeded (got ${seeded.length})`)

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

  log('navigate'); await send('Page.navigate', { url: pageUrl }, sessionId)

  // 1. resume-on-load: the 2 persisted PENDING items rebuild the inbox. POLL until settled (~16s) instead of a
  // fixed delay — the inbox arrives either in the hydrate (host reconciles its items from the store) or a few
  // seconds later via the renderer's actionList reconstruct under the heavy sandwich renderer; a fixed wait
  // raced it. The host now makes the inbox AUTHORITATIVE from the store, so it shows EXACTLY the 2 seeded items.
  let titles = []
  for (let i = 0; i < 32; i++) {
    await delay(500)
    titles = await ev(`return Array.from(document.querySelectorAll('.inbox-title')).map(e=>e.textContent)`)
    if (titles.length >= 2) break
  }
  log('\n[1] inbox reconstructs from persisted items on load')
  check(await ev(`return !!document.querySelector('.inbox-panel')`), 'inbox panel auto-appeared from persisted pending items')
  check(titles.length === 2 && titles.includes('Sign in to GitHub') && titles.some(t=>/branch/.test(t)), `inbox shows EXACTLY the 2 seeded items (${JSON.stringify(titles)})`)
  const badge = await ev(`return (document.querySelector('.inbox-badge')||{}).textContent || '0'`)
  check(badge === '2', `toolbar badge shows 2 pending (got ${badge})`)
  const choiceBtns = await ev(`return document.querySelectorAll('.inbox-choice').length`)
  check(choiceBtns === 3, `the choose item renders its 3 choice buttons (got ${choiceBtns})`)
  await shot('1-loaded')

  // 2. tick Done on the signin item → resolves (SSE updates UI + persists). Poll until the resolve round-trip
  // (click → action-resolve → SSE action-item → DOM) lands, instead of a fixed delay that can race it.
  log('\n[2] tick Done on the sign-in item')
  await ev(`const it=Array.from(document.querySelectorAll('.inbox-item')).find(e=>/Sign in to GitHub/.test(e.textContent)); it.querySelector('.inbox-done-btn').click(); return 1`)
  let resolvedShown = false, badge2 = '0'
  for (let i = 0; i < 16; i++) {
    await delay(500)
    resolvedShown = await ev(`const it=Array.from(document.querySelectorAll('.inbox-item')).find(e=>/Sign in to GitHub/.test(e.textContent)); return !!(it && it.classList.contains('resolved'))`)
    badge2 = await ev(`return (document.querySelector('.inbox-badge')||{textContent:''}).textContent || '0'`)
    if (resolvedShown && badge2 === '1') break
  }
  check(resolvedShown, 'sign-in item shows resolved in the UI (SSE action-item broadcast applied)')
  check(badge2 === '1', `badge drops to 1 (got ${badge2})`)
  await shot('2-after-done')

  // 3. pick a choice on the choose item
  log('\n[3] pick a branch on the choose item')
  await ev(`const bs=Array.from(document.querySelectorAll('.inbox-choice')); const b=bs.find(x=>x.textContent==='develop'); b.click(); return 1`)
  let chooseItem = null, badge3 = '9'
  for (let i = 0; i < 16; i++) {
    await delay(500)
    chooseItem = (JSON.parse(await post('/api/os/action-list', {})).actions || []).find(a => a.id === 'act-choose')
    badge3 = await ev(`return (document.querySelector('.inbox-badge')||{textContent:''}).textContent || '0'`)
    if (chooseItem && chooseItem.status === 'done' && badge3 === '0') break
  }
  check(chooseItem && chooseItem.status === 'done' && chooseItem.resolution === 'develop', `choose item persisted as done with resolution 'develop' (got ${JSON.stringify(chooseItem && {s:chooseItem.status, r:chooseItem.resolution})})`)
  check(badge3 === '0', `no pending left, badge gone (got '${badge3}')`)
  await shot('3-after-choose')

  // 4. Clear a resolved item → removed from the list. Poll until the clear round-trip lands.
  log('\n[4] Clear a resolved item')
  const before = await ev(`return document.querySelectorAll('.inbox-item').length`)
  await ev(`const x=document.querySelector('.inbox-item.resolved .inbox-x'); x.click(); return 1`)
  let after = before
  for (let i = 0; i < 16; i++) {
    await delay(500)
    after = await ev(`return document.querySelectorAll('.inbox-item').length`)
    if (after === before - 1) break
  }
  check(after === before - 1, `Clear removed one item (${before} → ${after})`)
  await shot('4-after-clear')

  // cleanup: leave Home's inbox exactly as a fresh board — empty.
  log('\n[cleanup] resetting inbox to empty')
  await resetInbox()
  const left = (await listItems()).length
  check(left === 0, `inbox left clean (got ${left} items)`)

  log(fails.length ? `\nFAIL ✗ ${fails.length}: ${fails.join(' | ')}` : '\nPASS ✓ all inbox checks')
  ws.close(); cleanup(fails.length ? 2 : 0)
}
main().catch((e) => { log('drive failed: ' + e.message); cleanup(1) })
