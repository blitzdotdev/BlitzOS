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
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

// PERSISTENT profile: a fixed on-disk user-data-dir (NOT a per-run mkdtemp), so cookies +
// localStorage survive a restart and the user stays logged into Gmail/Discord/etc. once they
// sign in inside BlitzOS's browser. Keeps "blitz-chrome" in the path so start-all.sh's kill
// pattern still matches. Override with BLITZ_CHROME_PROFILE.
const PROFILE_DIR =
  process.env.BLITZ_CHROME_PROFILE || join(dirname(fileURLToPath(import.meta.url)), '..', '.blitz-chrome-profile')

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
 * screencast frame (already acked). `onNavigated(surfaceId, url)` is called on every
 * cross-document MAIN-frame navigation commit AFTER the surface's boot load (the host-side
 * nav sensor — the in-page one dies with the document). Returns surface lifecycle + a
 * `session(id)` that yields a control-core CdpSession for that surface.
 */
export async function startBrowserHost({ onFrame, onNavigated, chromiumPath } = {}) {
  const bin = chromiumPath || defaultChromium()
  // Reuse the persistent profile. Clear any stale singleton locks left by an unclean prior
  // exit (a SIGKILL leaves these behind and a fresh Chromium would refuse the profile).
  mkdirSync(PROFILE_DIR, { recursive: true })
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { rmSync(join(PROFILE_DIR, lock), { force: true }) } catch { /* ignore */ }
  }
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    // reduce automation fingerprinting so logins are less likely to be blocked
    '--disable-blink-features=AutomationControlled',
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE_DIR}`
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

  // Derive a clean desktop-Chrome UA from the live browser. The headless default carries a
  // "HeadlessChrome" token that UA-sniffing sites (e.g. WhatsApp Web) reject — they show
  // "update your browser" and never render the login QR. We swap that token for "Chrome" and
  // apply it per web surface (createSurface, below). Derived from Browser.getVersion so it
  // never rots when Chromium updates; if the query fails we just keep the default UA.
  let cleanUA = null
  let uaMeta = undefined
  try {
    const ver = await client.send('Browser.getVersion')
    const real = ver?.userAgent || ''
    if (real.includes('HeadlessChrome')) {
      cleanUA = real.replace('HeadlessChrome', 'Chrome')
      const full = (ver.product || '').match(/\/([\d.]+)/)?.[1] || ''
      const major = full.split('.')[0] || ''
      if (major) {
        // Keep navigator.userAgentData consistent with the spoofed string (some sniffers
        // also read client hints), so the surface doesn't read as headless either way.
        uaMeta = {
          brands: [
            { brand: 'Not)A;Brand', version: '8' },
            { brand: 'Chromium', version: major },
            { brand: 'Google Chrome', version: major }
          ],
          fullVersion: full,
          fullVersionList: [
            { brand: 'Not)A;Brand', version: '8.0.0.0' },
            { brand: 'Chromium', version: full },
            { brand: 'Google Chrome', version: full }
          ],
          platform: 'Linux',
          platformVersion: '',
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
          wow64: false
        }
      }
    }
  } catch {
    /* non-fatal: surfaces keep the default UA */
  }

  const surfaces = new Map() // surfaceId -> { targetId, sessionId, browserContextId }
  const sessionToSurface = new Map() // target sessionId -> surfaceId

  client.onEvent(async (m) => {
    if (m.method === 'Page.frameNavigated' && m.sessionId) {
      // Cross-document commit on the MAIN frame (subframes carry parentId). The in-page sensor can
      // never report these — the navigation destroys the page (and its undrained signal buffer) and
      // the re-injected sensor initializes to the new URL — so the host is the nav authority. SPA
      // route changes (Page.navigatedWithinDocument) stay with the in-page href poll: no double-
      // count. Skip each surface's boot navigation (the createSurface/initial-url load; for an
      // about:blank boot, the first real load that gives the surface its content counts as boot):
      // only subsequent navigations are user/agent moves.
      const f = m.params && m.params.frame
      if (f && !f.parentId && f.url !== 'about:blank') {
        const sid = sessionToSurface.get(m.sessionId)
        const s = sid ? surfaces.get(sid) : null
        if (s) {
          if (!s.sawBootNav) s.sawBootNav = true
          else if (onNavigated) {
            try {
              onNavigated(sid, f.url)
            } catch {
              /* listener error must not kill the CDP dispatcher */
            }
          }
        }
      }
    }
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
    /** Create a live web surface: a top-level page in the DEFAULT (persisted) browser
     *  context + screencast. Default context (no createBrowserContext) is what writes
     *  cookies/localStorage to the on-disk profile, so logins survive a restart — a
     *  CDP-created BrowserContext is always incognito/in-memory and would log out. All
     *  surfaces share the one profile, which is exactly what "log in once" needs. */
    async createSurface(surfaceId, { url, width = 1280, height = 800, quality = 70 } = {}) {
      // No width/height on createTarget: the default (persisted) context rejects window
      // sizing ("only for new windows"). Size the render viewport via Emulation instead.
      // Open about:blank first so the UA override is installed BEFORE the real URL loads —
      // otherwise the first navigation (e.g. WhatsApp's browser sniff) sees HeadlessChrome.
      const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
      sessionToSurface.set(sessionId, surfaceId)
      surfaces.set(surfaceId, { targetId, sessionId, width, height, quality })
      await client.send('Page.enable', {}, sessionId)
      if (cleanUA) {
        try {
          await client.send('Network.setUserAgentOverride', { userAgent: cleanUA, userAgentMetadata: uaMeta }, sessionId)
        } catch {
          /* non-fatal: keep the default UA */
        }
      }
      try {
        await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
      } catch {
        /* non-fatal: screencast max bounds still constrain the frame */
      }
      await client.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: width, maxHeight: height, everyNthFrame: 1 }, sessionId)
      if (url) {
        try {
          await client.send('Page.navigate', { url }, sessionId)
        } catch {
          /* navigation failures surface on the page itself */
        }
      }
      return { targetId, sessionId }
    },
    async closeSurface(surfaceId) {
      const s = surfaces.get(surfaceId)
      if (!s) return
      // Cancel any pending debounced resize so its timer can't fire CDP at this now-closed session.
      if (s.resizeTimer) { clearTimeout(s.resizeTimer); s.resizeTimer = null }
      sessionToSurface.delete(s.sessionId)
      surfaces.delete(surfaceId)
      try {
        await client.send('Target.closeTarget', { targetId: s.targetId })
      } catch {
        /* ignore */
      }
      // No disposeBrowserContext: surfaces live in the shared default (persisted) context.
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
    ids() {
      return [...surfaces.keys()]
    },
    async navigate(surfaceId, url) {
      const s = surfaces.get(surfaceId)
      if (!s) throw new Error(`no server surface "${surfaceId}"`)
      return client.send('Page.navigate', { url }, s.sessionId)
    },
    /** Resize the render viewport + restart the screencast at the new size (debounced 140ms so a
     *  drag-resize coalesces) — audit major #4: the viewport/screencast are pinned at create, so
     *  without this the streamed frame stretches the old aspect ratio when the window is resized. */
    async resize(surfaceId, width, height) {
      const s = surfaces.get(surfaceId)
      if (!s) return
      s.pendingW = Math.max(1, Math.round(width))
      s.pendingH = Math.max(1, Math.round(height))
      if (s.pendingW === s.width && s.pendingH === s.height) return
      if (s.resizeTimer) return // a debounce is already pending; it picks up the latest pendingW/H
      s.resizeTimer = setTimeout(async () => {
        s.resizeTimer = null
        const w = s.pendingW
        const h = s.pendingH
        if (w === s.width && h === s.height) return
        s.width = w
        s.height = h
        try {
          await client.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, s.sessionId)
          await client.send('Page.stopScreencast', {}, s.sessionId)
          await client.send('Page.startScreencast', { format: 'jpeg', quality: s.quality || 70, maxWidth: w, maxHeight: h, everyNthFrame: 1 }, s.sessionId)
        } catch {
          /* surface gone */
        }
      }, 140)
    },
    async stop() {
      // Some apps (Discord) deliberately keep their auth token in memory while running and
      // persist it ONLY from a real pagehide/unload handler (so an XSS can't read it at
      // rest). A plain close never captures it. So FIRST navigate every surface to
      // about:blank: that fires the page's unload (the app writes its session to
      // localStorage) WITHOUT rebooting the app (which would just read + re-clear the
      // token). Then Browser.close flushes it all to the persistent profile.
      try {
        const sessions = [...surfaces.values()]
        await Promise.all(
          sessions.map((s) => client.send('Page.navigate', { url: 'about:blank' }, s.sessionId).catch(() => {}))
        )
        if (sessions.length) await new Promise((r) => setTimeout(r, 800)) // let the unload writes land
      } catch {
        /* ignore */
      }
      // Graceful close flushes cookies/localStorage to the persistent profile, so a restart
      // keeps the user logged in. Browser.close starts the shutdown; we must WAIT for the
      // process to actually exit (that's when the flush completes) — SIGKILLing right after
      // the command reply would kill Chromium mid-flush and lose the session. Bounded so a
      // stuck browser can't hang shutdown.
      try {
        await client.send('Browser.close')
      } catch {
        /* already gone */
      }
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) return resolve()
        const t = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          resolve()
        }, 4000)
        child.on('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
      client.close()
    }
  }
}
