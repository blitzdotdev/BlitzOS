// Dead-simple OTA self-updater + dev build picker (docs/prod-ci.md).
//
// CI publishes EVERY branch push as a GitHub release tagged `build-<branch>-<run>` with a mac zip,
// and stamps {buildBranch, buildRun} into the packaged package.json (electron-builder extraMetadata).
// Two consumers:
//   • AUTO-POLL (everyone): follows ONLY the branch this app was built from — a newer run of the
//     same branch downloads + stages and offers "Restart Now". A staging push can never hijack a
//     master install.
//   • DEV BUILD PICKER (developer machines only, ⌥⌘U): a vertical list of every CI build grouped by
//     branch — pick any (older, sideways, another branch) and Install swaps the .app to exactly it.
//     Gated by the Mac's hardware UUID (allowlist below) or a ~/.blitzos/dev-machine flag file.
//
// Deliberately NOT electron-updater/Squirrel: Squirrel refuses unsigned updates; this works signed
// or not (quarantine re-stripped after the swap — a no-op on notarized builds). Private-repo auth:
// GH_TOKEN env or ~/.blitzos/github-token.
import { app, dialog, BrowserWindow, nativeImage } from 'electron'
import { execFileSync, spawn } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Which repo's releases this build follows: env override > the repo CI baked into THIS build
// (extraMetadata.buildRepo = github.repository) > the public OSS repo. The OSS build polls the
// PUBLIC blitzdotdev/blitzos-oss (no token needed); a private/internal build bakes blitzdotdev/BlitzOS.
// Lazy (not a load-time const) because it reads app.getAppPath(), which needs the app to be ready.
function repo(): string {
  if (process.env.BLITZ_UPDATE_REPO) return process.env.BLITZ_UPDATE_REPO.trim()
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { buildRepo?: string }
    if (pkg.buildRepo) return String(pkg.buildRepo)
  } catch {
    /* dev run / pre-CI build */
  }
  return 'blitzdotdev/blitzos-oss'
}
const POLL_MS = 30 * 60 * 1000 // 30 min; plus one check shortly after boot
// Developer Macs (hardware UUID via IOPlatformExpertDevice) that see the hidden build picker.
const DEV_MACHINE_UUIDS = new Set(['51312831-F822-58AB-A7CA-7D54A86C9B10'])

interface Build {
  tag: string
  branch: string
  run: number
  date: string
  assetUrl: string
  assetName: string
  sizeMb: number
}

let busy = false
let staged: { tag: string; appPath: string } | null = null
let picker: BrowserWindow | null = null

