// BlitzOS AI Chrome — lifecycle manager (plans/cdp-browser-blitzos-plan.md).
//
// Owns a SEPARATE, dedicated Chrome instance with its OWN `--user-data-dir`, fully isolated from the user's
// real Chrome. The connector (extension/, now with chrome.debugger/CDP) is loaded into THIS instance only;
// each chat agent then gets its own background window in it (connection_open_browser → openAgentWindow), with
// one login shared by all agents. Isolation means the AI's browsing never touches the user's profile, and the
// "started debugging this browser" banner / dev-mode nag stay on a window the user doesn't look at.
//
// We launch the Chrome binary DIRECTLY (not `open -a`) with a unique user-data-dir, so the spawned process is
// the long-lived browser process we can supervise + relaunch on death. `--silent-debugger-extension-api`
// (a launch-only switch) suppresses the CDP infobar. On the very first launch we open chrome://extensions and
// reveal the connector folder so the one-time load (Developer mode → drag the folder) is one gesture; the
// connector then connects to the SAME localhost tab-link the user's Chrome would, so all connection_* tools work.

import { app } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AiBrowserStatus {
  available: boolean
  running: boolean
  firstRun: boolean
  profileDir: string
  extensionDir: string
  chromeBin: string | null
  note?: string
}

// The connector source dir (same resolution as connection-install.ts's connectorDir): packaged → resourcesPath,
// else the app path, else cwd. Loaded unpacked into the AI Chrome.
function connectorDir(): string {
  const here = (() => {
    try {
      return typeof __dirname !== 'undefined' ? __dirname : fileURLToPath(new URL('.', import.meta.url))
    } catch {
      return ''
    }
  })()
  const cands = [
    app.isPackaged ? join(process.resourcesPath, 'extension') : null,
    join(app.getAppPath(), 'extension'),
    here ? join(here, '..', '..', 'extension') : null, // out/main → repo root in dev
    join(process.cwd(), 'extension')
  ].filter((p): p is string => !!p)
  for (const c of cands) if (existsSync(join(c, 'manifest.json'))) return c
  return cands[cands.length - 1]
}

// The Google Chrome binary. Overridable with BLITZ_AI_CHROME_BIN; we also try Chrome / Chrome Canary / Chromium.
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

const exec = (cmd: string, args: string[]): Promise<{ ok: boolean }> =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 15_000 }, (err) => resolve({ ok: !err })))

class AiBrowserManager {
  private child: ChildProcess | null = null
  private supervise = false
  private wantQuit = false
  private launching: Promise<{ ok: boolean; error?: string }> | null = null
  private profileDir = join(app.getPath('appData'), 'BlitzOS', 'ai-chrome')

  available(): boolean {
    return process.platform === 'darwin' && !!findChromeBin()
  }

  isRunning(): boolean {
    return !!this.child && this.child.exitCode == null && !this.child.killed
  }

  private launchArgs(extraUrls: string[]): string[] {
    const ext = connectorDir()
    return [
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--silent-debugger-extension-api', // suppress the "started debugging this browser" infobar (launch-only)
      `--load-extension=${ext}`, // best-effort auto-load; the manual drag (revealed folder) is the reliable fallback
      ...extraUrls
    ]
  }

  /** Launch if not running. Idempotent + single-flight. On the FIRST ever launch (no profile yet) we open
   *  chrome://extensions and reveal the connector folder so the one-time load is a single gesture. */
  ensure(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'darwin') return Promise.resolve({ ok: false, error: 'the AI browser is macOS-only' })
    if (this.isRunning()) return Promise.resolve({ ok: true })
    if (this.launching) return this.launching
    this.launching = (async () => {
      const bin = findChromeBin()
      if (!bin) return { ok: false, error: 'Google Chrome is not installed (looked in /Applications)' }
      const firstRun = !existsSync(this.profileDir)
      try {
        mkdirSync(this.profileDir, { recursive: true })
      } catch {
        /* best-effort; Chrome creates it too */
      }
      const urls = firstRun ? ['chrome://extensions'] : []
      try {
        const child = spawn(bin, this.launchArgs(urls), { detached: false, stdio: 'ignore' })
        this.child = child
        this.supervise = true
        this.wantQuit = false
        child.on('exit', () => {
          if (this.child === child) this.child = null
          if (this.wantQuit) {
            this.wantQuit = false
            return
          }
          // unexpected exit (crash / user quit) → bring it back if still supervising. A small delay avoids a
          // tight respawn loop; the dedicated profile means a relaunch reattaches the connector cleanly.
          if (this.supervise) setTimeout(() => void this.ensure().catch(() => {}), 1200)
        })
        child.on('error', (e) => console.warn('[blitzos] AI Chrome spawn error:', (e as Error)?.message))
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message || e) }
      }
      if (firstRun) void this.revealConnector()
      return { ok: true }
    })()
    void this.launching.finally(() => {
      this.launching = null
    })
    return this.launching
  }

  /** Open chrome://extensions in the (running) AI Chrome and reveal the connector folder in Finder — the
   *  one-time onboarding surface (Developer mode → drag the folder). Re-running the binary with the same
   *  user-data-dir forwards the URL to the existing instance. */
  async openOnboarding(): Promise<{ ok: boolean; extensionDir: string }> {
    const bin = findChromeBin()
    const ext = connectorDir()
    if (bin) await exec(bin, [`--user-data-dir=${this.profileDir}`, 'chrome://extensions'])
    await this.revealConnector()
    return { ok: !!bin, extensionDir: ext }
  }

  private async revealConnector(): Promise<void> {
    const ext = connectorDir()
    const manifest = join(ext, 'manifest.json')
    if (existsSync(manifest)) await exec('/usr/bin/open', ['-R', manifest])
  }

  status(): AiBrowserStatus {
    return {
      available: this.available(),
      running: this.isRunning(),
      firstRun: !existsSync(this.profileDir),
      profileDir: this.profileDir,
      extensionDir: connectorDir(),
      chromeBin: findChromeBin()
    }
  }

  shutdown(): void {
    this.supervise = false
    this.wantQuit = true
    try {
      this.child?.kill()
    } catch {
      /* gone */
    }
    this.child = null
  }
}

let manager: AiBrowserManager | null = null
export function aiBrowser(): AiBrowserManager {
  if (!manager) manager = new AiBrowserManager()
  return manager
}
