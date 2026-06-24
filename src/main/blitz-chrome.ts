// BlitzOS "Blitz" Chrome — a SECOND, fully independent AI-browsing path that drives a dedicated Chrome over
// the DevTools Protocol via --remote-debugging-port, with NO extension and NO manual load step. This lives
// ALONGSIDE the extension/chrome.debugger path (ai-browser.ts + connection-tab-link.mjs); it does not replace
// or modify it. The extension path still earns its keep for attaching to the user's ALREADY-RUNNING real
// Chrome (which can't be given a debug port without relaunching it). This path is for a browser WE launch.
//
// Why a separate instance and not a profile in the user's Chrome: --remote-debugging-port is BROWSER-WIDE
// (it would expose every profile, including the user's logged-in one), can't be added to an already-running
// Chrome, and modern Chrome refuses it on the default user-data-dir. So the only no-extension, zero-touch,
// isolated option is a separate user-data-dir we own — branded as a "Blitz" profile (name + avatar) so it
// reads like a Blitz person in an otherwise-normal Chrome.
//
// Shape: a supervised Chrome process (own --user-data-dir, relaunch-on-death) + ONE main-process CDP client
// (the browser-level WebSocket). Each agent gets its own browser WINDOW (Target.createTarget newWindow), bound
// to a flattened CDP session. High-level ops (open/navigate/screenshot/read/act/status/close) ride that
// session: Page.navigate, Page.captureScreenshot, Runtime.evaluate (page content is read from the REAL DOM,
// not the AX tree), and TRUSTED Input.* (the same pipeline that drives Docs/Figma canvas). Accessibility is an
// explicit opt-in for canvas apps only. Exposed to agents as the blitz_chrome_* syscalls (os-tools.mjs).

import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'

const PROFILE_NAME = 'Blitz'
const PROFILE_AVATAR_INDEX = 26 // a built-in Chrome avatar (the "robot"/"ninja" set) — best-effort branding
const PORT_BASE = 9333
const PORT_SPAN = 12

// The Google Chrome binary. Overridable with BLITZ_AI_CHROME_BIN; falls back to Chrome / Canary / Chromium.
function findChromeBin(): string | null {
  const cands = [
    process.env.BLITZ_AI_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ].filter((p): p is string => !!p)
  for (const c of cands) if (existsSync(c)) return c
  return null
}

// Is a localhost TCP port free to bind? (We pick the debug port BEFORE launch so we know where to connect.)
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}
async function pickPort(): Promise<number> {
  for (let p = PORT_BASE; p < PORT_BASE + PORT_SPAN; p++) if (await portFree(p)) return p
  return PORT_BASE // last resort; the connect will surface the failure honestly
}

