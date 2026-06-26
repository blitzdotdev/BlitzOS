// BlitzOS computer-use helper — lifecycle manager (plans/blitzos-computer-use-helper.md).
//
// Owns the separate native helper app that HOLDS the Accessibility + Screen
// Recording TCC grants, so BlitzOS never quits/reopens for them. The load-bearing trick: the helper
// is launched via LaunchServices (`open -n`), which makes it its OWN responsible process with its
// OWN TCC identity (dev.blitz.os.computeruse), distinct from BlitzOS/Electron. A child spawned by us
// would inherit OUR identity (exactly why the scan child inherits our FDA) and defeat the point.
//
// IPC is a Unix domain socket BlitzOS listens on (no inherited stdio across a LaunchServices launch);
// the helper connects on launch. Liveness = the socket connection. "Quit and reopen for the grant
// to take effect" = quit + relaunch THE HELPER; BlitzOS is untouched.

import { app } from 'electron'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export type DragPerm = 'accessibility' | 'screen' | 'fda'
export interface HelperTcc {
  accessibility: boolean
  screenRecording: boolean
  fullDisk: boolean
}
export interface ScanRequest {
  node: string
  script: string
  args: string[]
  env: Record<string, string>
}

// Where the SIGNED helper bundle ships: packaged → resourcesPath (electron-builder extraResources);
// dev → the build output. Resolution is robust: try several candidates and return the first that
// exists (app.getAppPath() can vary under electron-vite, so we also derive the repo root from
// __dirname = <repo>/out/main in dev). Overridable with BLITZ_COMPUTER_USE_APP.
let helperPathLogged = false
function bundledHelperApp(): string {
  const rel = ['native', 'computer-use-helper', 'build', 'BlitzOS Automation.app']
  const legacyRel = ['native', 'computer-use-helper', 'build', 'BlitzComputerUse.app']
  const here = (() => {
    try {
      return typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url))
    } catch {
      return ''
    }
  })()
  const candidates = [
    process.env.BLITZ_COMPUTER_USE_APP,
    app.isPackaged ? join(process.resourcesPath, 'BlitzOS Automation.app') : null,
    join(app.getAppPath(), ...rel),
    here ? join(here, '..', '..', ...rel) : null, // out/main → repo root in dev
    !app.isPackaged ? join(process.cwd(), ...rel) : null, // electron-vite dev runs with cwd = repo root
    app.isPackaged ? join(process.resourcesPath, 'BlitzComputerUse.app') : null,
    join(app.getAppPath(), ...legacyRel),
    here ? join(here, '..', '..', ...legacyRel) : null,
    !app.isPackaged ? join(process.cwd(), ...legacyRel) : null
  ].filter((p): p is string => !!p)
  for (const c of candidates) if (existsSync(c)) return c
  if (!helperPathLogged) {
    helperPathLogged = true
    console.error('[computer-use] helper bundle NOT found. candidates:', JSON.stringify(candidates))
  }
  return candidates[candidates.length - 1] ?? join(app.getAppPath(), ...rel)
}

// Stable install location (same in dev + packaged, independent of userData naming) so the bundle the
// user GRANTED stays put across app updates and never needs re-granting — Codex's installer pattern.
function installedHelperApp(): string {
  return join(app.getPath('appData'), 'BlitzOS', 'BlitzOS Automation.app')
}

// Older helper bundle names we may have installed before the rename to "BlitzOS Automation.app"
// (BlitzOS.app collided with the main app; BlitzComputerUse.app was the original). Removed after a
// successful install so a renamed upgrade leaves no orphan bundle behind.
function legacyInstalledHelperApps(): string[] {
  const dir = join(app.getPath('appData'), 'BlitzOS')
  return [join(dir, 'BlitzOS.app'), join(dir, 'BlitzComputerUse.app')]
}

function plistVersion(appPath: string): string | null {
  try {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    const m = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

const exec = (cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })))

