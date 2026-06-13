// Onboarding director (P1 — plans/onboarding-case-file.md): the DETERMINISTIC half of first-run.
// No LLM anywhere in this file. It runs the local scan (scripts/onboarding-scan.mjs) as a child
// process, streams its real progress to the boot screen, builds the "Case File" workspace, and
// seeds the template board. WHAT goes on the board (cards, layout, props) is the pure planner in
// onboarding-board.mjs — this file is the impure glue (scan child, surfaces, IPC, FDA poll). The
// same surfaces double as the resident brain's (P2) medium: it reads .blitzos/onboarding/
// {scan.json,board.json} and drives the SAME ids via update_surface.
//
// FDA tutorial unlock: when Full Disk Access is off, the board gets a native 'unlock' card; we
// poll the TCC probe (the app's own FDA, which the scan child inherits), and on grant re-scan and
// visibly deepen the board (real focus time, Messages/Mail cadence), then retire the card.
//
import { app, ipcMain, shell, screen, BrowserWindow } from 'electron'
import { execFileSync, execFile, spawn } from 'node:child_process'

// Repo root in dev; app.asar.UNPACKED in a packaged build — the scan runs as a PLAIN-NODE child
// (no asar fs), so electron-builder.yml ships scripts/onboarding-scan.mjs + the prompt .md files
// asarUnpack'd and we resolve them there.
const appRoot = (): string => app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { osCreateSurface, osUpdateSurface, osCloseSurface, osCreateWorkspace, osSwitchWorkspace, osWorkspaceContext, osGoToPrimary, osSay, osGetState, osKickBrain, osRestartBrain } from './osActions'
import { computerUseHelper } from './computer-use-helper'
import { getWidgetSource } from './widget-catalog.mjs'
import { buildBoardPlan, unlockCardProps, findUnlockSlot, BRANCH_A_LAYOUT } from './onboarding-board.mjs'
import type { ScanJson, StagedSurface } from './onboarding-board.mjs'

const WS_NAME = 'case-file'
const POLL_MS = 3000

interface BoardFile {
  v: 1
  seededAt: number
  fdaAtSeed: boolean
  ids: Record<string, string> // card role → surface id (stable across restarts; the brain reads this too)
  unlockDismissed?: boolean
}

let mainWindow: (() => BrowserWindow | null) | null = null
let starting = false
let pollTimer: ReturnType<typeof setInterval> | null = null