// A tiny GET against the DevTools HTTP endpoint (/json/version → the browser-level WebSocket url).
function getJSON(port: number, path: string, timeoutMs = 1500): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (r) => {
      let d = ''
      r.on('data', (c) => (d += c))
      r.on('end', () => {
        try {
          resolve(JSON.parse(d))
        } catch {
          resolve(d)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

interface AgentWindow {
  targetId: string
  sessionId: string
  ready: boolean
}

export interface BlitzChromeStatus {
  available: boolean
  running: boolean
  connected: boolean
  port: number | null
  profileDir: string
  windows: number
}

class BlitzChrome {
  private child: ChildProcess | null = null
  private supervise = false
  private wantQuit = false
  private port: number | null = null
  private profileDir = join(app.getPath('appData'), 'BlitzOS', 'blitz-chrome')
  private shotDir = join(app.getPath('temp'), 'blitz-chrome-shots')

  private ws: WebSocket | null = null
  private wsConnecting: Promise<void> | null = null
  private launching: Promise<{ ok: boolean; error?: string }> | null = null
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private readonly eventWaiters: Array<{ sessionId?: string; method: string; resolve: (o: Record<string, unknown>) => void }> = []
  private readonly windows = new Map<string, AgentWindow>() // agentId -> its window

  available(): boolean {
    return process.platform === 'darwin' && !!findChromeBin()
  }
  isRunning(): boolean {
    return !!this.child && this.child.exitCode == null && !this.child.killed
  }
  private isWsOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN
  }

  // ---- profile branding (best-effort): seed Default/Preferences + Local State so the UI shows "Blitz" ----
  private seedBranding(): void {
    try {
      const defDir = join(this.profileDir, 'Default')
      mkdirSync(defDir, { recursive: true })
      const prefs = join(defDir, 'Preferences')
      if (!existsSync(prefs)) {
        writeFileSync(
          prefs,
          JSON.stringify({ profile: { name: PROFILE_NAME, avatar_index: PROFILE_AVATAR_INDEX, using_default_name: false, using_default_avatar: false } })
        )
      }
      const localState = join(this.profileDir, 'Local State')
      if (!existsSync(localState)) {
        writeFileSync(
          localState,
          JSON.stringify({ profile: { info_cache: { Default: { name: PROFILE_NAME, avatar_icon: `chrome://theme/IDR_PROFILE_AVATAR_${PROFILE_AVATAR_INDEX}`, is_using_default_name: false, is_using_default_avatar: false } } } })
        )
      }
    } catch {
      /* branding is cosmetic; never block the launch on it */
    }
  }

  private launchArgs(port: number): string[] {
    return [
      `--user-data-dir=${this.profileDir}`,
      `--remote-debugging-port=${port}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*', // permit our localhost CDP client (Chrome M111+ checks the WS Origin)
      '--no-first-run',
      '--no-default-browser-check',
      '--silent-debugger-extension-api',
      '--no-default-browser-check',
      'about:blank'
    ]
  }

  /** Launch the Blitz Chrome if not running (idempotent, single-flight), then wait for its debug endpoint. */
  ensure(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'darwin') return Promise.resolve({ ok: false, error: 'the Blitz browser is macOS-only' })
    if (this.isRunning() && this.port) return Promise.resolve({ ok: true })
    if (this.launching) return this.launching
    this.launching = (async () => {
      const bin = findChromeBin()
      if (!bin) return { ok: false, error: 'Google Chrome is not installed (looked in /Applications)' }
      const firstRun = !existsSync(this.profileDir)
      try {
        mkdirSync(this.profileDir, { recursive: true })
        mkdirSync(this.shotDir, { recursive: true })
      } catch {
        /* best-effort; Chrome creates the profile dir too */
      }
      if (firstRun) this.seedBranding()
      const port = await pickPort()
      try {
        const child = spawn(bin, this.launchArgs(port), { detached: false, stdio: 'ignore' })
        this.child = child
        this.port = port
        this.supervise = true
        this.wantQuit = false
        child.on('exit', () => {
          if (this.child === child) {
            this.child = null
            this.port = null
            this.windows.clear()
            try {
              this.ws?.close()
            } catch {
              /* ignore */
            }
            this.ws = null
          }
          if (this.wantQuit) {
            this.wantQuit = false
            return
          }
          if (this.supervise) setTimeout(() => void this.ensure().catch(() => {}), 1200)
        })
        child.on('error', (e) => console.warn('[blitzos] Blitz Chrome spawn error:', (e as Error)?.message))
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
      // Wait for the DevTools endpoint to answer (Chrome takes a beat to bind it).
      for (let i = 0; i < 40; i++) {
        try {
          const v = (await getJSON(port, '/json/version')) as Record<string, unknown>
          if (v && v.webSocketDebuggerUrl) return { ok: true }
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      return { ok: false, error: 'Blitz Chrome launched but its debug endpoint never came up' }
    })()
    void this.launching.finally(() => {
      this.launching = null
    })
    return this.launching
  }

  /** Connect (or reuse) the single browser-level CDP socket. */
  private async connectBrowser(): Promise<void> {
    if (this.isWsOpen()) return
    if (this.wsConnecting) return this.wsConnecting
    this.wsConnecting = (async () => {
      const port = this.port
      if (!port) throw new Error('Blitz Chrome is not running')
      const ver = (await getJSON(port, '/json/version', 3000)) as Record<string, unknown>
      const url = ver && (ver.webSocketDebuggerUrl as string)
      if (!url) throw new Error('no browser webSocketDebuggerUrl from Chrome')
      const ws = new WebSocket(url, { origin: 'http://127.0.0.1', perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
      ws.on('message', (m: Buffer | string) => this.onMessage(String(m)))
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null
      })
      ws.on('error', () => {
        /* surfaced to callers via send timeouts/rejection */
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', (e: Error) => reject(e))
      })
      this.ws = ws
    })()
    try {
      await this.wsConnecting
    } finally {
      this.wsConnecting = null
    }
  }

  private onMessage(raw: string): void {
    let o: Record<string, unknown>
    try {
      o = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof o.id === 'number' && this.pending.has(o.id)) {
      const p = this.pending.get(o.id)!
      this.pending.delete(o.id)
      if (o.error) p.reject(new Error(JSON.stringify(o.error)))
      else p.resolve(o.result)
      return
    }
    if (typeof o.method === 'string') {
      for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
        const w = this.eventWaiters[i]
        if (w.method === o.method && (!w.sessionId || w.sessionId === o.sessionId)) {
          this.eventWaiters.splice(i, 1)
          w.resolve(o)
        }
      }
    }
  }

  private send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.isWsOpen()) return Promise.reject(new Error('Blitz Chrome CDP socket is not open'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out`))
      }, 20000)
      const done = (fn: (v: unknown) => void) => (v: unknown) => {
        clearTimeout(t)
        fn(v)
      }
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) as (e: Error) => void })
      this.ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  private waitEvent(method: string, sessionId: string, ms = 12000): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const w = { method, sessionId, resolve: (o: Record<string, unknown>) => resolve(o) }
      this.eventWaiters.push(w)
      setTimeout(() => {
        const i = this.eventWaiters.indexOf(w)
        if (i >= 0) {
          this.eventWaiters.splice(i, 1)
          resolve(null)
        }
      }, ms)
    })
  }

  // Ensure the browser is up + connected + this agent has an attached window. Returns its session.
  private async session(agentId: string): Promise<string> {
    const e = await this.ensure()
    if (!e.ok) throw new Error(e.error || 'could not launch Blitz Chrome')
    await this.connectBrowser()
    const key = agentId || 'default'
    const existing = this.windows.get(key)
    if (existing && existing.ready) return existing.sessionId
    const created = (await this.send('Target.createTarget', { url: 'about:blank', newWindow: true })) as { targetId: string }
    const attached = (await this.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })) as { sessionId: string }
    const sid = attached.sessionId
    await this.send('Page.enable', {}, sid)
    await this.send('Runtime.enable', {}, sid)
    await this.send('DOM.enable', {}, sid)
    await this.send('Accessibility.enable', {}, sid)
    this.windows.set(key, { targetId: created.targetId, sessionId: sid, ready: true })
    return sid
  }

  // ---- high-level ops (exposed as blitz_chrome_* tools) ----

  async open(agentId: string, opts: { url?: string } = {}): Promise<Record<string, unknown>> {
    if (!this.available()) return { error: 'the Blitz browser is available only on macOS with Google Chrome installed' }
    try {
      const sid = await this.session(agentId)
      if (opts.url) return await this.navigate(agentId, opts.url)
      const title = await this.evalString(sid, 'document.title')
      const url = await this.evalString(sid, 'location.href')
      return { ok: true, agent: agentId || 'default', port: this.port, url, title }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  async navigate(agentId: string, url: string): Promise<Record<string, unknown>> {
    if (!url) return { error: 'url required' }
    try {
      const sid = await this.session(agentId)
      const loaded = this.waitEvent('Page.loadEventFired', sid)
      await this.send('Page.navigate', { url }, sid)
      await loaded
      const title = await this.evalString(sid, 'document.title')
      const finalUrl = await this.evalString(sid, 'location.href')
      return { ok: true, effect: { url: finalUrl, title } }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  async screenshot(agentId: string, opts: { path?: string } = {}): Promise<Record<string, unknown>> {
    try {
      const sid = await this.session(agentId)
      const shot = (await this.send('Page.captureScreenshot', { format: 'png' }, sid)) as { data: string }
      const out = opts.path || join(this.shotDir, `shot-${(agentId || 'default').replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.png`)
      const buf = Buffer.from(shot.data, 'base64')
      writeFileSync(out, buf)
      return { ok: true, path: out, bytes: buf.length }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  async read(agentId: string, opts: { mode?: string; selector?: string; max?: number } = {}): Promise<Record<string, unknown>> {
    // Page content is read from the REAL DOM via injected JS (Runtime.evaluate) — NOT the accessibility tree.
    // 'text' (default) = visible innerText, 'html' = serialized DOM markup, 'title' = document.title.
    // 'ax' is kept only as an explicit opt-in for canvas apps (Docs/Figma) that have no meaningful DOM text.
    const mode = (opts.mode || 'text').toLowerCase()
    const max = Math.max(256, Math.min(Number(opts.max) || 12000, 200000))
    const sel = opts.selector ? JSON.stringify(opts.selector) : null
    const cap = (text: string): Record<string, unknown> => ({
      ok: true,
      mode,
      result: text.length > max ? text.slice(0, max) + `\n…(+${text.length - max} bytes)` : text
    })
    try {
      const sid = await this.session(agentId)
      if (mode === 'title') return { ok: true, mode, result: await this.evalString(sid, 'document.title') }
      if (mode === 'html') {
        const expr = sel
          ? `(()=>{const el=document.querySelector(${sel});return el?el.outerHTML:'(no match for selector)'})()`
          : '(document.documentElement?document.documentElement.outerHTML:"")'
        return cap(await this.evalString(sid, expr))
      }
      if (mode === 'ax') {
        // explicit opt-in: flatten the accessibility tree to name/role lines (for canvas apps with no DOM text)
        const ax = (await this.send('Accessibility.getFullAXTree', {}, sid)) as { nodes?: Array<Record<string, any>> }
        const lines: string[] = []
        for (const n of ax.nodes || []) {
          const role = n.role && n.role.value
          const name = n.name && n.name.value
          if (name || (role && role !== 'none' && role !== 'GenericContainer')) lines.push(`${role || '?'}: ${name || ''}`.trim())
        }
        return { ...cap(lines.join('\n')), nodes: (ax.nodes || []).length }
      }
      // default 'text': visible text straight from the DOM, scoped by selector when given
      const expr = sel
        ? `(()=>{const el=document.querySelector(${sel});return el?(el.innerText||el.textContent||''):'(no match for selector)'})()`
        : '(()=>{const el=document.body||document.documentElement;return el?(el.innerText||el.textContent||""):""})()'
      return cap(await this.evalString(sid, expr))
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  // Trusted Input.* — the pipeline that drives Docs/Figma canvas (synthetic JS events can't).
  async act(agentId: string, a: { action?: string; text?: string; key?: string; selector?: string; x?: number; y?: number } = {}): Promise<Record<string, unknown>> {
    const action = a.action || 'type'
    try {
      const sid = await this.session(agentId)
      if (action === 'type') {
        if (a.selector) await this.send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(a.selector)});if(el){el.focus();}return !!el})()`, returnByValue: true }, sid)
        const text = String(a.text ?? '')
        for (const ch of text) {
          if (ch === '\n') {
            await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
            await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sid)
          } else {
            await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch }, sid)
            await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sid)
          }
        }
        const active = await this.evalString(sid, 'document.activeElement && ("value" in document.activeElement) ? document.activeElement.value : (document.activeElement ? document.activeElement.tagName : "")')
        return { ok: true, effect: { typed: text, activeValue: active } }
      }
      if (action === 'key' || action === 'press') {
        const key = a.key || 'Enter'
        const codeMap: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39 }
        const vk = codeMap[key] || 0
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk }, sid)
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk }, sid)
        return { ok: true, effect: { key } }
      }
      if (action === 'click') {
        let x = a.x
        let y = a.y
        if ((x == null || y == null) && a.selector) {
          const pt = (await this.send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(a.selector)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`, returnByValue: true }, sid)) as { result?: { value?: { x: number; y: number } | null } }
          const v = pt.result && pt.result.value
          if (!v) return { error: `no element matched selector ${a.selector}` }
          x = v.x
          y = v.y
        }
        if (x == null || y == null) return { error: 'click needs {x,y} or {selector}' }
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sid)
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid)
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid)
        const url = await this.evalString(sid, 'location.href')
        return { ok: true, effect: { clicked: { x, y }, url } }
      }
      return { error: `unknown action '${action}' (use type | click | key)` }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  async status(agentId?: string): Promise<BlitzChromeStatus & { agentWindow?: boolean }> {
    return {
      available: this.available(),
      running: this.isRunning(),
      connected: this.isWsOpen(),
      port: this.port,
      profileDir: this.profileDir,
      windows: this.windows.size,
      ...(agentId != null ? { agentWindow: this.windows.has(agentId || 'default') } : {})
    }
  }

  async close(agentId?: string, opts: { quit?: boolean } = {}): Promise<Record<string, unknown>> {
    try {
      if (opts.quit) {
        this.shutdown()
        return { ok: true, quit: true }
      }
      const key = (agentId || 'default')
      const w = this.windows.get(key)
      if (!w) return { ok: true, closed: false }
      try {
        if (this.isWsOpen()) await this.send('Target.closeTarget', { targetId: w.targetId })
      } catch {
        /* the window may already be gone */
      }
      this.windows.delete(key)
      return { ok: true, closed: true }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  /** Quit the supervised Chrome (before-quit hook). */
  shutdown(): void {
    this.supervise = false
    this.wantQuit = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.windows.clear()
    try {
      this.child?.kill()
    } catch {
      /* ignore */
    }
    this.child = null
    this.port = null
  }

  private async evalString(sid: string, expression: string): Promise<string> {
    try {
      const r = (await this.send('Runtime.evaluate', { expression, returnByValue: true }, sid)) as { result?: { value?: unknown } }
      const v = r.result && r.result.value
      return v == null ? '' : String(v)
    } catch {
      return ''
    }
  }
}

let _instance: BlitzChrome | null = null
export function blitzChrome(): BlitzChrome {
  if (!_instance) _instance = new BlitzChrome()
  return _instance
}

// The ops bundle injected into electronOps (electron-os-tools.ts) so the blitz_chrome_* tool handlers resolve.
export const blitzChromeOps = {
  blitzChromeOpen: (agentId: string, opts?: { url?: string }) => blitzChrome().open(agentId, opts || {}),
  blitzChromeNavigate: (agentId: string, url: string) => blitzChrome().navigate(agentId, url),
  blitzChromeScreenshot: (agentId: string, opts?: { path?: string }) => blitzChrome().screenshot(agentId, opts || {}),
  blitzChromeRead: (agentId: string, opts?: { mode?: string; selector?: string; max?: number }) => blitzChrome().read(agentId, opts || {}),
  blitzChromeAct: (agentId: string, a?: { action?: string; text?: string; key?: string; selector?: string; x?: number; y?: number }) => blitzChrome().act(agentId, a || {}),
  blitzChromeStatus: (agentId?: string) => blitzChrome().status(agentId),
  blitzChromeClose: (agentId?: string, opts?: { quit?: boolean }) => blitzChrome().close(agentId, opts || {})
}