function token(): string | null {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  try {
    return readFileSync(join(homedir(), '.blitzos', 'github-token'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** What this binary was built FROM — CI stamps buildBranch/buildRun into the packaged package.json. */
function buildMeta(): { branch: string; run: number } {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as { buildBranch?: string; buildRun?: number }
    if (pkg.buildBranch) return { branch: String(pkg.buildBranch), run: Number(pkg.buildRun) || 0 }
  } catch {
    /* dev run / pre-CI build */
  }
  return { branch: process.env.BLITZ_BUILD_BRANCH || 'master', run: 0 }
}

/** This Mac is a developer machine → the hidden build picker is available. Memoized (ioreg exec). */
let devMachine: boolean | null = null
export function isDevMachine(): boolean {
  if (devMachine !== null) return devMachine
  devMachine = computeDevMachine()
  return devMachine
}
function computeDevMachine(): boolean {
  if (existsSync(join(homedir(), '.blitzos', 'dev-machine'))) return true
  try {
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' })
    const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-F-]+)"/i)
    return !!m && DEV_MACHINE_UUIDS.has(m[1].toUpperCase())
  } catch {
    return false
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

/** All CI builds, newest first: releases tagged build-<branch>-<run> with a mac zip asset. */
async function listBuilds(tok: string | null): Promise<Build[]> {
  const res = await fetch(`https://api.github.com/repos/${repo()}/releases?per_page=60`, { headers: ghHeaders(tok, 'application/vnd.github+json') })
  if (!res.ok) {
    console.log(`[update] release list ${res.status} (private repo needs GH_TOKEN or ~/.blitzos/github-token)`)
    return []
  }
  const list = (await res.json()) as Array<{ tag_name: string; published_at: string; assets: Array<{ name: string; url: string; size: number }> }>
  const out: Build[] = []
  for (const rel of list || []) {
    const m = /^build-(.+)-(\d+)$/.exec(rel.tag_name)
    if (!m) continue // pre-picker tags (v0.0.1-N) and anything else: ignored
    const asset = (rel.assets || []).find((a) => a.name.endsWith('.zip') && a.name.includes('arm64')) || (rel.assets || []).find((a) => a.name.endsWith('.zip'))
    if (!asset) continue
    out.push({ tag: rel.tag_name, branch: m[1], run: Number(m[2]), date: (rel.published_at || '').slice(0, 16).replace('T', ' '), assetUrl: asset.url, assetName: asset.name, sizeMb: Math.round(asset.size / 1e6) })
  }
  out.sort((a, b) => b.run - a.run)
  return out
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

/** Swap <staged>.app over the running app after quit, then relaunch (PID-wait → never copy over a live bundle). */
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

/** The BlitzOS logo for the native update dialog: the shipped dock icon (process.resourcesPath in a
 *  packaged build; the source asset in dev). undefined if missing, so the dialog falls back cleanly. */
function updateIcon(): Electron.NativeImage | undefined {
  const p = app.isPackaged
    ? join(process.resourcesPath, 'blitz-dock-icon.png')
    : join(__dirname, '..', '..', 'src', 'renderer', 'src', 'assets', 'blitz-dock-icon.png')
  try {
    const img = nativeImage.createFromPath(p)
    return img.isEmpty() ? undefined : img
  } catch {
    return undefined
  }
}

/** Download + stage one build, then offer the restart-swap. The picker path allows ANY build
 *  (older / other branch); the auto-poll path only ever passes a newer same-branch one. */
async function installBuild(b: Build, tok: string | null): Promise<void> {
  if (!app.isPackaged) {
    void dialog.showMessageBox({ type: 'info', message: 'Dev run', detail: `Would install ${b.tag} — installs only apply to the packaged app.` })
    return
  }
  if (!staged || staged.tag !== b.tag) {
    console.log(`[update] staging ${b.tag} (${b.assetName})`)
    const dir = join(app.getPath('userData'), 'updates')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const zip = join(dir, b.assetName)
    await download(b.assetUrl, tok, zip)
    if ((await run('/usr/bin/ditto', ['-xk', zip, join(dir, 'unzipped')])) !== 0) throw new Error('unzip failed')
    const appName = readdirSync(join(dir, 'unzipped')).find((n) => n.endsWith('.app'))
    if (!appName) throw new Error('no .app in artifact')
    staged = { tag: b.tag, appPath: join(dir, 'unzipped', appName) }
  }
  const { response } = await dialog.showMessageBox({
    icon: updateIcon(),
    buttons: ['Restart Now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    message: 'A new version of BlitzOS is ready',
    detail: 'Restart to update. Everything you have open will be right back where you left it.'
  })
  if (response === 0 && staged) applyOnQuit(staged.appPath)
}

/** Auto-poll: newest run of THIS APP'S OWN branch only. */
async function check(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const tok = token()
    const me = buildMeta()
    const mine = (await listBuilds(tok)).filter((b) => b.branch === me.branch)
    const latest = mine[0]
    if (!latest || latest.run <= me.run) return
    await installBuild(latest, tok)
  } catch (e) {
    console.log('[update] check failed:', (e as Error)?.message || e)
  } finally {
    busy = false
  }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The hidden dev picker (⌥⌘U): every CI build, grouped by branch, Install = swap to exactly it. */
export async function openBuildPicker(): Promise<void> {
  if (picker) {
    picker.focus()
    return
  }
  const tok = token()
  const builds = await listBuilds(tok)
  const me = buildMeta()
  const byBranch = new Map<string, Build[]>()
  for (const b of builds) {
    const arr = byBranch.get(b.branch) || []
    arr.push(b)
    byBranch.set(b.branch, arr)
  }
  const groups = [...byBranch.entries()]
    .map(
      ([branch, list]) => `
    <h2>${esc(branch)}${branch === me.branch ? ' <span class="you">your channel</span>' : ''}</h2>
    ${list
      .map(
        (b) => `
      <div class="row${b.branch === me.branch && b.run === me.run ? ' current' : ''}">
        <div class="meta"><b>#${b.run}</b><span>${esc(b.date)} · ${b.sizeMb} MB</span></div>
        ${b.branch === me.branch && b.run === me.run ? '<span class="tag">running</span>' : `<a class="btn" href="blitz-install://${encodeURIComponent(b.tag)}">Install</a>`}
      </div>`
      )
      .join('')}`
    )
    .join('')
  const html = `<!doctype html><meta charset="utf-8"><title>BlitzOS builds</title><style>
  body{font:13px -apple-system,sans-serif;margin:0;padding:14px 16px;background:#16181c;color:#e8eaee}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#9aa3b2;margin:16px 0 6px}
  .you{color:#5fb2ff;text-transform:none;letter-spacing:0;font-weight:500}
  .row{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid #2a2e36;border-radius:9px;margin-bottom:6px;background:#1c1f25}
  .row.current{border-color:#2f6e3f}
  .meta{display:flex;flex-direction:column;gap:1px}.meta span{color:#9aa3b2;font-size:11.5px}
  .btn{background:#2f6cde;color:#fff;text-decoration:none;padding:5px 12px;border-radius:7px;font-weight:600;font-size:12px}
  .tag{color:#69c97e;font-weight:600;font-size:12px}
  .empty{color:#9aa3b2;padding:20px 4px}
  </style>
  <div style="font-size:15px;font-weight:700">CI builds</div>
  <div style="color:#9aa3b2;font-size:12px;margin-top:2px">you: ${esc(me.branch)} #${me.run || '?'} · v${esc(app.getVersion())}</div>
  ${groups || `<div class="empty">No CI builds visible.${tok ? '' : ' Add a token (GH_TOKEN or ~/.blitzos/github-token) — the repo is private.'}</div>`}`
  picker = new BrowserWindow({ width: 430, height: 580, title: 'BlitzOS builds', webPreferences: { sandbox: true } })
  picker.on('closed', () => (picker = null))
  // Install buttons navigate to blitz-install://<tag>; intercept instead of loading.
  picker.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('blitz-install://')) return
    e.preventDefault()
    const tag = decodeURIComponent(url.slice('blitz-install://'.length).replace(/\/$/, ''))
    const b = builds.find((x) => x.tag === tag)
    if (!b) return
    picker?.close()
    void installBuild(b, token()).catch((err) => void dialog.showMessageBox({ type: 'warning', message: 'Install failed', detail: String((err as Error)?.message || err) }))
  })
  void picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

/** Wire the OTA poll (packaged only; BLITZ_NO_UPDATE=1 disables). The dev picker is wired in
 *  index.ts (⌥⌘U via before-input-event) and gated by isDevMachine(). */
export function initUpdater(): void {
  if (!app.isPackaged || process.env.BLITZ_NO_UPDATE === '1') return
  setTimeout(() => void check(), 15_000) // shortly after boot, off the critical path
  setInterval(() => void check(), POLL_MS)
}
