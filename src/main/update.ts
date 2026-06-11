// Dead-simple OTA self-updater (docs/prod-ci.md). CI publishes every push as a GitHub release with a
// mac zip; this polls the repo, downloads a newer artifact, and swaps the .app on restart via a tiny
// detached shell script. Deliberately NOT electron-updater/Squirrel: Squirrel refuses to apply updates
// to ad-hoc/unsigned builds, while this works signed or not (it re-strips quarantine after the swap —
// a no-op on a notarized build). Private-repo auth: GH_TOKEN env or ~/.blitzos/github-token.
import { app, dialog } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const REPO = process.env.BLITZ_UPDATE_REPO || 'blitzdotdev/BlitzOS'
const POLL_MS = 30 * 60 * 1000 // 30 min; plus one check shortly after boot
let busy = false
let staged: { tag: string; appPath: string } | null = null

function token(): string | null {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  try {
    return readFileSync(join(homedir(), '.blitzos', 'github-token'), 'utf8').trim() || null
  } catch {
    return null
  }
}

function ghHeaders(tok: string | null, accept: string): Record<string, string> {
  return {
    accept,
    'user-agent': 'BlitzOS-updater',
    'x-github-api-version': '2022-11-28',
    ...(tok ? { authorization: `Bearer ${tok}` } : {})
  }
}

/** The newest release (CI creates one per push, tag v<version>-<run>) + its mac zip asset. */
async function latestRelease(tok: string | null): Promise<{ tag: string; assetUrl: string; assetName: string } | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, { headers: ghHeaders(tok, 'application/vnd.github+json') })
  if (!res.ok) {
    console.log(`[update] release list ${res.status} (private repo needs GH_TOKEN or ~/.blitzos/github-token)`)
    return null
  }
  const list = (await res.json()) as Array<{ tag_name: string; assets: Array<{ name: string; url: string }> }>
  const rel = list && list[0]
  if (!rel) return null
  const asset = (rel.assets || []).find((a) => a.name.endsWith('.zip') && a.name.includes('arm64')) || (rel.assets || []).find((a) => a.name.endsWith('.zip'))
  if (!asset) return null
  return { tag: rel.tag_name, assetUrl: asset.url, assetName: asset.name }
}

/** Download a release ASSET (api asset url + octet-stream Accept; fetch drops auth on the S3 redirect). */
async function download(url: string, tok: string | null, dest: string): Promise<void> {
  const res = await fetch(url, { headers: ghHeaders(tok, 'application/octet-stream') })
  if (!res.ok || !res.body) throw new Error(`asset download ${res.status}`)
  const ws = createWriteStream(dest)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) ws.write(Buffer.from(value))
  }
  await new Promise<void>((resolve, reject) => {
    ws.end(() => resolve())
    ws.on('error', reject)
  })
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    p.on('exit', (code) => resolve(code ?? 1))
    p.on('error', () => resolve(1))
  })
}

/** Swap <staged>.app over the running app after quit, then relaunch. PID-waits so we never copy over
 *  a live bundle; re-opens the (possibly moved) app via its path. */
function applyOnQuit(stagedApp: string): void {
  const exe = app.getPath('exe') // .../BlitzOS.app/Contents/MacOS/BlitzOS
  const appBundle = join(exe, '..', '..', '..')
  const dir = join(app.getPath('userData'), 'updates')
  const script = join(dir, 'apply.sh')
  writeFileSync(
    script,
    `#!/bin/bash
# BlitzOS self-update: wait for the app to exit, swap the bundle, relaunch.
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
rm -rf "${appBundle}"
ditto "${stagedApp}" "${appBundle}"
xattr -dr com.apple.quarantine "${appBundle}" 2>/dev/null || true
open "${appBundle}"
`
  )
  chmodSync(script, 0o755)
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref()
  app.quit()
}

async function check(interactive = false): Promise<void> {
  if (busy) return
  busy = true
  try {
    const tok = token()
    const rel = await latestRelease(tok)
    if (!rel) return
    const current = app.getVersion()
    const next = rel.tag.replace(/^v/, '')
    if (next === current) return
    // Already staged this tag → just re-offer the restart.
    if (!staged || staged.tag !== rel.tag) {
      console.log(`[update] ${current} -> ${rel.tag}: downloading ${rel.assetName}`)
      const dir = join(app.getPath('userData'), 'updates')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      const zip = join(dir, rel.assetName)
      await download(rel.assetUrl, tok, zip)
      if ((await run('/usr/bin/ditto', ['-xk', zip, join(dir, 'unzipped')])) !== 0) throw new Error('unzip failed')
      const appName = readdirSync(join(dir, 'unzipped')).find((n) => n.endsWith('.app'))
      if (!appName) throw new Error('no .app in artifact')
      staged = { tag: rel.tag, appPath: join(dir, 'unzipped', appName) }
      console.log(`[update] staged ${rel.tag}`)
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      message: `BlitzOS ${rel.tag} is ready`,
      detail: `You're on ${current}. Restart to update — your workspaces are untouched.`
    })
    if (response === 0 && staged) applyOnQuit(staged.appPath)
  } catch (e) {
    console.log('[update] check failed:', (e as Error)?.message || e)
    if (interactive) void dialog.showMessageBox({ type: 'warning', message: 'Update check failed', detail: String((e as Error)?.message || e) })
  } finally {
    busy = false
  }
}

/** Wire the OTA poll. Packaged builds only; BLITZ_NO_UPDATE=1 disables (e.g. CI smoke runs). */
export function initUpdater(): void {
  if (!app.isPackaged || process.env.BLITZ_NO_UPDATE === '1') return
  setTimeout(() => void check(), 15_000) // shortly after boot, off the critical path
  setInterval(() => void check(), POLL_MS)
}
