// BlitzOS "Blitz" Chrome — the agent's own AI-browsing path: a dedicated Chrome WE launch, driven over the
// DevTools Protocol via --remote-debugging-port, with NO extension and NO manual load step. It is separate
// from the user's OWN browser, which the agent reaches extension-free via Apple Events (Chrome/Safari tabs —
// connection-chrome-applescript-link / connection-safari-link). Blitz Chrome is for a browser WE launch; the
// Apple-Events path is for the user's ALREADY-RUNNING real browser (which can't be given a debug port without
// relaunching it).
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
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { WebSocket } from 'ws'
import { computerUseHelper } from './computer-use-helper'
// We register each opened window as a FIRST-CLASS connection through these ops, so the whole connection_* toolset
// (run_js / read / act / navigate / save_tool / registry / call_tool) drives it — no parallel API, no extension.
import type { ConnectionOps, ConnectionAdapter } from './connection-ops.d.mts'

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

// Resolve the PID listening on our debug port = the real Chrome browser process. We launch via `open` (so Chrome
// never activates), but `open`'s own PID exits immediately and is NOT Chrome's, so we look Chrome's pid up by the
// unique debug port for a reliable, orphan-free quit (the synchronous before-quit can't await a CDP Browser.close).
function resolvePidOnPort(port: number): number | null {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 2000 }).trim()
    const pid = parseInt(out.split('\n')[0] || '', 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null // best-effort backstop; the tool-path Browser.close still gives a graceful quit
  }
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
  connId?: string // the registry connection this window is bound to (so connection_* drives it)
}