class HelperManager {
  private server: net.Server | null = null
  private sock: net.Socket | null = null
  private sockPath = join(tmpdir(), `blitzcu-${process.pid}.sock`)
  private buf = ''
  private pending = new Map<number, (m: Record<string, unknown>) => void>()
  private scanProgress = new Map<number, (line: string) => void>()
  private eventHandlers = new Set<(m: Record<string, unknown>) => void>() // unsolicited helper events (ax_changed, pick_*) — MULTIPLE listeners
  private nextId = 1
  private hello: Record<string, unknown> | null = null
  private wantQuit = false // distinguishes a deliberate relaunch from a crash
  private connectWaiters: Array<() => void> = []
  private supervise = false
  private ensuring: Promise<{ ok: boolean; error?: string }> | null = null // single-flight ensure()

  /** Copy the signed bundle to the stable install location if missing or version-changed. cp -R
   *  (not fs.cp) preserves the code signature + symlinks the signature depends on. */
  private async install(): Promise<boolean> {
    const src = bundledHelperApp()
    if (!existsSync(src)) return false
    const dst = installedHelperApp()
    if (existsSync(dst) && plistVersion(dst) === plistVersion(src) && plistVersion(src) != null) return true
    try {
      mkdirSync(join(app.getPath('appData'), 'BlitzOS'), { recursive: true })
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
      const r = await exec('/bin/cp', ['-R', src, dst])
      if (r.ok) {
        for (const legacy of legacyInstalledHelperApps()) {
          try {
            if (legacy !== dst && existsSync(legacy)) rmSync(legacy, { recursive: true, force: true })
          } catch {
            /* best-effort legacy cleanup */
          }
        }
      }
      return r.ok && existsSync(dst)
    } catch {
      return false
    }
  }

  private ensureServer(): void {
    if (this.server) return
    try {
      rmSync(this.sockPath, { force: true })
    } catch {
      /* fresh */
    }
    this.server = net.createServer((s) => {
      this.sock = s
      this.buf = ''
      s.on('data', (d) => this.onData(d))
      s.on('close', () => this.onClose())
      s.on('error', () => {})
    })
    this.server.on('error', (e) => console.error('[computer-use] socket server error:', (e as Error)?.message))
    this.server.listen(this.sockPath)
  }

