// CDP wall-clock screenshot — captures a page after a FIXED real-time delay, so it never hangs on a
// page that holds an SSE/WebSocket open (the --virtual-time-budget/--screenshot path stalls forever there
// because the page never reaches network-idle). Uses its OWN temp profile so it can't clash with the
// server's persistent browser-host chromium.
//
//   node scripts/shot.mjs <url> <out.png>     (env: WAIT_MS=9000, SIZE=1600x1000, CHROMIUM=/usr/bin/chromium)
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const url = process.argv[2] || 'http://127.0.0.1:5174'
const out = process.argv[3] || '/tmp/shot.png'
const waitMs = Number(process.env.WAIT_MS || 9000)
const [W, H] = (process.env.SIZE || '1600x1000').split('x').map(Number)
const bin = process.env.CHROMIUM || '/usr/bin/chromium'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'blitz-shot-'))
const child = spawn(
  bin,
  [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--window-size=${W},${H}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    'about:blank'
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
)

let stderr = ''
function cleanup(code) {
  try { child.kill('SIGKILL') } catch { /* gone */ }
  process.exit(code)
}

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no DevTools ws in 20s\n' + stderr.slice(-600))), 20000)
    child.stderr.on('data', (d) => {
      stderr += d
      const m = stderr.match(/ws:\/\/[^\s]+/)
      if (m) { clearTimeout(timer); resolve(m[0]) }
    })
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('chromium exited ' + c + '\n' + stderr.slice(-600))) })
  })

  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
    })
  ws.on('message', (d) => {
    let m
    try { m = JSON.parse(d) } catch { return }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId)
  await send('Page.navigate', { url }, sessionId)
  await delay(waitMs) // wall-clock — independent of network idle (SSE can't block this)
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log('wrote ' + out + ' (' + Buffer.from(data, 'base64').length + ' bytes)')
  ws.close()
  cleanup(0)
}

main().catch((e) => { console.error('shot failed:', e.message); cleanup(1) })