const send = (channel: string, payload: unknown): void => {
  const win = mainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
const progress = (p: Record<string, unknown>): void => send('onboarding:progress', p)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Same probe as the scan's hasFDA(): can THIS process read a TCC-protected file? In main it tests
// the app's own grant — exactly the entity the scan child (ELECTRON_RUN_AS_NODE) inherits.
export function hasFDA(): boolean {
  const HOME = homedir()
  const tcc = join(HOME, 'Library/Application Support/com.apple.TCC/TCC.db')
  try {
    const fd = openSync(tcc, 'r')
    const b = Buffer.alloc(1)
    readSync(fd, b, 0, 1, 0)
    closeSync(fd)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EACCES') return false
  }
  try {
    accessSync(join(HOME, 'Library/Safari/History.db'), constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** What the macOS Settings FDA list will call us: the .app bundle name (dev = "Electron"). */
function fdaAppName(): string {
  const m = process.execPath.match(/([^/]+)\.app\//)
  return m ? m[1] : app.getName()
}

/** Dev-only: force the pre-board sequence to offer every step regardless of real grant state (see
 *  the preboard-state handler for why dev FDA inheritance makes this necessary). */
const forcePreboard = (): boolean => process.env.BLITZ_PREBOARD_FORCE === '1'

// ---- pre-board permission sequence (Dia-style frontloading; plans/onboarding-case-file.md) ----
// The Codex-style drag: System Settings' permission lists accept a DROPPED .app bundle, so the
// pre-board screen offers the app icon as a native file drag (webContents.startDrag of the bundle)
// next to the open-settings deep link — reverse-engineered from Codex.app's
// system-permissions-service (startDrag({file: bundlePath, icon: app.getFileIcon(bundlePath)})).

/** The running .app bundle (packaged = BlitzOS.app; dev = Electron.app — the binary TCC attributes
 *  grants to, so dragging IT is exactly right in dev). Null off-macOS / non-bundle launches. */
function appBundlePath(): string | null {
  const i = process.execPath.indexOf('.app/Contents/MacOS/')
  return i < 0 ? null : process.execPath.slice(0, i + 4)
}

/** A bundle's icon as a data URL for the drag tile. Codex's trick: sips-convert the bundle's .icns
 *  (crisp at tile size); fall back to app.getFileIcon (48px max) when anything is missing. Defaults
 *  to the running app; pass a path (e.g. the CU helper bundle) for that bundle's icon. */
async function appIconDataUrl(bundlePath?: string): Promise<string | null> {
  const bundle = bundlePath ?? appBundlePath()
  if (!bundle) return null
  try {
    const plist = readFileSync(join(bundle, 'Contents', 'Info.plist'), 'utf8')
    const m = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)
    if (m) {
      const icns = join(bundle, 'Contents', 'Resources', m[1].endsWith('.icns') ? m[1] : `${m[1]}.icns`)
      if (existsSync(icns)) {
        const out = join(tmpdir(), `blitz-preboard-icon-${process.pid}.png`)
        await new Promise<void>((res, rej) => execFile('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '256', icns, '--out', out], (e) => (e ? rej(e) : res())))
        const png = readFileSync(out)
        return `data:image/png;base64,${png.toString('base64')}`
      }
    }
  } catch {
    /* fall through to getFileIcon */
  }
  try {
    const icon = await app.getFileIcon(bundle, { size: 'large' })
    return icon.isEmpty() ? null : icon.toDataURL()
  } catch {
    return null
  }
}

/** First chromium-family browser found (AppleScript-drivable for the open-tabs import). */
const BROWSERS = [
  { id: 'com.google.Chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app' },
  { id: 'company.thebrowser.Browser', name: 'Arc', path: '/Applications/Arc.app' },
  { id: 'com.brave.Browser', name: 'Brave', path: '/Applications/Brave Browser.app' },
  { id: 'com.microsoft.edgemac', name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app' }
] as const
function detectBrowser(): { id: string; name: string } | null {
  for (const b of BROWSERS) if (existsSync(b.path)) return { id: b.id, name: b.name }
  return null
}

// ---- drag-list TCC permissions (FDA / Accessibility / Screen Recording), Codex Computer Use flow
// (plans/codex-computer-use-tcc-reference.md). Each: a Settings deep link + a poll + ONE shared
// floating drag-helper window that hosts the startDrag tile over the Settings list. (Automation /
// browser import is NOT here — it uses the osascript consent prompt, not a drag list.)
type DragPerm = 'fda' | 'accessibility' | 'screen'
const PERM_DEEPLINK: Record<DragPerm, string> = {
  fda: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
}
const PERM_LABEL: Record<DragPerm, string> = { fda: 'Full Disk Access', accessibility: 'Accessibility', screen: 'Screen Recording' }

// The floating drag-helper window: a frameless, non-activating, always-on-top panel pinned to the
// bottom-center of the active display, floating OVER System Settings so the drag SOURCE (the app
// icon) and the drag TARGET (the Settings list) are both visible. One window, reused per step.
let dragHelper: BrowserWindow | null = null
let dragPollTimer: ReturnType<typeof setInterval> | null = null
const DRAG_HELPER_W = 460
const DRAG_HELPER_H = 96

function dragHelperHtml(kind: DragPerm, iconUrl: string | null, appName: string): string {
  // Self-contained; the window shares the app preload, so the tile calls window.agentOS.onboarding
  // .preboardDrag() (→ main startDrag of the bundle). CSP locks it to inline + data: only.
  const label = PERM_LABEL[kind]
  const icon = iconUrl ? `<img src="${iconUrl}" alt="" draggable="false">` : ''
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; overflow:hidden; -webkit-user-select:none; user-select:none; font-family:-apple-system,system-ui,sans-serif; }
  .h { height:100%; display:flex; align-items:center; gap:14px; padding:0 18px; box-sizing:border-box;
       background:rgba(245,245,247,0.86); border-radius:16px; border:1px solid rgba(0,0,0,0.10);
       -webkit-backdrop-filter:saturate(1.3) blur(20px); backdrop-filter:saturate(1.3) blur(20px);
       box-shadow:0 8px 30px rgba(0,0,0,0.22); }
  @media (prefers-color-scheme: dark){ .h{ background:rgba(40,42,46,0.86); border-color:rgba(255,255,255,0.12); color:#f5f5f7; } }
  .tile { width:60px; height:60px; flex:0 0 auto; display:grid; place-items:center; cursor:grab; border-radius:14px; transition:transform .12s ease; }
  .tile:hover { transform:scale(1.07); } .tile:active { cursor:grabbing; }
  .tile img { width:56px; height:56px; pointer-events:none; }
  .c { font-size:13px; line-height:1.45; }
  .c b { font-weight:600; }
  .c .sub { opacity:0.62; font-size:12px; margin-top:2px; }
</style></head><body>
<div class="h">
  <span class="tile" id="t" draggable="true">${icon}</span>
  <div class="c"><div>Drag <b>${appName}</b> into the <b>${label}</b> list above</div>
  <div class="sub">Then flip it on. I'll notice the moment it lands.</div></div>
</div>
<script>
  document.getElementById('t').addEventListener('dragstart', function(e){
    e.preventDefault();
    try { window.agentOS && window.agentOS.onboarding && window.agentOS.onboarding.preboardDrag(); } catch (_) {}
  });
</script></body></html>`
}

// What the floating tile drags into the Settings list. FDA → the BlitzOS app (its own grant). The
// computer-use pair → the SEPARATE helper bundle, so the grant + the quit-and-reopen land on it,
// never on BlitzOS (plans/blitzos-computer-use-helper.md). Set per openDragHelper, read by the drag IPC.
let currentDragBundle: string | null = null
const HELPER_NAME = 'BlitzOS Computer Use'

async function openDragHelper(kind: DragPerm): Promise<void> {
  if (process.platform !== 'darwin') return
  // ALL THREE grants (FDA, Accessibility, Screen Recording) require the granted process to quit and
  // reopen, so ALL THREE live on the separate helper — never on BlitzOS. Launch it (LaunchServices →
  // its OWN TCC identity), ask it to request the grant (a11y/screen raise the prompt AS the helper +
  // list it; FDA has no request API so this is a no-op status read), and the tile drags the HELPER.
  const avail = computerUseHelper().available()
  let dragBundle: string | null = null
  let usingHelper = false
  console.log(`[computer-use] step=${kind} available=${avail}`)
  if (avail) {
    const ok = await computerUseHelper().ensure()
    console.log(`[computer-use] ensure → ${JSON.stringify(ok)}`)
    if (ok.ok) {
      await computerUseHelper().request(kind)
      dragBundle = computerUseHelper().installedAppPath()
      usingHelper = true
    }
  }
  // NEVER fall back to dragging BlitzOS — granting BlitzOS is exactly the quit-and-reopen we avoid.
  if (!usingHelper) console.error(`[computer-use] HELPER UNAVAILABLE for ${kind} (available=${avail}) — drag suppressed; build native/computer-use-helper`)
  currentDragBundle = dragBundle
  void shell.openExternal(PERM_DEEPLINK[kind]) // navigate Settings to the exact pane
  const html = dragHelperHtml(kind, dragBundle ? await appIconDataUrl(dragBundle) : null, HELPER_NAME)
  if (!dragHelper || dragHelper.isDestroyed()) {
    dragHelper = new BrowserWindow({
      width: DRAG_HELPER_W,
      height: DRAG_HELPER_H,
      // type:'panel' (macOS NSPanel) + focusable:false = a NON-ACTIVATING panel: clicking or
      // dragging it never activates BlitzOS, so System Settings stays frontmost and the drop target
      // (the permission list) never gets backgrounded mid-drag. This pairing is load-bearing — the
      // exact combination Codex Computer Use's overlay uses (codex-computer-use-tcc-reference.md).
      type: process.platform === 'darwin' ? 'panel' : undefined,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    dragHelper.on('closed', () => {
      dragHelper = null
    })
  }
  const win = dragHelper
  // Float over Settings on every Space (Codex's overlay policy: 'floating' + visibleOnFullScreen).
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setMenuBarVisibility(false)
  // bottom-center of the display under the cursor (where the user is heading — the Settings window)
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  win.setBounds({ x: Math.round(disp.x + (disp.width - DRAG_HELPER_W) / 2), y: Math.round(disp.y + disp.height - DRAG_HELPER_H - 28), width: DRAG_HELPER_W, height: DRAG_HELPER_H })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  win.showInactive() // visible without taking focus from Settings
  startDragPoll(kind)
}

function closeDragHelper(): void {
  if (dragPollTimer) {
    clearInterval(dragPollTimer)
    dragPollTimer = null
  }
  if (dragHelper && !dragHelper.isDestroyed()) dragHelper.close()
  dragHelper = null
}

// Poll the helper's grant for this permission; the moment it lands, relaunch the HELPER (so the grant
// takes effect — the whole point), tear down the drag window, and tell the card to celebrate + advance.
// The helper's status is REAL even in dev (separately signed + LaunchServices-launched → its own
// identity, not inherited), so we poll it even in force mode: it stays ungranted until the user
// genuinely grants it, so there is never a false auto-advance.
let dragPolling = false
function startDragPoll(kind: DragPerm): void {
  if (dragPollTimer) clearInterval(dragPollTimer)
  dragPollTimer = setInterval(async () => {
    if (dragPolling) return
    dragPolling = true
    try {
      const tcc = await computerUseHelper().status()
      if (!computerUseHelper().grantedFor(kind, tcc)) return
      await computerUseHelper().relaunchForGrant() // quit+reopen the HELPER so the grant applies
      closeDragHelper()
      send('onboarding:permission-granted', { kind })
    } finally {
      dragPolling = false
    }
  }, 1500)
}

/** Machine-level pre-board outcomes (userData/preboard.json) — which steps are settled, so the
 *  sequence never re-asks across launches; the board's unlock card stays the re-offer path. */
type PreboardOutcome = 'granted' | 'denied' | 'skipped'
interface PreboardFile {
  v: 1
  steps: Record<string, PreboardOutcome | undefined>
}
const preboardPath = (): string => join(app.getPath('userData'), 'preboard.json')
function readPreboard(): PreboardFile {
  try {
    const f = JSON.parse(readFileSync(preboardPath(), 'utf8')) as PreboardFile
    if (f && f.v === 1 && f.steps) return f
  } catch {
    /* fresh */
  }
  return { v: 1, steps: {} }
}
function markPreboard(step: string, outcome: PreboardOutcome): void {
  const f = readPreboard()
  f.steps[step] = outcome
  try {
    writeFileSync(preboardPath(), JSON.stringify(f, null, 2))
  } catch {
    /* best-effort — worst case the step is offered again */
  }
}

/** Probe Automation (AppleEvents) consent by ASKING: a one-line AppleScript to the detected
 *  browser. The FIRST call raises the macOS consent prompt (attributed to this app — the scan-child
 *  pattern); the promise resolves AFTER the user answers. Returns live window/tab counts as the
 *  immediate visible reward. Errors: -1743 = user denied; -600/-10810 = browser not running (the
 *  tell launches it, so these are rare). */
function requestAutomation(): Promise<{ status: 'granted' | 'denied' | 'unavailable'; windows?: number; tabs?: number; browser?: string }> {
  const browser = detectBrowser()
  if (process.platform !== 'darwin' || !browser) return Promise.resolve({ status: 'unavailable' })
  return new Promise((resolve) => {
    const script = `tell application id "${browser.id}" to count windows`
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 180_000 }, (err, stdout, stderr) => {
      if (err) {
        const denied = /-1743/.test(String(stderr)) || /not allowed/i.test(String(stderr))
        resolve({ status: denied ? 'denied' : 'unavailable', browser: browser.name })
        return
      }
      const windows = parseInt(String(stdout).trim(), 10) || 0
      // tabs are a separate best-effort count (0 windows would make the expression error)
      execFile('/usr/bin/osascript', ['-e', `tell application id "${browser.id}" to count every tab of every window`], { timeout: 20_000 }, (e2, out2) => {
        resolve({ status: 'granted', windows, tabs: e2 ? 0 : parseInt(String(out2).trim(), 10) || 0, browser: browser.name })
      })
    })
  })
}

// ---- the scan child --------------------------------------------------------------------------
function onboardingDir(wsPath: string): string {
  return join(wsPath, '.blitzos', 'onboarding')
}

// Parse a scan stderr line for @progress events → the boot screen.
function feedScanProgress(line: string): void {
  if (line.startsWith('@progress ')) {
    try {
      progress(JSON.parse(line.slice(10)))
    } catch {
      /* malformed progress line — skip */
    }
  }
}

async function runScan(wsPath: string): Promise<ScanJson | null> {
  const dir = onboardingDir(wsPath)
  mkdirSync(dir, { recursive: true })
  const script = join(appRoot(), 'scripts', 'onboarding-scan.mjs')
  const jsonPath = join(dir, 'scan.json')
  if (!existsSync(script)) {
    progress({ phase: 'error', error: 'scan script not found' })
    return null
  }
  // --prompt prepends the interviewer instructions, so context.md = the brain's full briefing
  // (rules + scan) in one read. Missing prompt file (packaged build) just degrades to scan-only.
  const promptMd = join(appRoot(), 'src', 'main', 'blitzos-onboarding.md')
  const args = ['--quiet', '--progress', '--out', join(dir, 'context.md'), '--json', jsonPath, ...(existsSync(promptMd) ? ['--prompt', promptMd] : [])]
  const readOut = (ok: boolean): ScanJson | null => {
    if (!ok) {
      progress({ phase: 'error', error: 'scan failed' })
      return null
    }
    try {
      return JSON.parse(readFileSync(jsonPath, 'utf8')) as ScanJson
    } catch {
      progress({ phase: 'error', error: 'scan output unreadable' })
      return null
    }
  }

  // PREFERRED: run the scan UNDER the helper, so it reads Messages/Mail/Safari with the HELPER's
  // Full Disk Access — BlitzOS itself never needs FDA (the grant that forces a quit-and-reopen). The
  // helper spawns process.execPath (Electron-as-node) as ITS child, so the responsible process is the
  // helper. BlitzOS reads only the scan's output files.
  if (computerUseHelper().available()) {
    const ok = await computerUseHelper().ensure()
    if (ok.ok) {
      const r = await computerUseHelper().runScan(
        { node: process.execPath, script, args, env: { ELECTRON_RUN_AS_NODE: '1' } },
        (line) => feedScanProgress(line)
      )
      if (r.ok) return readOut(true)
      // Helper ran but the scan failed (e.g. FDA not granted on the helper yet) → fall through to a
      // direct attempt (covers a dev machine where BlitzOS itself already has inherited FDA).
      console.error(`[computer-use] helper scan failed (${r.error || 'exit ' + r.exit}); trying direct`)
    }
  }

  // FALLBACK: spawn directly (BlitzOS's own FDA — dev-inherited, or non-macOS). On a packaged build
  // with FDA on the helper this would hit the no-permission scan branch; the helper path above is the
  // real one. Kept so dev + non-mac + helper-absent still produce a board.
  return await new Promise<ScanJson | null>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let buf = ''
    child.stderr.on('data', (c: Buffer) => {
      buf += c.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        feedScanProgress(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
    child.on('error', () => resolve(readOut(false)))
    child.on('exit', (code) => resolve(readOut(code === 0)))
  })
}

// ---- board assembly ---------------------------------------------------------------------------
function readBoard(wsPath: string): BoardFile | null {
  try {
    return JSON.parse(readFileSync(join(onboardingDir(wsPath), 'board.json'), 'utf8')) as BoardFile
  } catch {
    return null
  }
}
function writeBoard(wsPath: string, board: BoardFile): void {
  mkdirSync(onboardingDir(wsPath), { recursive: true })
  writeFileSync(join(onboardingDir(wsPath), 'board.json'), JSON.stringify(board, null, 2))
}

/** Live surfaces + viewport for lattice occupancy (the pinned chat hub already holds a span).
 *  Viewport falls back to the real window content size — planning against DEFAULT_VP when the
 *  renderer hasn't pushed yet would place slots on a lattice BIGGER than the real one (observed:
 *  out-of-bounds rows rendering as a pile). */
function liveStage(): { surfaces: StagedSurface[]; viewport: { w: number; h: number } | null } {
  const st = osGetState() as { surfaces?: StagedSurface[]; viewport?: { w: number; h: number } }
  let viewport = st.viewport || null
  if (!viewport) {
    const win = mainWindow?.()
    if (win && !win.isDestroyed()) {
      const b = win.getContentBounds()
      viewport = { w: b.width, h: b.height }
    }
  }
  return { surfaces: st.surfaces || [], viewport }
}

/** Re-ensure path (cached board): slot the unlock card against the LIVE lattice; a full stage
 *  degrades to a free-floating window (floats above tiles, never overlaps them). */
function spawnUnlockCard(): string {
  const live = liveStage()
  const at = findUnlockSlot(live.surfaces, live.viewport)
  return osCreateSurface({ kind: 'native', component: 'unlock', title: 'Unlock the personal layer', ...(at || {}), props: unlockCardProps(fdaAppName()) })
}

async function seedBoard(wsPath: string, scan: ScanJson): Promise<BoardFile> {
  const board: BoardFile = { v: 1, seededAt: Date.now(), fdaAtSeed: scan.meta.fda, ids: {} }
  // Branch A (FDA granted) seeds the user's hand-tuned fixed layout; Branch B keeps adaptive placement
  // (it gets its own hand-tuned layout once captured).
  const branchA = !!(scan.meta && scan.meta.fda)
  const plan = buildBoardPlan(scan, { ...liveStage(), layout: branchA ? BRANCH_A_LAYOUT : null })
  progress({ phase: 'seeding', cards: plan.length })
  for (const card of plan) {
    // staged cards carry slot/slotStage (tiles on the lattice); parked ones carry x/y/w/h below the stage
    const place = card.slot ? { slot: card.slot, slotStage: card.slotStage } : { x: card.x, y: card.y, w: card.w, h: card.h }
    if (card.native === 'unlock') {
      board.ids.unlock = osCreateSurface({ kind: 'native', component: 'unlock', title: card.title, ...place, props: unlockCardProps(fdaAppName()) })
    } else {
      const widget = getWidgetSource(card.widget as string)
      if (!widget) continue
      board.ids[card.role] = osCreateSurface({ kind: 'srcdoc', html: widget.html, title: card.title, ...place, props: card.props })
    }
    await sleep(170) // staggered assembly — the human watches the board build
  }
  // Branch A: tile the pinned chat hub into its hand-tuned slot (xxl, top-left) so it is EMBEDDED, not
  // free-float covering cards. Persists via the runtime-panel slot (workspace.mjs) so it stays put.
  if (branchA && BRANCH_A_LAYOUT.chat) osUpdateSurface('chat', { slot: BRANCH_A_LAYOUT.chat, slotStage: 0 })
  writeBoard(wsPath, board)
  osGoToPrimary()
  progress({ phase: 'board-ready', fda: scan.meta.fda })
  return board
}

// ---- the interview (P2): resident brain only --------------------------------------------------
interface InterviewState {
  state: 'pending' | 'done'
  startedAt?: number
  finishedAt?: number
  answers?: Record<string, string>
}

function interviewPath(wsPath: string): string {
  return join(onboardingDir(wsPath), 'interview.json')
}
function readInterview(wsPath: string): InterviewState | null {
  try {
    return JSON.parse(readFileSync(interviewPath(wsPath), 'utf8')) as InterviewState
  } catch {
    return null
  }
}
function writeInterview(wsPath: string, st: InterviewState): void {
  mkdirSync(onboardingDir(wsPath), { recursive: true })
  writeFileSync(interviewPath(wsPath), JSON.stringify(st, null, 2))
}

const RESTART_ANCHOR_HEADING = '## Restart anchor'
const RESTART_ANCHOR_RE = /\n## Restart anchor\n[\s\S]*?(?=\n\n## |\n# |$)/

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function profileValue(profile: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = profile.match(new RegExp(`^- ${escaped}:\\s*(.+)$`, 'm'))
  return match ? match[1].trim() : ''
}

function markdownValue(md: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = md.match(new RegExp(`^## ${escaped}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'm'))
  return match ? match[1].trim().split('\n').find((line) => line.trim())?.replace(/^- /, '').trim() || '' : ''
}

export function replaceRestartAnchor(notepad: string, anchor: string): string {
  const base = notepad.trimEnd() || '# Notepad\n\nShared working memory for you and BlitzOS. The agent keeps context and notes here; you can edit it too.'
  if (RESTART_ANCHOR_RE.test(`\n${base}`)) return `\n${base}`.replace(RESTART_ANCHOR_RE, `\n${anchor}`).trimStart()
  return `${base}\n\n${anchor}`
}

export function refreshRestartAnchor(wsPath: string): void {
  const dir = onboardingDir(wsPath)
  const profile = readText(join(dir, 'profile.md'))
  const initiative = readText(join(dir, 'initiative.md'))
  const scope = profileValue(profile, 'Scope') || 'BlitzOS and agent-os testing'
  const autonomy = profileValue(profile, 'Autonomy') || 'Reversible testing and preparation can proceed without waiting.'
  const confirmation = profileValue(profile, 'Confirmation boundary') || profileValue(profile, 'Privacy and accounts') || 'Ask before outward-facing actions, destructive changes, sends, money, credentials, deploys, or account actions.'
  const priority = profileValue(profile, 'Current priority') || 'Make BlitzOS onboarding fast and reliable.'
  const active = markdownValue(initiative, 'Focus') || 'No active initiative recorded yet.'
  const next = markdownValue(initiative, 'Current Next Step') || 'Continue the resident initiative setup, then record the next reversible action.'
  const anchor = [
    RESTART_ANCHOR_HEADING,
    '',
    `- Scope: ${scope}`,
    `- Autonomy: ${autonomy}`,
    `- Confirm before: ${confirmation}`,
    `- Priority: ${priority}`,
    `- Active initiative: ${active}`,
    `- Next reversible action: ${next}`
  ].join('\n')
  const notepadPath = join(wsPath, 'notepad.md')
  writeFileSync(notepadPath, replaceRestartAnchor(readText(notepadPath), anchor))
}

/** Lay down the brain's duty doc + pending state (idempotent; never resets a done interview). */
function ensureInterviewArtifacts(wsPath: string): void {
  const dir = onboardingDir(wsPath)
  mkdirSync(dir, { recursive: true })
  const duty = join(appRoot(), 'src', 'main', 'blitzos-interview.md')
  try {
    if (existsSync(duty)) writeFileSync(join(dir, 'interview.md'), readFileSync(duty, 'utf8'))
  } catch {
    /* template unreadable (packaged build) — the brain still gets the inline boot task */
  }
  if (!readInterview(wsPath)) writeInterview(wsPath, { state: 'pending', startedAt: Date.now() })
}

// Agent CLI detection — resolved through a LOGIN shell because GUI Electron's PATH often lacks
// /opt/homebrew/bin. The resolved absolute path doubles as the agent cmd (index.ts launch backend).
let claudePath: string | null | undefined // undefined = not probed yet
export function claudeCliPath(): string | null {
  if (claudePath !== undefined) return claudePath
  try {
    claudePath = execFileSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 8000 }).trim() || null
  } catch {
    claudePath = null
  }
  return claudePath
}
let codexPath: string | null | undefined
export function codexCliPath(): string | null {
  if (codexPath !== undefined) return codexPath
  try {
    codexPath = execFileSync('/bin/zsh', ['-lc', 'command -v codex'], { encoding: 'utf8', timeout: 8000 }).trim() || null
  } catch {
    codexPath = null
  }
  return codexPath
}

let interviewAgentAvailable = false
export function setInterviewAgentAvailable(available: boolean): void {
  interviewAgentAvailable = !!available
}

const INTERVIEW_BOOT_TASK =
  'THE ONBOARDING INTERVIEW. You are the interviewer. If `.blitzos/onboarding/context.md` or `.blitzos/onboarding/board.json` is not present yet, wait for those files instead of asking from generic assumptions. Then read `.blitzos/onboarding/interview.md`, skim `.blitzos/onboarding/context.md` only long enough to ask the first high-value choice-card question immediately, and continue the interview from the human answers. Ask at most 4 multiple-choice questions TOTAL, plus one open voice sample, then write `.blitzos/onboarding/profile.md` and mark `.blitzos/onboarding/interview.json` done. Onboarding will write the compact Notepad restart anchor after completion. If the chat already shows prior Q&A, continue it, do not restart.'

const RESIDENT_INITIATIVE_BOOT_TASK =
  'THE RESIDENT INITIATIVE DUTY. The onboarding interview is done, so do not sit in passive watch mode. Read the Notepad restart anchor first if it exists, then read `.blitzos/onboarding/profile.md`, `.blitzos/onboarding/board.json`, `.blitzos/onboarding/initiative.md` if it exists, and the recent chat. Then act on the initiative gradient from the onboarding plan: propose useful work the user did not explicitly ask for, and start one safe reversible initiative immediately. If no current initiative is recorded, send one short chat message with 2 or 3 concrete initiatives grounded in the profile, say which one you are starting now, write `.blitzos/onboarding/initiative.md` with the active initiative and next step, then make visible progress on that initiative. If an initiative is already recorded or visible, continue it instead of re-proposing. Use quiet surfaces, action items, or board updates, not modals. Stay inside the user boundaries in the profile: reversible testing and preparation can proceed; ask before outward-facing actions, destructive changes, sends, money, credentials, deploys, or account actions. Do not merely say you are watching. Keep polling `/events`, but use idle time to originate, execute, and update the case file.'

/** index.ts threads this into session '0': interview first, then the resident initiative duty. */
export function interviewBootTask(): string | null {
  try {
    const st = readInterview(osWorkspaceContext().workspace_path)
    if (st && st.state === 'pending') {
      return INTERVIEW_BOOT_TASK
    }
    if (st && st.state === 'done') {
      refreshRestartAnchor(osWorkspaceContext().workspace_path)
      return RESIDENT_INITIATIVE_BOOT_TASK
    }
  } catch {
    /* no workspace yet */
  }
  return null
}

// Restore the brain to full thinking effort once the interview is done: poll interview.json and, on
// the pending to done flip, re-exec agent '0' ONCE. The next bootstrap carries the resident initiative
// duty, not the interview duty, so it no longer caps effort. Single-shot; unref'd so it never holds
// the process open.
let interviewDoneTimer: ReturnType<typeof setInterval> | null = null
function watchInterviewDone(wsPath: string): void {
  if (interviewDoneTimer) return
  interviewDoneTimer = setInterval(() => {
    const st = readInterview(wsPath)
    if (st && st.state === 'done') {
      if (interviewDoneTimer) clearInterval(interviewDoneTimer)
      interviewDoneTimer = null
      refreshRestartAnchor(wsPath)
      osRestartBrain('0') // resident phase resumes at the default (max) effort
    }
  }, 4000)
  if (interviewDoneTimer.unref) interviewDoneTimer.unref()
}

function startInterviewPhase(wsPath: string): void {
  ensureInterviewArtifacts(wsPath)
  const st = readInterview(wsPath)
  if (!st || st.state !== 'pending') return
  if (!interviewAgentAvailable) {
    progress({ phase: 'interview-error', tier: 'brain', reason: 'missing-cli' })
    osSay("I can't start the real onboarding interview because no agent backend is available on this Mac. Install or fix Codex or Claude Code, then relaunch BlitzOS.")
    return
  }
  // The selected agent backend owns the interview from the first question. No deterministic opener,
  // no static fallback: if the backend is quota-blocked or auth-broken, the terminal shows the real failure.
  osKickBrain('0')
  progress({ phase: 'interview', tier: 'brain' })
  watchInterviewDone(wsPath)
}

// ---- FDA unlock: poll → rescan → deepen --------------------------------------------------------
// FDA now lives on the HELPER (it forces a quit-and-reopen, so it can't sit on BlitzOS). The effective
// FDA = the helper's fullDisk when the helper is available, else BlitzOS's own (dev-inherited / the
// legacy path). The scan reads files through whichever holds it.
async function fdaGrantedEffective(): Promise<boolean> {
  if (computerUseHelper().available()) {
    const ok = await computerUseHelper().ensure()
    if (ok.ok) return !!(await computerUseHelper().status())?.fullDisk
  }
  return hasFDA()
}
function startFdaPoll(wsPath: string): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    const board = readBoard(wsPath)
    if (!board || board.unlockDismissed) {
      stopFdaPoll()
      return
    }
    void fdaGrantedEffective().then((granted) => {
      if (!granted || !pollTimer) return
      stopFdaPoll()
      void deepen(wsPath)
    })
  }, POLL_MS)
}
function stopFdaPoll(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** FDA just landed: re-scan (Branch A+B now) and visibly deepen the board in place. */
async function deepen(wsPath: string): Promise<void> {
  const board = readBoard(wsPath)
  if (!board) return
  if (board.ids.unlock) osUpdateSurface(board.ids.unlock, { props: { state: 'scanning' } })
  const scan = await runScan(wsPath)
  if (!scan || !scan.meta.fda) {
    // grant probe raced a revoke, or the rescan failed — restore the card and keep polling
    if (board.ids.unlock) osUpdateSurface(board.ids.unlock, { props: { state: 'locked' } })
    startFdaPoll(wsPath)
    return
  }
  for (const card of buildBoardPlan(scan)) {
    if (card.role === 'unlock') continue // its lifecycle is the granted→retire arc below
    const id = board.ids[card.role]
    if (id) osUpdateSurface(id, { props: card.props })
  }
  if (board.ids.unlock) {
    const unlockId = board.ids.unlock
    osUpdateSurface(unlockId, { props: { state: 'granted' } })
    await sleep(2400)
    osCloseSurface(unlockId)
    delete board.ids.unlock
  }
  writeBoard(wsPath, board)
  osSay('Full Disk Access granted. The personal layer is on the board: real screen time, Messages cadence, Mail correspondents, Safari.')
  progress({ phase: 'deepened' })
}

// ---- entry ------------------------------------------------------------------------------------
async function start(): Promise<{ ok: boolean; cached?: boolean }> {
  if (starting) return { ok: true }
  starting = true
  try {
    osCreateWorkspace(WS_NAME) // idempotent: an already-exists error result is fine
    const sw = await osSwitchWorkspace(WS_NAME)
    if (!sw.ok) {
      progress({ phase: 'error', error: sw.error || 'workspace switch failed' })
      return { ok: false }
    }
    const wsPath = osWorkspaceContext().workspace_path
    ensureInterviewArtifacts(wsPath) // make the standing duty visible before any boot-resume of agent 0
    const prior = readBoard(wsPath)
    if (prior && Object.keys(prior.ids).length) {
      // Board already seeded (a restart mid-onboarding, or dev re-run): don't re-scan or duplicate —
      // surfaces are file-backed and just rehydrated with the workspace. Re-ensure the unlock card
      // (native = runtime-only, it does not persist) and the poll, then hand straight to the canvas.
      const fdaNow = await fdaGrantedEffective()
      if (!fdaNow && !prior.unlockDismissed) {
        prior.ids.unlock = spawnUnlockCard()
        writeBoard(wsPath, prior)
        startFdaPoll(wsPath)
      }
      osGoToPrimary()
      progress({ phase: 'board-ready', cached: true, fda: fdaNow })
      startInterviewPhase(wsPath) // resume a half-finished interview (or no-op when done)
      return { ok: true, cached: true }
    }
    const scan = await runScan(wsPath)
    if (!scan) return { ok: false } // 'error' phase already sent — renderer degrades to plain desktop
    const board = await seedBoard(wsPath, scan)
    if (!scan.meta.fda && !board.unlockDismissed) startFdaPoll(wsPath)
    startInterviewPhase(wsPath) // P2: the resident brain's first duty
    return { ok: true }
  } finally {
    starting = false
  }
}

export function registerOnboarding(getWindow: () => BrowserWindow | null): void {
  mainWindow = getWindow
  ipcMain.handle('onboarding:start', () => start())
  ipcMain.handle('onboarding:fda-status', async () => ({ fda: await fdaGrantedEffective(), appName: fdaAppName() }))
  ipcMain.handle('onboarding:open-fda-settings', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
    return { ok: true, appName: fdaAppName() }
  })
  ipcMain.handle('onboarding:preboard-state', async () => {
    // Pre-warm the Computer Use helper the moment onboarding opens: install + launch it (LaunchServices
    // → its OWN TCC identity) in the background so by the time the user reaches the Accessibility /
    // Screen Recording step it is already up and listed. Fire-and-forget; logs the outcome so the
    // helper chain is verifiable from boot without any click. (No prompt is raised until request().)
    if (computerUseHelper().available()) {
      void computerUseHelper()
        .ensure()
        .then((r) => console.log(`[computer-use] prewarm ensure → ${JSON.stringify(r)} connected=${computerUseHelper().connected()}`))
        .catch((e) => console.error('[computer-use] prewarm failed:', (e as Error)?.message))
    } else {
      console.error('[computer-use] prewarm skipped — helper bundle not available (build native/computer-use-helper)')
    }
    return {
    // BLITZ_PREBOARD_FORCE (dev only): show EVERY step from zero regardless of real grant state.
    // Needed in dev because FDA is attributed to the responsible process — the TERMINAL that ran
    // `npm run dev`, whose grant the Electron binary inherits — so hasFDA() reads true and the FDA
    // step would self-skip (the tccutil reset in fresh-onboarding-dev.sh is a no-op in dev, correct
    // only for a packaged BlitzOS.app). `forced` tells the renderer to skip the grant poll so the
    // step stays up for visual testing; the drag + open-settings actions are still real.
    forced: forcePreboard(),
    steps: forcePreboard() ? {} : readPreboard().steps,
    // All three (fda, accessibility, screen) live on the HELPER. We don't query it at state time;
    // report false and let the settled-steps marker skip a completed grant on later runs, while the
    // step's live poll auto-advances if it's granted-but-unmarked the instant the helper is up.
    fda: false,
    accessibility: false,
    screen: false,
    appName: fdaAppName(),
    browser: detectBrowser(),
    canDrag: !!appBundlePath(),
    appIcon: await appIconDataUrl()
    }
  })
  ipcMain.handle('onboarding:preboard-mark', (_e, step: string, outcome: 'granted' | 'denied' | 'skipped') => {
    if (typeof step === 'string' && step && ['granted', 'denied', 'skipped'].includes(outcome)) markPreboard(step, outcome)
    return { ok: true }
  })
  // The Codex drag: a native file drag of a .app bundle the Settings list accepts as a drop. The
  // bundle is whatever the current step targets (currentDragBundle): BlitzOS for FDA, the separate
  // CU helper for Accessibility/Screen Recording. Must be ipcMain.on (startDrag rides the sender's
  // drag gesture, not an invoke roundtrip).
  ipcMain.on('onboarding:preboard-drag', (e) => {
    // Drag EXACTLY currentDragBundle — never fall back to the BlitzOS app. For the computer-use
    // pair currentDragBundle is the HELPER (or null if unavailable); falling back to BlitzOS here
    // is precisely what put Electron in the list and caused the quit-and-reopen.
    const bundle = currentDragBundle
    console.log(`[computer-use] DRAG fired → file=${bundle ?? '(none — suppressed)'}`)
    if (!bundle) return
    void app.getFileIcon(bundle, { size: 'normal' }).then((icon) => {
      try {
        e.sender.startDrag({ file: bundle, icon })
      } catch {
        /* drag raced a navigation — harmless */
      }
    })
  })
  // Open a drag-list permission step (FDA / Accessibility / Screen Recording): navigate Settings to
  // the pane + raise the floating drag-helper over it + poll until granted (→ permission-granted).
  ipcMain.handle('onboarding:open-permission-drag', async (_e, kind: DragPerm) => {
    console.log(`[computer-use] open-permission-drag kind=${kind}`)
    if (kind !== 'fda' && kind !== 'accessibility' && kind !== 'screen') return { ok: false }
    await openDragHelper(kind)
    return { ok: true, appName: fdaAppName() }
  })
  ipcMain.handle('onboarding:close-permission-drag', () => {
    closeDragHelper()
    return { ok: true }
  })
  ipcMain.handle('onboarding:request-automation', () => requestAutomation())
  ipcMain.handle('onboarding:open-automation-settings', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
    return { ok: true }
  })
  ipcMain.handle('onboarding:dismiss-unlock', () => {
    const wsPath = osWorkspaceContext().workspace_path
    const board = readBoard(wsPath)
    if (board) {
      board.unlockDismissed = true
      if (board.ids.unlock) {
        osCloseSurface(board.ids.unlock)
        delete board.ids.unlock
      }
      writeBoard(wsPath, board)
    }
    stopFdaPoll()
    return { ok: true }
  })
  app.on('before-quit', () => {
    stopFdaPoll()
    closeDragHelper()
  })
}
