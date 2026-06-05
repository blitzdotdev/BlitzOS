// Verify the BACKEND server-mode path end to end (headless): spawn the backend
// with BLITZ_SERVER_MODE=1, report a web surface via /api/os/state (as the renderer
// would), then connect /api/os/stream and confirm live JPEG frames arrive + raw CDP
// input is accepted. Proves reconcile → host.createSurface → screencast → WS fan-out.
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const PORT = 8799
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn('node', ['preview/backend.mjs'], {
  env: { ...process.env, BLITZ_SERVER_MODE: '1', BACKEND_PORT: String(PORT), CHROMIUM: process.env.CHROMIUM || '/usr/bin/chromium' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d })
child.stderr.on('data', (d) => { serverLog += d })

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('backend did not start\n' + serverLog.slice(-600))
}

let frames = 0
let frameBytes = 0
try {
  await waitHealth()
  console.log('[ok] backend up (server mode)')

  // Renderer would POST this when a web surface is created (agent or human).
  await fetch(`http://127.0.0.1:${PORT}/api/os/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ surfaces: [{ id: 'w1', kind: 'web', url: 'https://example.com', x: 0, y: 0, w: 1024, h: 768, title: 'ex' }] })
  })
  console.log('[ok] reported web surface w1 -> example.com (reconcile should spin up a target)')

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/os/stream`)
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  console.log('[ok] /api/os/stream connected')
  ws.on('message', (raw) => {
    let m
    try { m = JSON.parse(raw.toString()) } catch { return }
    if (m.t === 'frame' && m.id === 'w1') { frames++; if (frames === 1) frameBytes = Buffer.from(m.data, 'base64').length }
  })

  await sleep(4000) // let the target load + stream

  // human input → raw CDP passthrough (should not error)
  ws.send(JSON.stringify({ t: 'cdp', id: 'w1', method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 20, y: 20 } }))
  await sleep(300)

  console.log(`[frames] received=${frames} firstFrameJpegBytes=${frameBytes}`)
  ws.close()
} finally {
  child.kill()
}

const pass = frames > 0 && frameBytes > 500
console.log(pass ? '\n✅ BACKEND SERVER-MODE VERIFIED (live frames over the WS)' : '\n❌ no frames — see log:\n' + serverLog.slice(-800))
process.exit(pass ? 0 : 1)
