/**
 * Server-mode browser host: spawn a headless Chromium, talk CDP to it over its
 * DevTools WebSocket (flat targets, sessionId-routed), and expose per-surface
 * targets + a screencast pump. Each `web` surface = a real top-level page in the
 * server browser (so X-Frame-Options / frame-ancestors never apply), streamed to
 * the canvas. The SAME control-core.mjs vocabulary drives it (RemoteCdpSession).
 *
 * MVP scope: ONE browser process (one tenant). Multi-tenant = one process/container
 * per tenant — a BrowserContext is a cookie jar, not a security boundary.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// Minimal CDP client over the DevTools WS. Routes command replies by id and
// events to listeners; supports flat-target sessionId on both directions.
class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.handlers = new Set()
    this._open = new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (d) => this._msg(d))
  }
  ready() {
    return this._open
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id
    const msg = sessionId ? { id, method, params, sessionId } : { id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(msg))
    })
  }
  onEvent(cb) {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
  _msg(data) {
    let m
    try {
      m = JSON.parse(data)
    } catch {
      return
    }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error.message || JSON.stringify(m.error)))
      else p.resolve(m.result)
    } else if (m.method) {
      for (const h of this.handlers) h(m)
    }
  }
}

function defaultChromium() {
  return (
    process.env.CHROMIUM ||
    process.env.CHROME_BIN ||
    'chromium'
  )
}

/**
 * Launch the host. `onFrame(surfaceId, base64Jpeg, metadata)` is called for every
 * screencast frame (already acked). Returns surface lifecycle + a `session(id)`
 * that yields a control-core CdpSession for that surface.
 */
export async function startBrowserHost({ onFrame, chromiumPath } = {}) {
  const bin = chromiumPath || defaultChromium()
  const userDataDir = mkdtempSync(join(tmpdir(), 'blitz-chrome-'))
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`
  ]
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for DevTools ws\n' + stderr.slice(-800))), 20000)
    child.stderr.on('data', (d) => {
      stderr += d
      const m = stderr.match(/ws:\/\/[^\s]+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`chromium exited (${code})\n` + stderr.slice(-800)))
    })
  })

  const client = new CdpClient(wsUrl)
  await client.ready()

  const surfaces = new Map() // surfaceId -> { targetId, sessionId, browserContextId }
  const sessionToSurface = new Map() // target sessionId -> surfaceId

  client.onEvent(async (m) => {
    if (m.method === 'Page.screencastFrame' && m.sessionId) {
      // ACK FIRST — Chrome stops producing frames after kMaxScreencastFramesInFlight (2)
      // until acked; skipping this freezes the stream (not a crash).
      try {
        await client.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }, m.sessionId)
      } catch {
        /* target gone */
      }
      const sid = sessionToSurface.get(m.sessionId)
      if (sid && onFrame) onFrame(sid, m.params.data, m.params.metadata)
    }
  })

  return {
    /** Create a live web surface: top-level target + per-surface cookie jar + screencast. */
    async createSurface(surfaceId, { url, width = 1280, height = 800, quality = 70 } = {}) {
      const { browserContextId } = await client.send('Target.createBrowserContext', { disposeOnDetach: false })
      const { targetId } = await client.send('Target.createTarget', { url: url || 'about:blank', browserContextId, width, height })
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
      sessionToSurface.set(sessionId, surfaceId)
      surfaces.set(surfaceId, { targetId, sessionId, browserContextId })
      await client.send('Page.enable', {}, sessionId)
      await client.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 }, sessionId)
      return { targetId, sessionId, browserContextId }
    },
    async closeSurface(surfaceId) {
      const s = surfaces.get(surfaceId)
      if (!s) return
      sessionToSurface.delete(s.sessionId)
      surfaces.delete(surfaceId)
      try {
        await client.send('Target.closeTarget', { targetId: s.targetId })
      } catch {
        /* ignore */
      }
      try {
        await client.send('Target.disposeBrowserContext', { browserContextId: s.browserContextId })
      } catch {
        /* ignore */
      }
    },
    /** A control-core CdpSession bound to this surface's target. */
    session(surfaceId) {
      const s = surfaces.get(surfaceId)
      if (!s) throw new Error(`no server surface "${surfaceId}"`)
      return { send: (method, params) => client.send(method, params, s.sessionId) }
    },
    has(surfaceId) {
      return surfaces.has(surfaceId)
    },
    async navigate(surfaceId, url) {
      const s = surfaces.get(surfaceId)
      if (!s) throw new Error(`no server surface "${surfaceId}"`)
      return client.send('Page.navigate', { url }, s.sessionId)
    },
    async stop() {
      client.close()
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }
}