  private onData(d: Buffer): void {
    this.buf += d.toString('utf8')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'hello') {
        this.hello = msg
        const waiters = this.connectWaiters
        this.connectWaiters = []
        for (const w of waiters) w()
      } else if (msg.type === 'scan_progress' && typeof msg.id === 'number') {
        const h = this.scanProgress.get(msg.id)
        if (h && typeof msg.line === 'string') h(msg.line)
      } else if (msg.type === 'reply' && typeof msg.id === 'number') {
        const cb = this.pending.get(msg.id)
        if (cb) {
          this.pending.delete(msg.id)
          cb(msg)
        }
      } else if (msg.type === 'event') {
        for (const h of this.eventHandlers) {
          try {
            h(msg)
          } catch {
            /* one bad listener never blocks the others */
          }
        }
      }
    }
  }

  private onClose(): void {
    this.sock = null
    this.hello = null
    // Reject in-flight RPCs so callers never hang on a dropped helper.
    for (const cb of this.pending.values()) cb({ type: 'reply', error: 'helper disconnected' })
    this.pending.clear()
    if (this.wantQuit) {
      this.wantQuit = false
      return
    }
    if (this.supervise) {
      // Unexpected drop (crash) → bring it back. shutdown() clears `supervise`, so a deliberate
      // app quit never respawns. Small delay avoids a tight respawn loop. Respawn THROUGH ensure()
      // (single-flight), NOT launch() directly: a connection osa()/ensure() firing in this ~800ms
      // down-window then SHARES the same in-flight launch instead of racing a SECOND `open -n` (two
      // helpers both holding TCC, the zombie's later socket-close clobbering the live one → respawn cascade).
      setTimeout(() => void this.ensure().catch(() => {}), 800)
    }
  }

  /** LaunchServices launch (own TCC identity). `-n` forces a fresh instance (used by relaunch). */
  private async launch(): Promise<boolean> {
    const appPath = installedHelperApp()
    if (!existsSync(appPath)) return false
    const r = await exec('/usr/bin/open', ['-n', appPath, '--args', '--connect', this.sockPath])
    return r.ok
  }

  private waitForConnect(ms = 6000): Promise<boolean> {
    if (this.hello) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(!!this.hello), ms)
      this.connectWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  private rpc(cmd: string, ms = 8000): Promise<Record<string, unknown>> {
    const s = this.sock
    if (!s) return Promise.resolve({ error: 'helper not connected' })
    const id = this.nextId++
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        resolve({ error: 'helper timeout' })
      }, ms)
      this.pending.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      try {
        s.write(JSON.stringify({ id, cmd }) + '\n')
      } catch {
        clearTimeout(t)
        this.pending.delete(id)
        resolve({ error: 'helper write failed' })
      }
    })
  }

  /** Send a command WITH args and await the reply — the window adapter's path to the AX/vision/CGEvent
   *  verbs (the bare rpc() above carries no args). */
  call(cmd: string, args: Record<string, unknown> = {}, ms = 10000): Promise<Record<string, unknown>> {
    const s = this.sock
    if (!s) return Promise.resolve({ error: 'helper not connected' })
    const id = this.nextId++
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        resolve({ error: 'helper timeout' })
      }, ms)
      this.pending.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      try {
        s.write(JSON.stringify({ id, cmd, ...args }) + '\n')
      } catch {
        clearTimeout(t)
        this.pending.delete(id)
        resolve({ error: 'helper write failed' })
      }
    })
  }

  /** Register a handler for unsolicited helper events (e.g. `ax_changed` from an AXObserver, or `pick_*`
   *  from the window picker). MULTIPLE listeners are supported — the window-link watches ax_changed while
   *  the picker watches pick_*; pass null to clear all. */
  onEvent(fn: ((m: Record<string, unknown>) => void) | null): void {
    if (fn === null) this.eventHandlers.clear()
    else this.eventHandlers.add(fn)
  }

  /** Install (if needed) + launch + wait for the helper to connect. Idempotent, and SINGLE-FLIGHT:
   *  concurrent callers (e.g. the prewarm + a step) share one in-flight ensure, so two installs never
   *  race on the same dst (one rm -rf while the other cp -R, which produced a spurious "not found"). */
  ensure(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'darwin') return Promise.resolve({ ok: false, error: 'macOS only' })
    if (this.hello) return Promise.resolve({ ok: true })
    if (this.ensuring) return this.ensuring
    this.ensuring = (async () => {
      this.ensureServer()
      if (!(await this.install())) return { ok: false, error: 'helper bundle not found' }
      this.supervise = true
      if (!(await this.launch())) return { ok: false, error: 'launch failed' }
      const connected = await this.waitForConnect()
      return connected ? { ok: true } : { ok: false, error: 'helper did not connect' }
    })()
    void this.ensuring.finally(() => {
      this.ensuring = null
    })
    return this.ensuring
  }

  available(): boolean {
    return process.platform === 'darwin' && existsSync(bundledHelperApp())
  }

  connected(): boolean {
    return !!this.hello
  }

  private tccOf(m: Record<string, unknown> | null): HelperTcc {
    const t = (m?.tcc as { accessibility?: boolean; screenRecording?: boolean; fullDisk?: boolean }) || {}
    return { accessibility: !!t.accessibility, screenRecording: !!t.screenRecording, fullDisk: !!t.fullDisk }
  }

  async status(): Promise<HelperTcc | null> {
    if (!this.hello) return null
    const r = await this.rpc('tcc_status')
    if (r.error) return this.tccOf(this.hello)
    return this.tccOf(r)
  }

  /** Grant state for a specific permission (accessibility | screen | fda) from the helper. */
  grantedFor(kind: DragPerm, tcc: HelperTcc | null): boolean {
    if (!tcc) return false
    return kind === 'accessibility' ? tcc.accessibility : kind === 'screen' ? tcc.screenRecording : tcc.fullDisk
  }

  /** NO-PROMPT Automation (Apple Events) grant check for a target bundle id, via the helper's
   *  AEDeterminePermissionToAutomateTarget(askUserIfNeeded:false). Reports the CURRENT state without ever
   *  raising the consent dialog, so callers can skip the prompting probe (`count windows`) on an already-allowed
   *  target — the fix for "control Safari" re-popping after it was granted. 'unknown' = helper down or target not
   *  running (status -600), so the caller still falls through to the normal (prompting) path. */
  async automationGranted(bundleId: string): Promise<'granted' | 'denied' | 'undetermined' | 'unknown'> {
    if (!this.hello) return 'unknown'
    const r = (await this.call('automation_status', { bundleId }).catch(() => ({ error: 'call failed' }))) as Record<string, unknown>
    if (r.error || r.ok !== true) return 'unknown'
    const status = Number(r.status)
    if (status === 0) return 'granted' // noErr
    if (status === -1743) return 'denied' // errAEEventNotPermitted (user said no)
    if (status === -1744) return 'undetermined' // errAEEventWouldRequireUserConsent (never asked)
    return 'unknown' // -600 procNotFound (target not running), or any unexpected code
  }

  /** Ask the helper to request a grant — raises the system prompt AND lists the helper in the pane.
   *  FDA has NO request API (the user adds the app manually / by drag), so for fda we just return
   *  the current status; the pre-board's drag tile + poll drive it. */
  async request(kind: DragPerm): Promise<HelperTcc | null> {
    if (!this.hello) return null
    if (kind === 'fda') return this.status()
    const r = await this.rpc(kind === 'accessibility' ? 'request_accessibility' : 'request_screen')
    return r.error ? this.tccOf(this.hello) : this.tccOf(r)
  }

  /** Run the onboarding scan UNDER the helper (→ the helper's Full Disk Access, not BlitzOS's).
   *  Forwards the scan's @progress stderr lines to onLine; resolves when the scan exits. Long-lived,
   *  so it uses a dedicated wait, not the short rpc timeout. */
  runScan(req: ScanRequest, onLine?: (line: string) => void, timeoutMs = 180_000): Promise<{ ok: boolean; exit?: number; error?: string }> {
    const s = this.sock
    if (!s || !this.hello) return Promise.resolve({ ok: false, error: 'helper not connected' })
    const id = this.nextId++
    if (onLine) this.scanProgress.set(id, onLine)
    return new Promise((resolve) => {
      const done = (r: { ok: boolean; exit?: number; error?: string }): void => {
        clearTimeout(t)
        this.pending.delete(id)
        this.scanProgress.delete(id)
        resolve(r)
      }
      const t = setTimeout(() => done({ ok: false, error: 'scan timeout' }), timeoutMs)
      this.pending.set(id, (m) => done({ ok: !!m.ok, exit: typeof m.exit === 'number' ? m.exit : undefined, error: typeof m.error === 'string' ? m.error : undefined }))
      try {
        s.write(JSON.stringify({ id, cmd: 'scan', node: req.node, script: req.script, args: req.args, env: req.env }) + '\n')
      } catch {
        done({ ok: false, error: 'helper write failed' })
      }
    })
  }

  /** THE insight: quit + relaunch the HELPER so a just-granted permission takes effect, leaving
   *  BlitzOS running. Returns once the fresh helper has reconnected. */
  async relaunchForGrant(): Promise<{ ok: boolean }> {
    if (process.platform !== 'darwin') return { ok: false }
    this.wantQuit = true
    if (this.sock) await this.rpc('quit', 3000)
    // Give the old instance a beat to exit before the new one launches (LaunchServices `-n`).
    await new Promise((r) => setTimeout(r, 600))
    if (!(await this.launch())) return { ok: false }
    return { ok: await this.waitForConnect() }
  }

  /** The installed bundle path — what the pre-board drag tile drags into the Settings list. */
  installedAppPath(): string {
    return installedHelperApp()
  }

  shutdown(): void {
    this.supervise = false
    this.wantQuit = true
    try {
      if (this.sock) this.sock.write(JSON.stringify({ id: -1, cmd: 'quit' }) + '\n')
    } catch {
      /* gone */
    }
    try {
      this.server?.close()
    } catch {
      /* gone */
    }
    try {
      rmSync(this.sockPath, { force: true })
    } catch {
      /* gone */
    }
  }
}

let manager: HelperManager | null = null
export function computerUseHelper(): HelperManager {
  if (!manager) manager = new HelperManager()
  return manager
}
