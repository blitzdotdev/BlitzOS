import { app } from 'electron'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

export interface HelperProcessOptions {
  bundleName: string
  installDirName: string
  envOverride: string
  logPrefix: string
  socketPrefix: string
  bundledRel?: string[]
  helloTimeoutMs?: number
}

export interface HelperEnsureResult {
  ok: boolean
  error?: string
  reason?: string
}

type FrameHandler = (m: Record<string, unknown>) => void

const exec = (cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 20_000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) })))

function plistVersion(appPath: string): string | null {
  try {
    const plist = readFileSync(join(appPath, 'Contents', 'Info.plist'), 'utf8')
    const m = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function hereDir(): string {
  try {
    return typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return ''
  }
}

export class HelperProcess {
  private server: net.Server | null = null
  private sock: net.Socket | null = null
  private readonly sockPath: string
  private buf = ''
  private pending = new Map<number, (m: Record<string, unknown>) => void>()
  private frameHandlers = new Set<FrameHandler>()
  private eventHandlers = new Set<FrameHandler>()
  private nextId = 1
  private hello: Record<string, unknown> | null = null
  private wantQuit = false
  private connectWaiters: Array<() => void> = []
  private supervise = false
  private ensuring: Promise<HelperEnsureResult> | null = null
  private pathLogged = false

  constructor(private readonly opts: HelperProcessOptions) {
    this.sockPath = join(tmpdir(), `${opts.socketPrefix}-${process.pid}.sock`)
  }

  bundledAppPath(): string {
    const rel = this.opts.bundledRel ?? ['native', this.opts.installDirName, 'build', this.opts.bundleName]
    const here = hereDir()
    const candidates = [
      process.env[this.opts.envOverride],
      app.isPackaged ? join(process.resourcesPath, this.opts.bundleName) : null,
      join(app.getAppPath(), ...rel),
      here ? join(here, '..', '..', ...rel) : null,
      !app.isPackaged ? join(process.cwd(), ...rel) : null
    ].filter((p): p is string => !!p)
    for (const c of candidates) if (existsSync(c)) return c
    if (!this.pathLogged) {
      this.pathLogged = true
      console.error(`[${this.opts.logPrefix}] helper bundle NOT found. candidates:`, JSON.stringify(candidates))
    }
    return candidates[candidates.length - 1] ?? join(app.getAppPath(), ...rel)
  }

  installedAppPath(): string {
    return join(app.getPath('appData'), 'BlitzOS', this.opts.bundleName)
  }

  private async install(): Promise<boolean> {
    const src = this.bundledAppPath()
    if (!existsSync(src)) return false
    const dst = this.installedAppPath()
    if (existsSync(dst) && plistVersion(dst) === plistVersion(src) && plistVersion(src) != null) return true
    try {
      mkdirSync(join(app.getPath('appData'), 'BlitzOS'), { recursive: true })
      if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
      const r = await exec('/bin/cp', ['-R', src, dst])
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
    this.server.on('error', (e) => console.error(`[${this.opts.logPrefix}] socket server error:`, (e as Error)?.message))
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
      for (const h of this.frameHandlers) {
        try {
          h(msg)
        } catch {
          /* one bad listener never blocks the others */
        }
      }
      if (msg.type === 'hello') {
        this.hello = msg
        const waiters = this.connectWaiters
        this.connectWaiters = []
        for (const w of waiters) w()
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
    for (const cb of this.pending.values()) cb({ type: 'reply', error: 'helper disconnected' })
    this.pending.clear()
    if (this.wantQuit) {
      this.wantQuit = false
      return
    }
    if (this.supervise) setTimeout(() => void this.launch().catch(() => {}), 800)
  }

  private async launch(): Promise<boolean> {
    const appPath = this.installedAppPath()
    if (!existsSync(appPath)) return false
    const r = await exec('/usr/bin/open', ['-n', appPath, '--args', '--connect', this.sockPath])
    return r.ok
  }

  private waitForConnect(ms = this.opts.helloTimeoutMs ?? 6000): Promise<boolean> {
    if (this.hello) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(!!this.hello), ms)
      this.connectWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  call(cmd: string, args: Record<string, unknown> = {}, ms = 10000, onRequestId?: (id: number) => void): Promise<Record<string, unknown>> {
    const s = this.sock
    if (!s) return Promise.resolve({ error: 'helper not connected' })
    const id = this.nextId++
    onRequestId?.(id)
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

  onFrame(fn: FrameHandler | null): void {
    if (fn === null) this.frameHandlers.clear()
    else this.frameHandlers.add(fn)
  }

  onEvent(fn: FrameHandler | null): void {
    if (fn === null) this.eventHandlers.clear()
    else this.eventHandlers.add(fn)
  }

  ensure(): Promise<HelperEnsureResult> {
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
    return process.platform === 'darwin' && existsSync(this.bundledAppPath())
  }

  connected(): boolean {
    return !!this.hello
  }

  helloFrame(): Record<string, unknown> | null {
    return this.hello
  }

  async relaunchForGrant(): Promise<{ ok: boolean }> {
    if (process.platform !== 'darwin') return { ok: false }
    this.wantQuit = true
    if (this.sock) await this.call('quit', {}, 3000)
    await new Promise((r) => setTimeout(r, 600))
    if (!(await this.launch())) return { ok: false }
    return { ok: await this.waitForConnect() }
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