// A page url → its source identity (host), the per-source key the registry's banked tools are keyed on.
function hostOf(url: string): string {
  try {
    return new URL(url).host || 'blitz-chrome'
  } catch {
    return 'blitz-chrome'
  }
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
  private alive = false // liveness is re-based on the CDP debug endpoint (we launch via `open`, whose pid isn't Chrome's)
  private chromePid: number | null = null // Chrome's REAL pid (resolved from the debug port) for a reliable quit
  private monitorTimer: NodeJS.Timeout | null = null // backstop liveness poll while a window/ws may not yet exist
  private livenessMisses = 0 // consecutive failed pings; debounced so a transient hiccup never false-kills the browser
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
  // The LAUNCH tab (the about:blank Chrome opens) — captured once at connect so the FIRST agent reuses THAT specific
  // window instead of spawning a new one or adopting a tab the user later opens. Single-use: cleared the instant it is
  // claimed (so a concurrent acquire spawns a fresh window instead) or when it is closed.
  private launchTargetId: string | null = null
  // Per-agent single-flight for window acquisition, so two concurrent session() calls for one agent never make two windows.
  private readonly sessionInFlight = new Map<string, Promise<string>>()
  private readonly windows = new Map<string, AgentWindow>() // agentId -> its window
  private connectionOps: ConnectionOps | null = null

  /** Wire the connection registry (index.ts) so an opened window registers as a first-class connection. */
  setConnectionOps(ops: ConnectionOps): void {
    this.connectionOps = ops
  }

  available(): boolean {
    return process.platform === 'darwin' && !!findChromeBin()
  }
  isRunning(): boolean {
    return this.alive
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
        // PRIMARY FOCUS FIX: launch NON-ACTIVATING via LaunchServices `open -g`, so the Blitz Chrome app never comes
        // to the foreground. Spawning the binary directly makes the GUI app activate (become frontmost) → it steals
        // the user's keyboard/window focus. CDP Input.* drives an unfocused window fine, so background launch is all
        // we need.   -g = open in the background (the key flag)   -n = a distinct instance (--user-data-dir isolates it)
        // Trade-off: `open` is a launcher whose own pid exits immediately and is NOT Chrome's, so liveness, self-heal
        // and shutdown are re-based on the CDP debug endpoint below (this.alive + the monitor + ws 'close'), never on
        // a child handle.
        const appBundle = bin.replace(/\/Contents\/MacOS\/[^/]+$/, '') // → /Applications/Google Chrome.app
        spawn('open', ['-g', '-n', '-a', appBundle, '--args', ...this.launchArgs(port)], { stdio: 'ignore' }).on('error', (e) =>
          console.warn('[blitzos] Blitz Chrome launch error:', (e as Error)?.message)
        )
        this.port = port
        this.supervise = true
        this.wantQuit = false
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
      // Wait for the DevTools endpoint to answer (Chrome takes a beat to bind it).
      for (let i = 0; i < 40; i++) {
        try {
          const v = (await getJSON(port, '/json/version')) as Record<string, unknown>
          if (v && v.webSocketDebuggerUrl) {
            this.alive = true
            this.livenessMisses = 0
            this.chromePid = resolvePidOnPort(port) // Chrome's real pid → reliable, orphan-free quit
            this.startMonitor()
            return { ok: true }
          }
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
        if (this.ws === ws) {
          this.ws = null
          // The browser-level socket dropping = Chrome went away. With no child pid to watch, this is the PRIMARY
          // death signal — route it through handleDeath (idempotent; self-heals when supervised).
          this.handleDeath()
        }
      })
      ws.on('error', () => {
        /* surfaced to callers via send timeouts/rejection */
      })
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', (e: Error) => reject(e))
      })
      this.ws = ws
      // Discover target lifecycle so a window the user closes (Target.targetDestroyed) unbinds its connection.
      try {
        await this.send('Target.setDiscoverTargets', { discover: true })
      } catch {
        /* non-fatal: lifecycle unbinds still happen via close()/shutdown */
      }
      // Capture the LAUNCH tab now — right after connect, before any agent acts or the user opens a tab — so the
      // first agent reuses exactly that window. Only ever this one id is reusable, so a user-opened blank is never hijacked.
      try {
        const got = (await this.send('Target.getTargets', {})) as { targetInfos?: Array<{ targetId: string; type: string }> }
        const page = (got.targetInfos || []).find((t) => t.type === 'page')
        this.launchTargetId = page ? page.targetId : null
      } catch {
        this.launchTargetId = null
      }
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
      // Persistent (not one-shot) bridges to the connection registry, so a bound window's connection tracks the page.
      if (o.method === 'Page.frameNavigated') this.onMainFrameNav(typeof o.sessionId === 'string' ? o.sessionId : undefined, o.params as Record<string, unknown> | undefined)
      else if (o.method === 'Target.targetDestroyed') this.onTargetGone((o.params as { targetId?: string } | undefined)?.targetId)
    }
  }

  // A bound window navigated its MAIN frame → re-key the connection's sourceId to the new host (so per-source banked
  // tools track the page it's actually on, never the prior site's), and wake the agent via
  // connectionRekey/connectionNotify.
  private onMainFrameNav(sessionId: string | undefined, params: Record<string, unknown> | undefined): void {
    if (!sessionId || !params || !this.connectionOps) return
    const frame = params.frame as { url?: string; parentId?: string } | undefined
    if (!frame || frame.parentId) return // main frame only (subframe navs aren't the source identity)
    let win: AgentWindow | undefined
    for (const w of this.windows.values()) if (w.sessionId === sessionId) { win = w; break }
    if (!win || !win.connId) return
    const r = this.connectionOps.connectionRekey(win.connId, hostOf(String(frame.url || '')))
    if (r && r.changed) return // the re-key emits its own moment
    this.connectionOps.connectionNotify(win.connId, { significant: true, summary: 'navigated' })
  }

  // A window's target was destroyed (the user closed it) → unbind its connection and forget the window.
  private onTargetGone(targetId: string | undefined): void {
    if (!targetId) return
    if (this.launchTargetId === targetId) this.launchTargetId = null // the launch tab was closed → never reuse it
    // Clear EVERY window bound to this target, not just the first: cleanup must be exhaustive so a destroyed target
    // can never leave a stale ready entry behind (which session() would then hand back as a dead session). Snapshot
    // before mutating the map.
    for (const [key, w] of [...this.windows]) {
      if (w.targetId !== targetId) continue
      if (w.connId && this.connectionOps) {
        try {
          this.connectionOps.connectionUnbind(w.connId)
        } catch {
          /* registry gone */
        }
      }
      this.windows.delete(key)
    }
  }

  // Unbind every bound window's connection (Chrome died / app quitting). Leaves window bookkeeping to the caller.
  private unbindAll(): void {
    if (!this.connectionOps) return
    for (const w of this.windows.values()) {
      if (w.connId) {
        try {
          this.connectionOps.connectionUnbind(w.connId)
        } catch {
          /* registry gone */
        }
      }
    }
  }

  // Chrome went away (ws 'close', or a liveness ping failed). The SINGLE death path now that we launch via `open`
  // (no child pid to hang an 'exit' handler on). Idempotent: tears down state once and self-heals when supervised.
  private handleDeath(): void {
    if (!this.alive) return // already torn down (shutdown, or a prior death) — never double-process or relaunch
    this.alive = false
    this.chromePid = null
    this.stopMonitor()
    this.port = null
    this.unbindAll()
    this.windows.clear()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    if (this.wantQuit) {
      this.wantQuit = false
      return
    }
    if (this.supervise) setTimeout(() => void this.ensure().catch(() => {}), 1200) // keep the existing relaunch backoff
  }

  // Backstop liveness poll. The ws 'close' event is the fast death signal, but before the first window opens there
  // is no socket, so a ~2s /json/version ping catches a Chrome that died in that window too.
  private startMonitor(): void {
    if (this.monitorTimer) return
    this.monitorTimer = setInterval(() => void this.pingLiveness(), 2000)
    this.monitorTimer.unref?.() // never keep the app alive just for this timer
  }
  private stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer)
      this.monitorTimer = null
    }
  }
  private async pingLiveness(): Promise<void> {
    const port = this.port
    if (!this.alive || this.wantQuit || !port) return
    try {
      const v = (await getJSON(port, '/json/version', 2000)) as Record<string, unknown>
      if (v && v.webSocketDebuggerUrl) {
        this.livenessMisses = 0
        return // still up
      }
    } catch {
      /* fall through: endpoint didn't answer this round */
    }
    // Require two consecutive misses so a transient hiccup (GC pause, heavy load) never false-kills the user's
    // browser. The ws 'close' event is the immediate, definitive death signal; this poll only backstops it.
    if (++this.livenessMisses < 2) return
    this.livenessMisses = 0
    this.handleDeath()
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
    // Single-flight per agent: concurrent session() calls for the SAME key share ONE acquisition, never two windows.
    const inflight = this.sessionInFlight.get(key)
    if (inflight) return inflight
    const p = this.acquireWindow(key).finally(() => this.sessionInFlight.delete(key))
    this.sessionInFlight.set(key, p)
    return p
  }

  // Attach (or create) THIS agent's window. FOCUS INVARIANT: stay in the BACKGROUND — never Page.bringToFront /
  // Target.activateTarget here (CDP Input.* drives an unfocused window fine; foreground is opt-in via blitz_chrome_show).
  private async acquireWindow(key: string): Promise<string> {
    // Reuse the LAUNCH tab exactly once, so a single agent's work stays in the window Chrome already opened and that
    // tab is not orphaned. Read+null is synchronous = an atomic single-use claim: a concurrent acquire (a different
    // agent) sees null and createTargets instead, so two agents can NEVER adopt the same target. Only ever the launch
    // tab is reused, so a tab the user opened later is never hijacked.
    let targetId: string | null = this.launchTargetId
    this.launchTargetId = null
    if (targetId) {
      // Confirm the launch tab still exists as a page (the user may have closed it); else spawn a fresh window.
      const got = (await this.send('Target.getTargets', {}).catch(() => null)) as { targetInfos?: Array<{ targetId: string; type: string }> } | null
      if (!got || !(got.targetInfos || []).some((t) => t.targetId === targetId && t.type === 'page')) targetId = null
    }
    if (!targetId) {
      const created = (await this.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })) as { targetId: string }
      targetId = created.targetId
    }
    const attached = (await this.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    const sid = attached.sessionId
    await this.send('Page.enable', {}, sid)
    await this.send('Runtime.enable', {}, sid)
    await this.send('DOM.enable', {}, sid)
    await this.send('Accessibility.enable', {}, sid)
    this.windows.set(key, { targetId, sessionId: sid, ready: true })
    return sid
  }

  // ---- high-level ops (exposed as blitz_chrome_* tools) ----

  // Launch (if needed) THIS agent's extension-free Blitz Chrome window and register it as a first-class TAB
  // connection, so the agent drives it with the whole connection_* toolset (run_js / read / act / navigate /
  // save_tool / registry / call_tool). Returns the { connId } to drive — no parallel blitz_chrome_* driving API.
  async open(agentId: string, opts: { url?: string } = {}): Promise<Record<string, unknown>> {
    if (!this.available()) return { error: 'the Blitz browser is available only on macOS with Google Chrome installed' }
    try {
      const sid = await this.session(agentId)
      if (opts.url) {
        const nav = await this.navigate(agentId, opts.url)
        if (nav.error) return nav
      }
      const title = await this.evalString(sid, 'document.title')
      const url = await this.evalString(sid, 'location.href')
      const key = agentId || 'default'
      const w = this.windows.get(key)
      if (!w) return { ok: true, agent: key, port: this.port, url, title }
      if (this.connectionOps) {
        const live = !!w.connId && (typeof this.connectionOps.connectionIsLive !== 'function' || this.connectionOps.connectionIsLive(w.connId))
        if (!live) {
          const bound = this.connectionOps.connectionBind({
            type: 'tab',
            sourceId: hostOf(url),
            title: title || 'Blitz Chrome',
            capabilities: { run_js: true, act: true, cdp: true },
            adapter: this.buildAdapter(agentId),
            ref: w.targetId,
            agentId: agentId || '',
            origin: 'blitz-chrome'
          })
          w.connId = bound.connId
        }
        return { ok: true, agent: key, port: this.port, connId: w.connId, sourceId: hostOf(url), url, title }
      }
      // connection registry not wired (headless/test transport) — fall back to the bare lifecycle result.
      return { ok: true, agent: key, port: this.port, url, title }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  // The CDP-backed connection adapter for an agent's window: the registry calls call(verb,args); we ride the
  // window's flattened CDP session. Return shapes MATCH the Apple-Events tab adapter so connection_run_js/read/
  // act/navigate behave identically whichever browser backs the tab.
  private buildAdapter(agentId: string): ConnectionAdapter {
    const key = agentId || 'default'
    return {
      call: async (verb: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        try {
          const sid = await this.session(agentId)
          if (verb === 'run_js') return await this.adapterRunJs(sid, args)
          if (verb === 'read') return await this.adapterRead(sid, args)
          if (verb === 'navigate') {
            const r = await this.navigate(agentId, String(args.url || ''))
            return r.error ? r : { effect: (r as { effect?: unknown }).effect }
          }
          if (verb === 'act') {
            const r = await this.act(agentId, args as { action?: string; text?: string; key?: string; selector?: string; x?: number; y?: number })
            return r.error ? r : { effect: (r as { effect?: unknown }).effect }
          }
          if (verb === 'cdp') return { result: await this.send(String(args.method || ''), (args.params as Record<string, unknown>) || {}, sid) }
          // OPT-IN reveal: connection_reveal brings THIS window to the foreground.
          if (verb === 'reveal') return await this.show(agentId)
          return { error: `the Blitz Chrome connection does not support '${verb}'` }
        } catch (e) {
          return { error: String((e as Error)?.message || e) }
        }
      },
      drop: () => {
        const w = this.windows.get(key)
        if (w) w.connId = undefined
      }
    }
  }

  // connection_read on a Blitz Chrome tab: DOM text/html (default), a screenshot, or the AX tree (opt-in for canvas).
  // Same return shapes as the extension's fnRead/cdpRead: { url, title, text, html? } | { png } | { text }.
  private async adapterRead(sid: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (args.screenshot) {
      const shot = (await this.send('Page.captureScreenshot', { format: 'png' }, sid)) as { data?: string }
      return { png: shot && shot.data }
    }
    if (args.ax) {
      const ax = (await this.send('Accessibility.getFullAXTree', {}, sid)) as { nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }> }
      const lines = (ax.nodes || [])
        .map((n) => {
          const role = (n.role && (n.role.value as string)) || ''
          const name = (n.name && (n.name.value as string)) || ''
          return name ? (role ? `${role}: ${name}` : name) : ''
        })
        .filter(Boolean)
      return { text: lines.join('\n').slice(0, Number(args.max) || 8000) }
    }
    const max = Number(args.max) || 8000
    const sel = args.selector ? JSON.stringify(String(args.selector)) : null
    const rootExpr = sel ? `document.querySelector(${sel})` : 'document.body'
    const htmlLine = args.html ? `out.html=(root.outerHTML||'').slice(0,${max});` : ''
    const expr = `(()=>{const root=${rootExpr};if(!root)return {error:'no match for selector '+${sel || '""'}};const out={url:location.href,title:document.title,text:(root.innerText||'').slice(0,${max})};${htmlLine}return out})()`
    const r = (await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid)) as { result?: { value?: unknown } }
    const v = r.result && r.result.value
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { url: '', title: '', text: String(v ?? '') }
  }

  // connection_run_js on a Blitz Chrome tab: run the agent's code as a (args)=>{…} body, return-by-value, awaiting a
  // returned promise. Matches the extension's runUserScript contract: { result } on success, { error } on a throw.
  private async adapterRunJs(sid: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const code = String(args.code || '')
    const callArgs = JSON.stringify(args.args || {})
    const expr = `(function(args){\n${code}\n})(${callArgs})`
    const r = (await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)) as {
      result?: { value?: unknown }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }
    if (r.exceptionDetails) return { error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'run_js threw') }
    const v = r.result ? r.result.value : undefined
    return { result: v === undefined ? null : v }
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
      if (action === 'set') {
        if (!a.selector) return { error: 'set needs {selector}' }
        const sel = JSON.stringify(a.selector)
        const val = JSON.stringify(String(a.text ?? ''))
        // Set the field's value through the native setter (so React/controlled inputs see it) + fire input/change.
        const r = (await this.send(
          'Runtime.evaluate',
          {
            expression: `(()=>{const el=document.querySelector(${sel});if(!el)return null;el.focus&&el.focus();const d=Object.getOwnPropertyDescriptor(el.__proto__||{},'value');if(d&&d.set){d.set.call(el,${val})}else{el.value=${val}}el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return ('value' in el)?el.value:(el.textContent||'')})()`,
            returnByValue: true
          },
          sid
        )) as { result?: { value?: unknown } }
        const v = r.result && r.result.value
        if (v == null) return { error: `no element matched selector ${a.selector}` }
        return { ok: true, effect: { set: String(v) } }
      }
      return { error: `unknown action '${action}' (use type | click | set | key)` }
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

  // OPT-IN, USER-INITIATED reveal ("bring the agent's window to me"). This is the ONE place Blitz Chrome may take
  // focus — never call it from session()/act()/open() or any automatic path. Exposed as the blitz_chrome_show tool.
  async show(agentId?: string): Promise<Record<string, unknown>> {
    if (!this.isRunning()) return { error: 'Blitz Chrome is not running' }
    try {
      const key = agentId || 'default'
      const w = this.windows.get(key)
      if (w && this.isWsOpen()) {
        try {
          await this.send('Target.activateTarget', { targetId: w.targetId }) // raise the right window inside Chrome
        } catch {
          /* best-effort */
        }
      }
      // Bring the Blitz Chrome process frontmost. Use the PID we resolved at launch so we target THIS Chrome
      // instance specifically — `open -a <bundle>` is ambiguous when the user's own Chrome is also open and
      // macOS would focus their window instead of ours.
      if (this.chromePid) {
        // Foreground Blitz Chrome via the helper's NSRunningApplication.activate (precise by pid, NO Automation
        // consent). NEVER spawn a direct `tell System Events to set frontmost` from Electron — that runs as BlitzOS
        // and raises a "control System Events" TCC prompt. If the helper isn't up yet, ensure it; if it still can't
        // run, SKIP foregrounding (it is cosmetic) rather than prompt.
        const pid = this.chromePid
        const helper = computerUseHelper()
        void (async () => {
          if (!helper.available()) return
          if (!helper.connected()) { try { await helper.ensure() } catch { return } }
          if (helper.connected()) helper.call('activate', { pid }).catch(() => {})
        })()
      } else {
        // PID not yet resolved (rare: CDP up but lsof hasn't run yet) — fall back to app-level activate.
        const bin = findChromeBin()
        if (bin) {
          const appBundle = bin.replace(/\/Contents\/MacOS\/[^/]+$/, '')
          spawn('open', ['-a', appBundle], { stdio: 'ignore' }).on('error', () => {})
        }
      }
      return { ok: true, shown: true, agentWindow: !!w }
    } catch (e) {
      return { error: String((e as Error)?.message || e) }
    }
  }

  async close(agentId?: string, opts: { quit?: boolean } = {}): Promise<Record<string, unknown>> {
    try {
      if (opts.quit) {
        // The tool path CAN await, so quit gracefully over CDP first (clean window teardown), then tear down state.
        try {
          if (this.isWsOpen()) await this.send('Browser.close')
        } catch {
          /* Chrome may already be gone */
        }
        this.shutdown()
        return { ok: true, quit: true }
      }
      const key = (agentId || 'default')
      const w = this.windows.get(key)
      if (!w) return { ok: true, closed: false }
      if (w.connId && this.connectionOps) {
        try {
          this.connectionOps.connectionUnbind(w.connId)
        } catch {
          /* registry gone */
        }
      }
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

  /** Quit the supervised Chrome (before-quit hook + the blitz_chrome_close quit path). Synchronous so the
   *  synchronous before-quit handler fully tears Chrome down — it can't await us. */
  shutdown(): void {
    this.supervise = false
    this.wantQuit = true
    this.alive = false
    this.stopMonitor()
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.unbindAll()
    this.windows.clear()
    // No child handle (we launched via `open`): SIGTERM the REAL Chrome we resolved at launch so a supervised
    // Chrome never orphans the app. This is the reliable backstop for the synchronous app-quit path (close()'s
    // quit branch already did a graceful CDP Browser.close before calling us).
    if (this.chromePid) {
      try {
        process.kill(this.chromePid)
      } catch {
        /* already gone */
      }
    }
    this.chromePid = null
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
// Only the LIFECYCLE is a blitz_chrome_* tool now (open returns a connId; status/close manage it). Driving the
// page — navigate / read / run_js / act / save_tool / registry / call_tool — is the unified connection_* toolset.
export const blitzChromeOps = {
  blitzChromeOpen: (agentId: string, opts?: { url?: string }) => blitzChrome().open(agentId, opts || {}),
  blitzChromeStatus: (agentId?: string) => blitzChrome().status(agentId),
  blitzChromeClose: (agentId?: string, opts?: { quit?: boolean }) => blitzChrome().close(agentId, opts || {}),
  blitzChromeShow: (agentId?: string) => blitzChrome().show(agentId)
}
