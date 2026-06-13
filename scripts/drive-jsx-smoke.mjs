// CDP smoke driver (shot.mjs pattern): load a fixture, poll #result until verdict/timeout,
// dump page console + #result. Usage: node drive-smoke.mjs <url> [timeoutMs]
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

const url = process.argv[2]
const limit = Number(process.argv[3] || 30000)
const bin = process.env.CHROMIUM || '/usr/bin/chromium'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'jsx-smoke-'))
const child = spawn(bin, [
  '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
  '--no-first-run', '--no-default-browser-check',
  '--window-size=900,600', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] })

let stderr = ''
function cleanup(code) { try { child.kill('SIGKILL') } catch {} process.exit(code) }

async function main() {
  const wsUrl = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no ws in 20s\n' + stderr.slice(-400))), 20000)
    child.stderr.on('data', (d) => { stderr += d; const m = stderr.match(/ws:\/\/[^\s]+/); if (m) { clearTimeout(t); resolve(m[0]) } })
    child.on('exit', (c) => { clearTimeout(t); reject(new Error('chromium exited ' + c)) })
  })
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify(sessionId ? { id: i, method, params, sessionId } : { id: i, method, params }))
  })
  const logs = []
  ws.on('message', (d) => {
    let m
    try { m = JSON.parse(d) } catch { return }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text))
  })
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Runtime.enable', {}, sessionId)
  await send('Page.navigate', { url }, sessionId)

  const t0 = Date.now()
  let text = ''
  while (Date.now() - t0 < limit) {
    await delay(800)
    const r = await send('Runtime.evaluate', { expression: "document.getElementById('result')?.textContent || ''", returnByValue: true }, sessionId)
    text = r.result?.value || ''
    if (/SMOKE_(PASS|FAIL)|\| done/.test(text)) break
  }
  console.log('RESULT: ' + text)
  if (logs.length) console.log('CONSOLE:\n' + logs.slice(-15).join('\n'))
  ws.close()
  cleanup(0)
}
main().catch((e) => { console.error('driver failed:', e.message); cleanup(1) })
