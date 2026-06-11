// CDP driver for the "+ Agent" agent launcher button (the UI path for spawn_agent).
// Clicks the toolbar "+ Agent" button and asserts a NEW chat surface (data-sid="chat-<id>") appears live
// over SSE — i.e. the renderer→shim→/api/os/agent-spawn→host broadcast path works end-to-end.
//   node scripts/drive-newchat.mjs [url]
// Delta-based: tolerates chat sessions left over from prior runs (asserts +1, never an absolute count).
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const url = process.argv[2] || 'https://agentos.blitzmen.com'
const [W, H] = [1600, 1000]
const bin = process.env.CHROMIUM || '/usr/bin/chromium'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = mkdtempSync(join(tmpdir(), 'blitz-newchat-'))

const child = spawn(bin, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  `--window-size=${W},${H}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch { /* gone */ } process.exit(code) }
const fails = []
const check = (cond, label) => { console.log((cond ? '  ✓ ' : '  ✗ ') + label); if (!cond) fails.push(label) }

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no DevTools ws')), 20000)
    child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(timer); resolve(m[0]) } })
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('chromium exited ' + c)) })
  })
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id
    const to = setTimeout(() => { if (pending.delete(i)) reject(new Error('CDP timeout: ' + method)) }, 15000)
    pending.set(i, { resolve: (v) => { clearTimeout(to); resolve(v) }, reject: (e) => { clearTimeout(to); reject(e) } })
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
  })
  ws.on('message', (d) => { let m; try { m = JSON.parse(d) } catch { return } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

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
  const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId); writeFileSync(`/tmp/newchat-${name}.png`, Buffer.from(data, 'base64')); console.log('  shot → /tmp/newchat-' + name + '.png') }

  await send('Page.navigate', { url }, sessionId)
  await delay(7000)

  const chatCount = () => evalJs(`return document.querySelectorAll('[data-sid="chat"],[data-sid^="chat-"]').length`)
  const chatIds = () => evalJs(`return Array.from(document.querySelectorAll('[data-sid="chat"],[data-sid^="chat-"]')).map(e=>e.getAttribute('data-sid')).sort()`)

  const before = await chatCount()
  console.log(`baseline chat surfaces: ${before}  (${JSON.stringify(await chatIds())})`)
  check(await evalJs(`return typeof window.agentOS?.spawnAgent === 'function'`), 'window.agentOS.spawnAgent is exposed')
  check(await evalJs(`return !!Array.from(document.querySelectorAll('.toolbar button')).find(b=>/\\+ Agent/.test(b.textContent||''))`), 'the "+ Agent" toolbar button is present')

  console.log('\n[click] + Agent button')
  await evalJs(`const b=Array.from(document.querySelectorAll('.toolbar button')).find(x=>/\\+ Agent/.test(x.textContent||'')); if(!b) throw new Error('button not found'); b.click(); return 1`)
  await delay(4500) // host mints id, writes meta, broadcasts create → new surface mounts

  const after = await chatCount()
  const ids = await chatIds()
  check(after === before + 1, `exactly one new chat surface after click (${before} → ${after})`)
  check(ids.some((s) => /^chat-\d+$/.test(s)), `a chat-<id> session surface exists (got ${JSON.stringify(ids)})`)
  await shot('after-click')

  // cleanup: close every non-primary agent this run spawned (closeAgent deletes its chat + files + area;
  // the primary 'chat'/agent '0' is never closable) so repeated runs leave the workspace as found.
  console.log('\n[cleanup] closing spawned agents')
  await evalJs(`const ids=Array.from(document.querySelectorAll('[data-sid^="chat-"]')).map(e=>e.getAttribute('data-sid').replace('chat-','')).filter(id=>id&&id!=='0'); for (const id of ids){ try{ window.agentOS.closeAgent(id) }catch{} } return ids.length`)
  await delay(1500)

  console.log(fails.length ? `\nFAIL ✗ ${fails.length}: ${fails.join(' | ')}` : '\nPASS ✓ "+ Agent" launcher works')
  ws.close()
  cleanup(fails.length ? 2 : 0)
}
main().catch((e) => { console.error('drive failed:', e.message); cleanup(1) })
