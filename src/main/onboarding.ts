// Onboarding director (V1, chat-only): the DETERMINISTIC half of first-run. No LLM anywhere in this
// file. It runs the local scan (scripts/onboarding-scan.mjs) as a child process, streams its real
// progress to the boot screen, creates + switches to the onboarding workspace, and hands off to the
// primary chat agent (the interview boot task). There is NO seeded widget board in V1 — the scan's
// context.md is the chat agent's primer; the whole flow happens in one agent chat.
//
import { app, ipcMain, shell, screen, BrowserWindow, nativeImage } from 'electron'
import { execFileSync, execFile, spawn } from 'node:child_process'

// Repo root in dev; app.asar.UNPACKED in a packaged build — the scan runs as a PLAIN-NODE child
// (no asar fs), so electron-builder.yml ships scripts/onboarding-scan.mjs + the prompt .md files
// asarUnpack'd and we resolve them there.
const appRoot = (): string => app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { osCreateWorkspace, osSwitchWorkspace, osWorkspaceContext, osGoToPrimary, osSay, osKickBrain, osClearBrainContext } from './osActions'
import { computerUseHelper } from './computer-use-helper'
import { importGoogleSignin, importSources } from './browser-import'

// The scan child writes scan.json; the director only checks it produced output (its rich fields feed
// the chat agent via context.md, not this file), so a loose shape is enough here.
interface ScanJson {
  meta: { fda: boolean; [k: string]: unknown }
  [k: string]: unknown
}

const WS_NAME = 'Home' // single workspace: onboarding runs in the default Home workspace (no separate case-file)
const ONBOARDING_CHAT_ENABLED = process.env.BLITZ_ONBOARDING_CHAT === '1'

let mainWindow: (() => BrowserWindow | null) | null = null
let starting = false

const send = (channel: string, payload: unknown): void => {
  const win = mainWindow?.()
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
const progress = (p: Record<string, unknown>): void => send('onboarding:progress', p)

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

/** First on-disk Blitz brand icon (dev source tree or packaged resources). */
function blitzIconFile(): string | null {
  const candidates = [
    join(appRoot(), 'src/renderer/src/assets/blitz-app-icon.png'),
    join(appRoot(), 'src/renderer/src/assets/blitz-dock-icon.png'),
    join(process.resourcesPath || '', 'blitz-dock-icon.png')
  ]
  for (const file of candidates) {
    try {
      if (file && existsSync(file)) return file
    } catch {
      /* try next */
    }
  }
  return null
}

async function blitzVisualIconDataUrl(): Promise<string | null> {
  const file = blitzIconFile()
  if (file) {
    try {
      return `data:image/png;base64,${readFileSync(file).toString('base64')}`
    } catch {
      /* fall through to the system app icon */
    }
  }
  return appIconDataUrl()
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

// The user's DEFAULT browser (LaunchServices https handler), mapped to a known BROWSERS entry when possible.
// GATES the Chrome "Allow JavaScript from Apple Events" step: the renderer shows it only when
// browser.id === 'com.google.Chrome', so merely having Chrome INSTALLED (what detectBrowser reports) must not
// trigger it — the AppleScript Chrome bridge is only worth setting up when Chrome is the actual default.
// Reads the BINARY plist via plutil→json; falls back to detectBrowser() if the default can't be read.
function defaultBrowser(): { id: string; name: string } | null {
  try {
    const p = join(process.env.HOME || '', 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist')
    if (!existsSync(p)) return detectBrowser()
    const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', p], { timeout: 4000 }).toString()) as { LSHandlers?: Array<Record<string, unknown>> }
    const h = (json.LSHandlers || []).find((x) => x.LSHandlerURLScheme === 'https')
    const def = h && typeof h.LSHandlerRoleAll === 'string' ? h.LSHandlerRoleAll : null
    if (def) {
      const b = BROWSERS.find((x) => x.id.toLowerCase() === def.toLowerCase())
      return b ? { id: b.id, name: b.name } : { id: def, name: def }
    }
  } catch { /* default unreadable — fall through */ }
  return detectBrowser()
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

function dragHelperHtml(kind: DragPerm, iconUrl: string | null): string {
  // Self-contained; the window shares the app preload, so the tile calls window.agentOS.onboarding
  // .preboardDrag() (→ main startDrag of the bundle). CSP locks it to inline + data: only.
  const label = PERM_LABEL[kind]
  const icon = iconUrl ? `<img src="${iconUrl}" alt="" draggable="false">` : '<span class="fallback">B</span>'
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; overflow:hidden; -webkit-user-select:none; user-select:none; font-family:-apple-system,system-ui,sans-serif; }
  .h { height:100%; display:flex; align-items:center; gap:18px; padding:0 22px; box-sizing:border-box;
       background:rgba(245,245,247,0.86); border-radius:16px; border:1px solid rgba(0,0,0,0.10);
       -webkit-backdrop-filter:saturate(1.3) blur(20px); backdrop-filter:saturate(1.3) blur(20px);
       box-shadow:0 8px 30px rgba(0,0,0,0.22); }
  @media (prefers-color-scheme: dark){ .h{ background:rgba(40,42,46,0.86); border-color:rgba(255,255,255,0.12); color:#f5f5f7; } }
  .drag { position:relative; width:140px; height:92px; flex:0 0 auto; }
  .tile { position:absolute; left:10px; top:24px; width:60px; height:60px; display:grid; place-items:center; cursor:grab;
    border-radius:17px; background:linear-gradient(145deg,rgba(255,255,255,.18),rgba(255,255,255,.04));
    box-shadow:0 14px 24px rgba(0,0,0,.24), inset 0 1px 0 rgba(255,255,255,.22);
    animation:dragIconHint 1.65s cubic-bezier(.22,1,.36,1) infinite; transition:transform .12s ease; }
  .tile:hover { transform:translateY(-16px) scale(1.07); animation-play-state:paused; } .tile:active { cursor:grabbing; }
  .tile img { width:56px; height:56px; pointer-events:none; border-radius:14px; }
  .fallback { width:52px; height:52px; display:grid; place-items:center; border-radius:13px; background:#0a84ff; color:white; font-weight:800; font-size:28px; }
  .ghost { position:absolute; left:14px; top:28px; width:52px; height:52px; border-radius:15px; border:1px dashed rgba(255,255,255,.34); opacity:.5; }
  .arrow { position:absolute; left:94px; top:7px; width:28px; height:64px; color:#0a84ff; animation:dragArrowHint 1.65s cubic-bezier(.22,1,.36,1) infinite; }
  .arrow:before { content:''; position:absolute; left:13px; top:16px; width:2px; height:42px; border-radius:999px; background:currentColor; }
  .arrow:after { content:''; position:absolute; left:7px; top:8px; width:12px; height:12px; border-top:2px solid currentColor; border-left:2px solid currentColor; transform:rotate(45deg); }
  .c { min-width:0; color:inherit; font-size:17px; line-height:1.2; font-weight:750; letter-spacing:-0.01em; }
  @keyframes dragIconHint {
    0%,62%,100% { transform:translateY(0) scale(1); }
    32% { transform:translateY(-16px) scale(1.04); }
  }
  @keyframes dragArrowHint {
    0%,62%,100% { opacity:.38; transform:translateY(0); }
    32% { opacity:1; transform:translateY(-6px); }
  }
</style></head><body>
<div class="h">
  <div class="drag" aria-hidden="true"><span class="ghost"></span><span class="tile" id="t" draggable="true">${icon}</span><span class="arrow"></span></div>
  <div class="c">Drag the BlitzOS Automation icon into ${label}</div>
</div>
<script>
  document.getElementById('t').addEventListener('dragstart', function(e){
    e.preventDefault();
    try { window.agentOS && window.agentOS.onboarding && window.agentOS.onboarding.preboardDrag(); } catch (_) {}
  });
  // Hovering this helper window = the user is heading to grab the icon, so tell main to hide the island and reveal
  // the full Settings window to drop into. Main re-shows the island when the permission is granted.
  document.body.addEventListener('mouseenter', function(){
    try { window.agentOS && window.agentOS.onboarding && window.agentOS.onboarding.dragHover(); } catch (_) {}
  });
</script></body></html>`
}

// What the floating tile drags into the Settings list. FDA → the BlitzOS app (its own grant). The
// computer-use pair → the SEPARATE helper bundle, so the grant + the quit-and-reopen land on it,
// never on BlitzOS (plans/blitzos-computer-use-helper.md). Set per openDragHelper, read by the drag IPC.
let currentDragBundle: string | null = null
// The drag-preview NativeImage, precomputed from currentDragBundle's OWN icon in openDragHelper so the synchronous
// startDrag gesture has a crisp ghost ready (app.getFileIcon on the helper renders blank under the cursor).
let currentDragIcon: Electron.NativeImage | null = null

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
      // No request(kind) here. The helper's request API raises the macOS "would like to control/record
      // this computer" prompt, which is redundant and confusing once the user has dragged the helper
      // into the list. Listing comes from the DRAG (a dropped .app is added to the pane on macOS 13+);
      // grant detection is the status poll below — both independent of that prompt.
      // TODO(older-macOS): pre-Sonoma Screen Recording sometimes lists an app only after it calls the
      // capture API once; if the helper fails to appear there on an older OS, gate a one-time
      // computerUseHelper().request('screen') behind a version check. On the current target it lists via drag.
      dragBundle = computerUseHelper().installedAppPath()
      usingHelper = true
    }
  }
  // NEVER fall back to dragging BlitzOS — granting BlitzOS is exactly the quit-and-reopen we avoid.
  if (!usingHelper) console.error(`[computer-use] HELPER UNAVAILABLE for ${kind} (available=${avail}) — drag suppressed; build native/computer-use-helper`)
  currentDragBundle = dragBundle
  void shell.openExternal(PERM_DEEPLINK[kind]) // navigate Settings to the exact pane
  // Show the EXACT icon of the bundle being dragged, so the floating tile, the native drag ghost, and the row that
  // lands in System Settings all match: the CU helper renders its own "BlitzOS Automation" gear (BlitzOS itself the
  // loop, for the vestigial FDA step). Read from the bundle's own .icns (appIconDataUrl), falling back to the Blitz
  // brand mark only if that fails. The dragged FILE stays currentDragBundle so the grant lands on the right app.
  const iconUrl = (currentDragBundle ? await appIconDataUrl(currentDragBundle) : null) || (await blitzVisualIconDataUrl())
  currentDragIcon = iconUrl ? nativeImage.createFromDataURL(iconUrl).resize({ width: 64, height: 64 }) : null
  const html = dragHelperHtml(kind, iconUrl)
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
  win.setHiddenInMissionControl(true) // overlay chrome, not a real app window — keep it out of Mission Control / Exposé
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
  // The drag helper is gone (granted, skipped, or step left), so restore the island if it was veiled on hover.
  send('os:island-veil', false)
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
      closeDragHelper() // also unveils the island (the helper is gone)
      send('onboarding:permission-granted', { kind })
    } finally {
      dragPolling = false
    }
  }, 1500)
}

// ---- Chrome "Allow JavaScript from Apple Events" step (right after the TCC permissions) -----------
// BlitzOS drives the user's Chrome extension-free through the Apple-Events JS bridge
// (connection-chrome-applescript-link.mjs). That bridge is OFF until the user ticks Chrome ▸ View ▸
// Developer ▸ "Allow JavaScript from Apple Events" once. There is no API to flip it, so we make the
// final click trivial: programmatically open View ▸ Developer (so the row is visible), float a small
// helper window pointing at it, and let the user tick the single row. Everything else is programmatic.
//
// The helper is a SEPARATE non-activating panel from the TCC drag-helper (different content + a different
// poll), constructed identically so it behaves the same over a frontmost Chrome. Reused per (re)open.
let chromeJsHelper: BrowserWindow | null = null
let chromeJsPollTimer: ReturnType<typeof setInterval> | null = null
let chromeJsMemProbeTimer: ReturnType<typeof setInterval> | null = null
let chromeJsWindowPoller: ReturnType<typeof setInterval> | null = null
let chromeJsOpening = false
// True once a flow session is LIVE (menu navigated + helper shown + polling). Auto-open re-entry while
// this is true is a no-op (idempotency), so React StrictMode / island remounts never re-navigate the menu.
let chromeJsActive = false
// Debounced teardown timer: the renderer's close fires on every unmount (incl. StrictMode's throwaway one),
// so we defer the actual teardown and cancel it if a re-open lands within the window — no close→open thrash.
let chromeJsTeardownTimer: ReturnType<typeof setTimeout> | null = null
// fs.watch handles on the OFF-at-snapshot profile dirs — fire the instant Chrome rewrites Preferences.
let chromeJsWatchers: FSWatcher[] = []
// Monotonically-incremented on each close/cancel so any in-flight openChromeJsPhase2 can detect it
// was superseded and exit without showing the helper or re-activating Chrome.
let chromeJsGeneration = 0
const CHROME_JS_HELPER_W = 400
const CHROME_JS_HELPER_H = 92
const CHROME_JS_TEARDOWN_DEBOUNCE_MS = 600

/** Returns the number of open Chrome windows (0 if Chrome is not running or has no windows). */
// "Is Chrome running?" WITHOUT an Apple Event. The old version osascript'd `tell "Google Chrome" to count
// windows`, which raised an Automation consent ("BlitzOS wants to control Chrome") at onboarding. pgrep the
// main Chrome process instead (no AE, no prompt). The caller only branches on ===0 (launch Chrome) vs >0
// (proceed to the instruction card), so an exact window count is no longer needed now that the System-Events
// menu-arrow (openChromeJsRow) is gone and the step just shows manual instructions.
function countChromeWindows(): Promise<number> {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', 'Google Chrome'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(0) // pgrep exits 1 when there's no match → Chrome not running
      resolve(String(stdout).trim().split('\n').filter(Boolean).length)
    })
  })
}

function stopChromeWindowPoll(): void {
  if (chromeJsWindowPoller) {
    clearInterval(chromeJsWindowPoller)
    chromeJsWindowPoller = null
  }
}

/** The helper card content. `pointed` (the Developer row's screen rect was read) → a LEFT-pointing arrow on
 *  the card's left edge + the short "Click ..." copy; the card sits just right of the row so the arrow lands
 *  on it. Not pointed (menu could not be opened/read) → no arrow + a manual instruction, so we never point an
 *  arrow at nothing. `iconUrl` — BlitzOS brand icon as a data URL; shown on the left so the user knows this
 *  popup is from Blitz (falls back to a "B" circle). Same frosted chrome + CSP as the drag helper. */
function chromeJsHelperHtml(pointed: boolean, iconUrl: string | null): string {
  const arrow = pointed ? '<div class="arrow" aria-hidden="true"></div>' : ''
  const copy = pointed
    ? 'Click &ldquo;Allow JavaScript from Apple Events&rdquo;'
    : 'In Chrome, open View &rsaquo; Developer and tick &ldquo;Allow JavaScript from Apple Events&rdquo;'
  const icon = iconUrl ? `<img src="${iconUrl}" alt="" draggable="false">` : '<span class="fallback">B</span>'
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; height:100%; overflow:hidden; -webkit-user-select:none; user-select:none; font-family:-apple-system,system-ui,sans-serif; }
  /* SOLID near-black card (no transparency / no blur — it must read clearly over Chrome's menu), with a bright cool
     rim, a soft breathing bloom, and a glint that sweeps the border so it pops next to the menu row. */
  .h { position:relative; height:100%; display:flex; align-items:center; gap:14px; padding:0 18px; box-sizing:border-box;
       background:#0c0e13; border-radius:18px; color:#f4f6fb;
       box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), 0 12px 36px rgba(0,0,0,0.55); }
  /* the shining glint sweeping AROUND the card (a 2px gradient ring, masked to the border). */
  .h:before { content:''; position:absolute; inset:-2px; border-radius:20px; padding:2px; pointer-events:none;
       background:linear-gradient(115deg, rgba(74,168,255,0) 22%, rgba(120,190,255,0.95) 42%, rgba(74,168,255,0) 62%);
       background-size:260% 100%;
       -webkit-mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite:xor;
       mask:linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite:exclude;
       animation:chromeGlint 2.4s linear infinite; }
  /* a soft outer bloom that breathes. */
  .h:after { content:''; position:absolute; inset:0; border-radius:18px; pointer-events:none; animation:chromeBloom 2.4s ease-in-out infinite; }
  .icon { flex:0 0 auto; width:48px; height:48px; display:grid; place-items:center; }
  .icon img { width:48px; height:48px; border-radius:12px; pointer-events:none; box-shadow:0 2px 12px rgba(0,0,0,0.5); }
  .fallback { width:48px; height:48px; display:grid; place-items:center; border-radius:12px;
    background:linear-gradient(150deg,#2a93ff,#0066d6 60%,#05060a); color:#fff; font-weight:800; font-size:22px; }
  /* a big LEFT-pointing arrow toward the menu row (the card sits just to the row's right), sliding continuously. */
  .arrow { position:relative; width:46px; height:30px; flex:0 0 auto; color:#4aa8ff; filter:drop-shadow(0 0 7px rgba(74,168,255,0.75)); animation:chromeArrowHint 1.45s cubic-bezier(.4,0,.2,1) infinite; }
  .arrow:before { content:''; position:absolute; left:6px; top:13px; width:36px; height:3px; border-radius:999px; background:currentColor; }
  .arrow:after { content:''; position:absolute; left:2px; top:7px; width:15px; height:15px; border-bottom:3px solid currentColor; border-left:3px solid currentColor; transform:rotate(45deg); }
  .c { min-width:0; flex:1; color:#f4f6fb; font-size:15px; line-height:1.25; font-weight:700; letter-spacing:-0.01em; }
  @keyframes chromeArrowHint { 0%,70%,100% { opacity:.5; transform:translateX(0); } 35% { opacity:1; transform:translateX(-10px); } }
  @keyframes chromeGlint { 0% { background-position:130% 0; } 100% { background-position:-130% 0; } }
  @keyframes chromeBloom { 0%,100% { box-shadow:0 0 22px 2px rgba(40,130,255,0.14); } 50% { box-shadow:0 0 36px 7px rgba(40,130,255,0.32); } }
</style></head><body>
<div class="h">
  ${arrow}
  <div class="c">${copy}</div>
  <div class="icon" aria-hidden="true">${icon}</div>
</div></body></html>`
}

/** Open Chrome's View ▸ Developer submenu and read the SCREEN RECT of the "Allow JavaScript from Apple
 *  Events" row, so the helper card can point its arrow straight at it. Returns {x,y,w,h} (top-left + size)
 *  or null on failure (helper absent / not ready, no grant, Chrome closed, menu would not open).
 *
 *  Driving a native menu is a System Events action that needs the Accessibility grant on the RUNNING app.
 *  dev Electron does not hold it (a direct osascript silently failed to open the menu — the user's bug), so
 *  we run the AppleScript THROUGH the computer-use helper: computerUseHelper().runScan spawns osascript as
 *  the helper's child, so it inherits the HELPER's Accessibility/Automation grant (the helper is a
 *  LaunchServices app with its own TCC identity). The helper discards the child's stdout but forwards its
 *  stderr, so osascript returns the rect via `log`, which we parse off that line. Match by `name contains
 *  "Apple Events"` to stay robust to the exact label. */
async function openChromeJsRow(): Promise<{ x: number; y: number; w: number; h: number } | null> {
  if (process.platform !== 'darwin') return null
  // Runs THROUGH the helper (runScan spawns osascript), so the System-Events Automation grant lands on the
  // helper, not BlitzOS. That grant is obtained up-front in the permission step (the "System Events" automation
  // row), so by the time we reach here this is silent — no Automation consent.
  const applescript = [
    'tell application "Google Chrome" to activate',
    'delay 0.25',
    'tell application "System Events" to tell process "Google Chrome"',
    '  key code 53', // dismiss any menu already open, so navigation always starts from a clean slate
    '  delay 0.12',
    '  set out to ""',
    '  try',
    '    click menu bar item "View" of menu bar 1',
    '    delay 0.18',
    '    click menu item "Developer" of menu 1 of menu bar item "View" of menu bar 1',
    '    delay 0.18',
    '    set theRow to (first menu item of menu 1 of menu item "Developer" of menu 1 of menu bar item "View" of menu bar 1 whose name contains "Apple Events")',
    '    set p to position of theRow',
    '    set s to size of theRow',
    '    set out to ((item 1 of p) as integer as string) & "," & ((item 2 of p) as integer as string) & "," & ((item 1 of s) as integer as string) & "," & ((item 2 of s) as integer as string)',
    '  end try',
    'end tell',
    'log ("BLITZROW " & out)'
  ].join('\n')
  if (!computerUseHelper().available()) return null
  if (!(await computerUseHelper().ensure()).ok) return null
  let row: { x: number; y: number; w: number; h: number } | null = null
  await computerUseHelper().runScan(
    { node: '/usr/bin/osascript', script: '-e', args: [applescript], env: {} },
    (line: string) => {
      const m = line.match(/BLITZROW\s+(-?\d+),(-?\d+),(\d+),(\d+)/)
      if (m) row = { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) }
    },
    12_000
  )
  return row
}

// Trigger + detect a helper-held Automation grant for ONE target (System Events, or the user's default browser),
// driven by the "Enable" button on the automation permission rows. The helper runs a benign Apple Event via
// runScan-osascript, so the grant attaches to the HELPER (not BlitzOS): the FIRST send raises the macOS consent
// ("BlitzOS wants to control X") and blocks until the user chooses; thereafter it's silent. ok=granted (osascript
// exit 0), denied=-1743/non-zero. No new helper Swift — reuses the osascript path openChromeJsRow already uses.
async function requestHelperAutomation(target: 'systemevents' | 'browser', bundleId?: string): Promise<{ granted: boolean; error?: string }> {
  if (process.platform !== 'darwin') return { granted: false, error: 'macOS only' }
  if (!computerUseHelper().available()) return { granted: false, error: 'helper unavailable' }
  if (!(await computerUseHelper().ensure()).ok) return { granted: false, error: 'helper not connected' }
  // Use a CONTROL op, NOT "get name". macOS answers "get name" WITHOUT requiring the Automation grant, so it
  // exited 0 and the row marked granted with no prompt — then the real menu-click prompted later (the bug the
  // user hit). count-login-items / count-windows genuinely require the grant: a not-yet-granted target BLOCKS on
  // the consent dialog, then exits 0 (allowed) or -1743 (denied). The helper reports ok=(exit==0), so r.ok is the
  // real outcome. Login items needs ONLY Automation (no Accessibility), so the System-Events probe is independent
  // of the Accessibility row's order.
  // For 'browser', target the SPECIFIC app when a bundleId is given (so "Grant" on the Safari row probes Safari, not
  // whatever the default browser is). `count windows` is a real CONTROL op, so an ungranted target BLOCKS on the
  // consent dialog then exits 0 (allowed) / -1743 (denied) — i.e. the prompt actually fires.
  const tell = target === 'systemevents'
    ? 'tell application "System Events" to get the name of every login item'
    : (() => { const id = bundleId || defaultBrowser()?.id; return id ? `tell application id "${id}" to count windows` : '' })()
  if (!tell) return { granted: false, error: 'no browser' }
  const r = await computerUseHelper().runScan({ node: '/usr/bin/osascript', script: '-e', args: [tell], env: {} }, () => {}, 120_000)
  return { granted: !!r.ok, error: r.ok ? undefined : r.error }
}

/** The macOS bundle id each Automation grant targets — for the no-prompt status probe below. */
const AUTOMATION_TARGET: Record<string, string> = {
  'automation:systemevents': 'com.apple.systemevents',
  'automation:chrome': 'com.google.Chrome',
  'automation:safari': 'com.apple.Safari'
}

/** True ONLY when the helper ALREADY holds this Automation grant — checked with no prompt (the helper's
 *  AEDeterminePermissionToAutomateTarget). 'denied'/'undetermined'/'unknown' (helper down, or the target app
 *  isn't running so macOS can't report) all return false, so the caller still attempts the real prompting path. */
async function automationAlreadyGranted(grant: string): Promise<boolean> {
  const bundleId = AUTOMATION_TARGET[grant]
  if (!bundleId) return false
  if (!computerUseHelper().available()) return false
  if (!(await computerUseHelper().ensure().catch(() => ({ ok: false }))).ok) return false
  return (await computerUseHelper().automationGranted(bundleId).catch(() => 'unknown')) === 'granted'
}

/** Which of a browser's connection grants are ALREADY satisfied, so the mini-onboarding shows ONLY the missing rows
 *  (don't show a grant that's already on). Every probe is PROMPT-FREE — automation via the helper's status check,
 *  Allow-JS via Chrome's on-disk pref. Chrome = System Events + Chrome automation + Allow-JS; Safari = automation
 *  ONLY (Safari has no other path). */
async function browserGrantStates(browser: string): Promise<Record<string, boolean>> {
  if (browser === 'safari') {
    return { 'automation:safari': await automationAlreadyGranted('automation:safari') }
  }
  const [systemevents, chrome] = await Promise.all([
    automationAlreadyGranted('automation:systemevents'),
    automationAlreadyGranted('automation:chrome')
  ])
  return {
    'automation:systemevents': systemevents,
    'automation:chrome': chrome,
    'allowjs:chrome': chromeAeJsAlreadyOn()
  }
}

/** P0 (plans/blitzos-permissions-helper-todo.md): trigger the macOS grant for ONE connection permission, ALWAYS
 *  on the helper, with a real way back when macOS won't re-prompt. AX/Screen can only be granted from Settings
 *  (no inline Allow) — so raise the system prompt (lists the helper in the pane) AND open the exact pane, then
 *  poll + relaunch the helper to apply it. Automation is an inline Allow the first time; if it comes back denied
 *  (macOS then refuses to re-prompt), open Privacy ▸ Automation so the user isn't dead-ended. Allow-JS drives
 *  Chrome's View ▸ Developer toggle. Returns whether it landed and whether we raised a prompt or opened Settings. */
export async function requestGrant(grant: string): Promise<{ granted: boolean; opened: 'prompt' | 'settings' | 'none' }> {
  if (process.platform !== 'darwin') return { granted: false, opened: 'none' }
  const helper = computerUseHelper()
  if (grant === 'accessibility' || grant === 'screen') {
    if (helper.available()) {
      await helper.ensure().catch(() => {})
      await helper.request(grant).catch(() => {}) // raises the system prompt + adds the helper to the pane's list
    }
    try { await shell.openExternal(PERM_DEEPLINK[grant]) } catch { /* best-effort: the pane just won't pop */ }
    void pollAndApplyGrant(grant) // when it lands, relaunch the helper so it takes effect, then notify the renderer
    return { granted: false, opened: 'settings' }
  }
  if (grant === 'automation:systemevents' || grant === 'automation:chrome' || grant === 'automation:safari') {
    // ALREADY granted to the helper? Then NEVER raise the consent again — macOS itself wouldn't, and re-running the
    // PROMPTING probe (`count windows`) on an allowed target is what re-popped "control Safari/Chrome" after the user
    // had granted it. Confirm via the no-prompt AEDeterminePermissionToAutomateTarget status and short-circuit.
    if (await automationAlreadyGranted(grant)) {
      send('os:grant-changed', { grant, granted: true })
      return { granted: true, opened: 'none' }
    }
    // Tear the picker overlay down (awaited) so the consent dialog is clickable. We DON'T veil here: the mini-
    // onboarding store OWNS the veil (it hid the island on the Grant click and reveals it on os:grant-changed), so
    // toggling it here too raced the hide/reveal — for the DENIED→Settings path main unveiled the instant the probe
    // returned, leaving the island visible during Settings with no reveal-on-success. We only report the outcome.
    await computerUseHelper().call('pick_stop').catch(() => {})
    // Probe the SPECIFIC target so the right prompt fires ("control Safari"/"System Events"), not the default browser.
    const r =
      grant === 'automation:systemevents'
        ? await requestHelperAutomation('systemevents')
        : await requestHelperAutomation('browser', grant === 'automation:safari' ? 'com.apple.Safari' : 'com.google.Chrome')
    if (r.granted) {
      send('os:grant-changed', { grant, granted: true }) // → store reveals the island + advances
      return { granted: true, opened: 'prompt' }
    }
    // Denied / never landed → macOS won't re-prompt; open Privacy ▸ Automation AND poll for the toggle so the
    // mini-onboarding advances (and reveals) the instant the user flips it on. The island STAYS hidden meanwhile
    // (the store's veil), so System Settings is the focus; the store's safety timer reveals it if they walk away.
    try { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation') } catch { /* */ }
    pollAutomationGrant(grant)
    return { granted: false, opened: 'settings' }
  }
  if (grant === 'allowjs:chrome') {
    // The menu-drive (open View ▸ Developer, read the row's position) is a System Events action, so it needs System
    // Events Automation. JIT removed the up-front grant, so ensure it HERE. If System Events is DENIED (macOS won't
    // re-prompt), driving the menu would just fail silently into the manual "no arrow" fallback — so instead open the
    // Automation pane for the user to toggle it on, then they retry. (Unasked → the prompt fires and we proceed.)
    const sysev = await requestHelperAutomation('systemevents').catch(() => ({ granted: false }))
    if (!sysev.granted) {
      try { await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation') } catch { /* */ }
      return { granted: false, opened: 'settings' }
    }
    // System Events is granted → drive the menu. The island is already hidden by the store (it veiled on the Grant
    // click), so the menu + the floating helper popup are unobscured; closeChromeJsHelper reveals it on success.
    await openChromeJsHelper(true).catch(() => {})
    return { granted: false, opened: 'prompt' }
  }
  return { granted: false, opened: 'none' }
}

/** After a Settings-toggle grant (AX/Screen): poll the helper's TCC status for ~30s and relaunch it the instant
 *  the grant lands, so it takes effect with no user restart. Notifies the renderer via os:grant-changed. */
async function pollAndApplyGrant(kind: 'accessibility' | 'screen'): Promise<void> {
  const helper = computerUseHelper()
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const tcc = await helper.status().catch(() => null)
    if (tcc && helper.grantedFor(kind, tcc)) {
      await helper.relaunchForGrant().catch(() => {})
      send('os:grant-changed', { grant: kind, granted: true })
      return
    }
  }
}

/** After opening Privacy ▸ Automation for a DENIED grant: re-probe the helper every ~2.5s and fire os:grant-changed
 *  the instant the user flips it on, so the mini-onboarding advances without a manual re-check. Re-probing a denied
 *  grant returns -1743 silently (never re-prompts); once toggled on it returns ok. ~100s cap; one poll at a time. */
let automationPollTimer: ReturnType<typeof setInterval> | null = null
function pollAutomationGrant(grant: string): void {
  if (automationPollTimer) clearInterval(automationPollTimer)
  const target: 'systemevents' | 'browser' = grant === 'automation:systemevents' ? 'systemevents' : 'browser'
  const bundleId = grant === 'automation:safari' ? 'com.apple.Safari' : grant === 'automation:chrome' ? 'com.google.Chrome' : undefined
  let tries = 0
  automationPollTimer = setInterval(async () => {
    if (++tries > 40) { if (automationPollTimer) clearInterval(automationPollTimer); automationPollTimer = null; return }
    const r = await requestHelperAutomation(target, bundleId).catch(() => ({ granted: false }))
    if (r.granted) {
      if (automationPollTimer) clearInterval(automationPollTimer)
      automationPollTimer = null
      send('os:grant-changed', { grant, granted: true })
    }
  }, 2500)
  if (automationPollTimer.unref) automationPollTimer.unref()
}

// Detecting the bridge toggle WITHOUT Apple Events. Sending ANY Apple Event to Chrome from the frontmost
// app dismisses Chrome's open menus, so a polling AE probe would slam the very menu the user is trying to
// click shut every cycle. Instead we read Chrome's on-disk prefs: each profile's Preferences JSON carries
// `browser.allow_javascript_apple_events`, written when the user ticks View ▸ Developer ▸ that row. Pure
// file reads never touch the menu. `last_used` (Local State) is UNRELIABLE — it flips to whatever Chrome
// window is frontmost (our own `activate` can change it) and the user often has several profiles already
// on — so the poll watches for a false→TRUE transition across ALL profiles, never "is some profile on".

const chromeDataDir = (): string => join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

/** One profile's Apple-Events JS bridge pref (false if unreadable/absent). Pure file read. */
function readChromeAeJsPref(dir: string): boolean {
  try {
    const prefs = JSON.parse(readFileSync(join(chromeDataDir(), dir, 'Preferences'), 'utf8')) as {
      browser?: { allow_javascript_apple_events?: boolean }
    }
    return prefs.browser?.allow_javascript_apple_events === true
  } catch {
    return false // unreadable/locked profile, or non-standard install
  }
}

/** Map every Chrome profile dir → whether its bridge pref is on. Pure file reads. */
function readChromeAeJsPrefs(): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  try {
    for (const dir of readdirSync(chromeDataDir())) {
      if (dir !== 'Default' && !/^Profile /.test(dir)) continue
      out[dir] = readChromeAeJsPref(dir)
    }
  } catch {
    /* Chrome data dir absent — caller treats {} as "nothing on yet" */
  }
  return out
}

/** Best-effort "is the bridge already on for the profile the user is most likely in?" — the last-used
 *  profile's pref. Used ONLY to skip opening the menu on relaunch (e.g. they ticked it last run). The
 *  poll never uses this (last_used is unstable); it uses the transition snapshot below. */
function chromeAeJsAlreadyOn(): boolean {
  try {
    const state = JSON.parse(readFileSync(join(chromeDataDir(), 'Local State'), 'utf8')) as { profile?: { last_used?: string } }
    const lu = state.profile?.last_used
    return !!lu && readChromeAeJsPrefs()[lu] === true
  } catch {
    return false
  }
}

/** Phase 2: Chrome has windows open — open View ▸ Developer and show the floating helper at the row. */
async function openChromeJsPhase2(): Promise<void> {
  const gen = chromeJsGeneration
  // Re-check the bridge first: the user may have ticked it while we were waiting for their profile.
  if (chromeAeJsAlreadyOn()) {
    send('onboarding:chromejs-granted', {})
    send('os:grant-changed', { grant: 'allowjs:chrome', granted: true }) // advance the mini-onboarding card too
    return
  }
  if (gen !== chromeJsGeneration) return // step was closed/skipped while checking
  // Foreground Chrome FIRST and let it settle. System Events can only open the menu bar of the FRONTMOST app, and
  // the background helper's in-osascript `activate` does NOT reliably steal focus from the active island — so the
  // menu opened but was non-interactable. `open -a` (LaunchServices) reliably makes Chrome the active app.
  await new Promise<void>((r) => execFile('/usr/bin/open', ['-a', 'Google Chrome'], { timeout: 5000 }, () => r()))
  await new Promise((r) => setTimeout(r, 400))
  if (gen !== chromeJsGeneration) return
  // Mark the menu-driving flow active BEFORE openChromeJsRow opens the View ▸ Developer menu, so a teardown that
  // fires while the menu is open (user Skip, or an island unmount during the multi-second openChromeJsRow) STILL
  // sends the dismiss Escape. Setting it only AFTER the menu opened left a window where teardown skipped the Escape
  // and orphaned the menu. At launch — when phase2 never runs — it stays false, so teardown never pokes System Events.
  chromeJsActive = true
  const [row, iconUrl] = await Promise.all([openChromeJsRow(), blitzVisualIconDataUrl()])
  // Check cancellation: the step may have been closed/skipped during the 12s openChromeJsRow script.
  // If so, the menu may have opened — closeChromeJsHelper already sent an Escape. Exit without showing
  // the helper (which would steal focus from whatever the user switched to).
  if (gen !== chromeJsGeneration) return
  // Tell the renderer the profile step is done and we're now pointing at the menu row.
  send('onboarding:chromejs-ready', {})
  if (!chromeJsHelper || chromeJsHelper.isDestroyed()) {
    chromeJsHelper = new BrowserWindow({
      width: CHROME_JS_HELPER_W,
      height: CHROME_JS_HELPER_H,
      // Same NON-ACTIVATING panel pairing the TCC drag-helper uses: clicking/dragging it never activates
      // BlitzOS, so Chrome stays frontmost and its open menu never dismisses under the helper.
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
    chromeJsHelper.on('closed', () => {
      chromeJsHelper = null
    })
  }
  const win = chromeJsHelper
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setHiddenInMissionControl(true)
  win.setMenuBarVisibility(false)
  // Place the card just to the RIGHT of the "Allow JavaScript from Apple Events" row, vertically centered,
  // so its left-pointing arrow lands on the row. Fallback (row unread — no grant / Chrome closed / the menu
  // would not open): a neutral spot with the no-arrow manual-instruction copy, never an arrow at nothing.
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  let x = row ? row.x + row.w + 8 : disp.x + 24
  let y = row ? Math.round(row.y + row.h / 2 - CHROME_JS_HELPER_H / 2) : disp.y + 36
  x = Math.min(Math.max(disp.x + 8, x), disp.x + disp.width - CHROME_JS_HELPER_W - 8)
  y = Math.min(Math.max(disp.y + 8, y), disp.y + disp.height - CHROME_JS_HELPER_H - 8)
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: CHROME_JS_HELPER_W, height: CHROME_JS_HELPER_H })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(chromeJsHelperHtml(!!row, iconUrl)))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? ''
    // ERR_ABORTED: the window was closed or re-navigated before this load completed — harmless.
    if (code !== 'ERR_ABORTED' && code !== '') throw e
    return
  }
  win.showInactive()
  startChromeJsPoll()
  // Session is live. openChromeJsRow already activated Chrome before opening the menu and the helper is a
  // non-activating panel, so Chrome stays frontmost — no post-show re-activate (it disrupted the open menu).
  // (chromeJsActive was set true ABOVE, before the menu opened, so a mid-flow teardown still dismisses it.)
}

async function openChromeJsHelper(force = false): Promise<void> {
  if (process.platform !== 'darwin') return
  // The permission-drag step and this step SHARE the one computer-use helper. A drag poll that outlived the
  // permission step calls relaunchForGrant() (quit+reopen the helper) every 1.5s — which kills the System
  // Events session holding our menu open. Take ownership of the helper: stop any leaked drag poll first.
  if (dragPollTimer) closeDragHelper()
  // (Re)opening — cancel any debounced teardown so a StrictMode/remount close→open never tears us down.
  if (chromeJsTeardownTimer) { clearTimeout(chromeJsTeardownTimer); chromeJsTeardownTimer = null }
  // Idempotency: auto-open (force=false) must NOT re-run the System Events menu navigation. Re-navigating
  // snaps Chrome's submenu highlight back to its top item ("View Source") and flickers the helper — the
  // exact "stuck at View Source" bug. StrictMode double-invokes effects and the island can remount, so
  // open-chromejs fires repeatedly; converge them to ONE navigation. Only "Reopen menu" (force) renavigates.
  if (!force) {
    if (chromeJsActive && chromeJsHelper && !chromeJsHelper.isDestroyed()) { chromeJsHelper.showInactive(); return }
    if (chromeJsWindowPoller) return // already launched Chrome and waiting on the profile pick
  }
  // Guard against concurrent full-flow runs (the await windows below).
  if (chromeJsOpening) return
  chromeJsOpening = true
  const gen = ++chromeJsGeneration // each open owns its generation; closeChromeJsHelper invalidates it
  // Stop any existing probe poll so it doesn't race with the fresh flow.
  if (chromeJsPollTimer) { clearInterval(chromeJsPollTimer); chromeJsPollTimer = null }
  try {
    if (gen !== chromeJsGeneration) return // immediately invalidated
    // First: is the bridge already on? Then the step is already satisfied — auto-advance without showing
    // the helper (e.g. a relaunch after the user ticked it on a prior run).
    if (chromeAeJsAlreadyOn()) {
      send('onboarding:chromejs-granted', {})
      send('os:grant-changed', { grant: 'allowjs:chrome', granted: true }) // advance the mini-onboarding card too
      return
    }
    stopChromeWindowPoll()
    const windowCount = await countChromeWindows()
    if (windowCount === 0) {
      // Chrome is quit or has no windows — when Chrome launches it shows a "Who's using Chrome?" profile
      // picker before the menu bar becomes accessible. Launch Chrome and wait for the user to pick a profile
      // (window count > 0) before attempting to open View ▸ Developer.
      await new Promise<void>((r) => execFile('/usr/bin/open', ['-a', 'Google Chrome'], { timeout: 5000 }, () => r()))
      send('onboarding:chromejs-waiting-profile', {})
      // Poll until Chrome has a window (profile chosen), then run phase 2.
      chromeJsWindowPoller = setInterval(async () => {
        const count = await countChromeWindows()
        if (count > 0) {
          stopChromeWindowPoll()
          // Route through the gated entry point so concurrent "Reopen menu" clicks can't race phase2 directly.
          void openChromeJsHelper()
        }
      }, 1000)
      return
    }
    await openChromeJsPhase2()
  } finally {
    chromeJsOpening = false
  }
}

/** Dismiss any open Chrome View ▸ Developer menu via the computer-use helper, fire-and-forget — used when
 *  tearing the step down so a half-open menu doesn't linger.
 *
 *  GUARDED ON CHROME BEING FRONTMOST. `key code 53` posts to whatever app is frontmost, not to the scoped
 *  process, so an ungated Escape leaked to BlitzOS the instant the step was granted (BlitzOS, not Chrome, is
 *  frontmost then) and tripped the island's Esc-to-close handler — the island vanished right after connecting.
 *  A Chrome menu can only be open while Chrome is frontmost, so gating on that makes the Escape both correct
 *  (it only fires when there's actually a menu to close) and safe (it can never land on the island). */
function closeChromeMenuAsync(): void {
  if (process.platform !== 'darwin' || !computerUseHelper().available() || !computerUseHelper().connected()) return
  const esc = [
    'try',
    '  tell application "System Events"',
    '    if (name of first application process whose frontmost is true) is "Google Chrome" then',
    '      tell process "Google Chrome" to key code 53',
    '    end if',
    '  end tell',
    'end try'
  ].join('\n')
  void computerUseHelper()
    .runScan({ node: '/usr/bin/osascript', script: '-e', args: [esc], env: {} }, () => {}, 3000)
    .catch(() => {})
}

function stopChromeJsWatch(): void {
  for (const w of chromeJsWatchers) {
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }
  chromeJsWatchers = []
}

function closeChromeJsHelper(grantedHint?: boolean): void {
  // Bring the island back: it was veiled when the user clicked "Turn it on" so it wouldn't cover Chrome's menu /
  // the helper popup. This fires on BOTH the grant (the poll's grant() calls us) and any teardown, so the island
  // always returns. Also tell the connector card the allow-JS grant is settled so it clears + re-lists.
  send('os:island-veil', false)
  // grantedHint is load-bearing: the success path (grant()) detected the toggle IN-MEMORY (instant), but Chrome's
  // on-disk pref flush lags ~10s, so re-reading chromeAeJsAlreadyOn() here returned FALSE and the mini-onboarding
  // ignored it (it only advances on granted:true) — the "Allow-JS step never completes" bug. Trust the caller's
  // explicit result; only fall back to the disk read for a plain teardown (no hint).
  send('os:grant-changed', { grant: 'allowjs:chrome', granted: grantedHint ?? chromeAeJsAlreadyOn() })
  // Capture whether a menu session was actually live BEFORE we reset the flag. The teardown's Esc-dismiss
  // (closeChromeMenuAsync) runs a System Events Apple Event, so it must ONLY fire when a menu was really
  // opened. The renderer's mount-once cleanup calls closeChromeJsStep() on every island unmount — including
  // at launch, before the Chrome step is ever reached — and that spurious teardown was poking System Events
  // and raising the "control System Events" prompt at boot (attributed to the helper). No active menu → no Esc.
  const hadActiveMenu = chromeJsActive
  chromeJsGeneration++ // invalidate any in-flight openChromeJsPhase2 so it exits on next check
  chromeJsActive = false
  stopChromeJsWatch()
  if (chromeJsTeardownTimer) { clearTimeout(chromeJsTeardownTimer); chromeJsTeardownTimer = null }
  stopChromeWindowPoll()
  if (chromeJsPollTimer) {
    clearInterval(chromeJsPollTimer)
    chromeJsPollTimer = null
  }
  if (chromeJsMemProbeTimer) {
    clearInterval(chromeJsMemProbeTimer)
    chromeJsMemProbeTimer = null
  }
  if (chromeJsHelper && !chromeJsHelper.isDestroyed()) chromeJsHelper.close()
  chromeJsHelper = null
  chromeJsOpening = false
  if (hadActiveMenu) closeChromeMenuAsync() // only dismiss the View ▸ Developer menu if one was actually open
}

/** Renderer-driven close. The auto-open effect's cleanup fires on EVERY unmount — including StrictMode's
 *  throwaway first mount and any island remount — so tearing down immediately would kill a still-active
 *  session, then the re-mount re-navigates the menu (the thrash). Debounce it: a re-open within the window
 *  cancels the teardown. An explicit user skip passes immediate=true for an instant, clean exit. */
function requestCloseChromeJs(immediate: boolean): void {
  if (chromeJsTeardownTimer) { clearTimeout(chromeJsTeardownTimer); chromeJsTeardownTimer = null }
  if (immediate) { closeChromeJsHelper(); return }
  chromeJsTeardownTimer = setTimeout(() => {
    chromeJsTeardownTimer = null
    closeChromeJsHelper()
  }, CHROME_JS_TEARDOWN_DEBOUNCE_MS)
}

/** Read Chrome's IN-MEMORY bridge state via the helper: run a trivial `1` against the front tab. Returns 'on'
 *  the instant the user ticks the row — no waiting for Chrome's slow Preferences flush to disk (which the log
 *  showed can take ~10s). The Apple Event targets a TAB (page content), not the browser UI, so it neither
 *  steals focus nor dismisses the open menu — `execute … javascript` is documented focus-safe and is exactly
 *  what the Chrome connection adapter uses on background tabs (connection-chrome-applescript-link.mjs). 'off' =
 *  bridge still off; 'unknown' = no front tab / automation not permitted (the disk-watch path covers that). */
async function probeBridge(): Promise<'on' | 'off' | 'unknown'> {
  if (process.platform !== 'darwin' || !computerUseHelper().available() || !computerUseHelper().connected()) return 'unknown'
  const script = [
    'try',
    '  tell application "Google Chrome" to execute front window\'s active tab javascript "1"',
    '  log "BLITZBRIDGE on"',
    'on error errMsg',
    '  if errMsg contains "turned off" then',
    '    log "BLITZBRIDGE off"',
    '  else',
    '    log "BLITZBRIDGE unknown"',
    '  end if',
    'end try'
  ].join('\n')
  let result: 'on' | 'off' | 'unknown' = 'unknown'
  await computerUseHelper()
    .runScan(
      { node: '/usr/bin/osascript', script: '-e', args: [script], env: {} },
      (line: string) => {
        const m = line.match(/BLITZBRIDGE (on|off|unknown)/)
        if (m) result = m[1] as typeof result
      },
      5000
    )
    .catch(() => {})
  return result
}

// Detect the toggle two ways, racing whichever lands first. FAST path (in-memory): once the menu closes (the
// user clicked the row), an AX-gated Apple Event reads Chrome's live bridge state — no waiting on Chrome's
// lazy ~3-5s Preferences flush. SAFE/fallback path (zero Apple Events): fs.watch + an interval on the
// OFF-at-snapshot profile dirs catch the eventual disk write. Only a profile that was OFF when the helper
// appeared can grant, so the user's already-on profiles never false-trip it.
function startChromeJsPoll(): void {
  if (chromeJsPollTimer) clearInterval(chromeJsPollTimer)
  stopChromeJsWatch()
  const baseline = readChromeAeJsPrefs()
  const watchDirs = Object.keys(baseline).filter((p) => baseline[p] === false)
  if (watchDirs.length === 0) {
    // Every profile is already on (rare — the up-front check usually catches this). Nothing to wait for.
    closeChromeJsHelper(true)
    send('onboarding:chromejs-granted', {})
    return
  }
  let done = false
  const grant = (): void => {
    if (done) return
    done = true
    closeChromeJsHelper(true) // detected the toggle (in-memory or disk) → tell the card granted:true, NOT lagged disk
    send('onboarding:chromejs-granted', {})
  }
  const fileCheck = (): void => {
    if (done) return
    if (watchDirs.some((p) => readChromeAeJsPref(p) === true)) grant()
  }
  // Disk path: fs.watch fires on Chrome's write; a fast file-only poll backs it up. NEVER blocked by the
  // (slow) helper probe below — they run on independent timers so neither throttles the other.
  for (const dir of watchDirs) {
    try {
      chromeJsWatchers.push(
        watch(join(chromeDataDir(), dir), { persistent: false }, (_evt, file) => {
          if (!file || String(file).includes('Preferences')) fileCheck()
        })
      )
    } catch {
      /* watch unsupported for this dir — the interval below still covers it */
    }
  }
  chromeJsPollTimer = setInterval(fileCheck, 300)
  // In-memory path (the fast one): probe the live bridge state via the helper on its OWN timer + guard. The
  // probe Apple Event is focus-safe and never touches the open menu, so we can probe straight through.
  let probing = false
  chromeJsMemProbeTimer = setInterval(async () => {
    if (done || probing) return
    probing = true
    try {
      if ((await probeBridge()) === 'on') grant()
    } finally {
      probing = false
    }
  }, 400)
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

// NOTE: the old `requestAutomation()` (a DIRECT Electron osascript that dumped every browser tab and
// raised the "control <browser>" consent attributed to BlitzOS) was removed. It is superseded by
// `requestHelperAutomation()` — the consent must land on the computer-use helper, never on BlitzOS.
// Do NOT reintroduce a direct Electron Apple Event to a browser; route every osascript through the helper.

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
  // SCAN NUKED. The local personalization scan scraped TCC-protected locations (Desktop/Documents/Downloads/
  // Music/Media Library, Messages/Mail/Calendar, login items via System Events) and spammed macOS permission
  // dialogs at launch, attributed to BlitzOS. It is fully disabled: onboarding primes ONLY from the
  // interviewer prompt and the agent learns about the user by ASKING during the interview. To restore a
  // prompt-free scan, recover the body from git history and gate EVERY protected-folder/Media/System-Events
  // source behind a REAL (TCC-enforced) grant on the helper.
  const dir = onboardingDir(wsPath)
  mkdirSync(dir, { recursive: true })
  const promptMd = join(appRoot(), 'src', 'main', 'blitzos-onboarding.md')
  const primer = existsSync(promptMd) ? readFileSync(promptMd, 'utf8') : '# BlitzOS\nNo local scan — interview the user directly.\n'
  writeFileSync(join(dir, 'context.md'), primer, 'utf8')
  return { meta: { fda: false } }
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
  const scope = profileValue(profile, 'Scope') || 'BlitzOS and agent-os testing'
  const autonomy = profileValue(profile, 'Autonomy') || 'Reversible testing and preparation can proceed without waiting.'
  const confirmation = profileValue(profile, 'Confirmation boundary') || profileValue(profile, 'Privacy and accounts') || 'Ask before outward-facing actions, destructive changes, sends, money, credentials, deploys, or account actions.'
  const priority = profileValue(profile, 'Current priority') || 'Make BlitzOS onboarding fast and reliable.'
  // The active initiative is NOT persisted (it lives in the live chat/context) — the anchor only
  // carries the durable profile facts so a fresh resident re-proposes its initiative from there.
  const anchor = [
    RESTART_ANCHOR_HEADING,
    '',
    `- Scope: ${scope}`,
    `- Autonomy: ${autonomy}`,
    `- Confirm before: ${confirmation}`,
    `- Priority: ${priority}`
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

// GUI Electron launched from Finder/Dock inherits launchd's truncated PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// missing /opt/homebrew/bin etc. — so ANY bare-command child spawn (a workflow LEAF spawning `claude`, the
// run_workflow enrichment agent, git, node) dies with `spawn … ENOENT`. Resolve the login shell's real PATH
// once and merge it into process.env.PATH so every child inherits it. Idempotent; called from the CLI
// resolvers below, which run before any agent exists (and an agent must exist before it can run_workflow), so
// the global PATH is repaired before bare `claude` is ever spawned. Closes the whole ENOENT class, not just claude.
let pathPatched = false
export function ensureFullPath(): void {
  if (pathPatched) return
  pathPatched = true
  let login: string | null = null
  try {
    // NON-interactive login shell (-lc), deliberately NOT -lic: an interactive shell runs the user's FULL ~/.zshrc,
    // which can touch TCC-protected resources and raise a permission prompt attributed to BlitzOS. -lc is the
    // proven, side-effect-light baseline. The fix for the missing ~/.local/bin is NOT a fatter shell — it's the
    // explicit `common` dirs below + the direct filesystem probe in resolveCli (no shell, no TCC surface at all).
    login = execFileSync('/bin/zsh', ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    login = null
  }
  // ALWAYS fold in the dirs where the CLIs actually install — this makes ~/.local/bin reachable even though ~/.zshrc
  // (where the Claude installer adds it) is NOT sourced by a non-interactive shell. Closes the ENOENT class.
  const home = app.getPath('home')
  const common = [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.claude', 'local'), join(home, '.npm-global', 'bin')]
  const seen = new Set<string>()
  process.env.PATH = [...(login ? login.split(':') : []), ...common, ...(process.env.PATH || '').split(':')]
    .filter((d) => d && !seen.has(d) && seen.add(d))
    .join(':')
}

// Resolve a CLI by DIRECT filesystem probe (deterministic, NO shell, NO TCC surface) FIRST, then a NON-interactive
// login shell as a fallback for non-standard locations. The probe is what fixes the ~/.local/bin/claude case the
// login-non-interactive `command -v` missed: the Claude Code installer puts the launcher at ~/.local/bin/<bin>.
function resolveCli(bin: 'claude' | 'codex'): string | null {
  const home = app.getPath('home')
  const candidates = [
    join(home, '.local', 'bin', bin),
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    join(home, '.claude', 'local', bin),
    join(home, '.npm-global', 'bin', bin)
  ]
  for (const c of candidates) {
    // accessSync(X_OK), not existsSync: a present-but-non-executable file would otherwise be reported "installed"
    // and then EACCES at spawn. This also follows symlinks (a broken ~/.local/bin/<bin> link → throws → skipped).
    try { accessSync(c, constants.X_OK); return c } catch { /* missing or not executable — skip */ }
  }
  try {
    const out = execFileSync('/bin/zsh', ['-lc', `command -v ${bin}`], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out.startsWith('/') && existsSync(out)) return out
  } catch {
    /* not found via shell */
  }
  return null
}

let claudePath: string | null | undefined // undefined = not probed yet
export function claudeCliPath(): string | null {
  ensureFullPath()
  if (claudePath !== undefined) return claudePath
  claudePath = resolveCli('claude')
  return claudePath
}
let codexPath: string | null | undefined
export function codexCliPath(): string | null {
  ensureFullPath()
  if (codexPath !== undefined) return codexPath
  codexPath = resolveCli('codex')
  return codexPath
}

// Onboarding "is Claude Code installed?" check. `recheck` busts the memoised probe so the re-check button reflects
// reality right after the user installs it (otherwise claudeCliPath returns the cached null). Path is returned so
// the UI can show where it found it.
export function claudeCliStatus(recheck = false): { installed: boolean; path: string | null } {
  if (recheck) claudePath = undefined
  const path = claudeCliPath()
  return { installed: !!path, path }
}

let interviewAgentAvailable = false
export function setInterviewAgentAvailable(available: boolean): void {
  interviewAgentAvailable = !!available
}

// ONE resident-only duty for agent '0'. No interview, no choice-card kickoff, no greeting — Blitz
// boots straight into being the user's resident the moment the machine scan's context.md lands.
const BLITZ_DUTY =
  'You are Blitz, the user\'s resident agent, living in their chat. If `.blitzos/onboarding/context.md` does not exist yet, the machine scan is still running, so say nothing and wait. Once it exists, read it to learn the user\'s machine and work. Do not run an interview, do not post choice cards, do not greet. Act only on what the user asks; absent a request, stay quiet. Your browser is Blitz Chrome (extension-free, background): when a task needs one of their work apps, have them open it in Blitz Chrome and sign in once, then act there. Permissions: do everything reversible without asking (research, drafting, staging, editing files); ask only before a destructive or irreversible act (messaging or posting as the user, force pushing, deleting, deploying, spending). Keep polling `/events`; never go dark while working.'

/** index.ts threads this into session '0': the single resident duty (no interview phase exists). */
export function interviewBootTask(): string | null {
  if (!ONBOARDING_CHAT_ENABLED) return null
  return BLITZ_DUTY
}

// Interview→resident HANDOFF: poll interview.json and, on the pending→done flip, re-exec agent '0' ONCE
// with a FRESH context (rotated session) into the resident duty at xhigh effort. The fresh resident
// rebuilds from profile.md + chat.md (its bootstrap reads them). Single-shot; unref'd so it
// never holds the process open.
let interviewDoneTimer: ReturnType<typeof setInterval> | null = null
function watchInterviewDone(wsPath: string): void {
  if (interviewDoneTimer) return
  interviewDoneTimer = setInterval(() => {
    const st = readInterview(wsPath)
    if (st && st.state === 'done') {
      if (interviewDoneTimer) clearInterval(interviewDoneTimer)
      interviewDoneTimer = null
      refreshRestartAnchor(wsPath)
      osClearBrainContext('0') // HANDOFF: fresh-context re-exec into the resident duty (rebuilds from .md + chat.md, RESIDENT_EFFORT / xhigh)
    }
  }, 100) // tight 100ms poll: the interview→resident handoff latency is user-visible. Single-shot — the
          // interval clears itself the instant interview.json flips to done, so it never polls for long.
  if (interviewDoneTimer.unref) interviewDoneTimer.unref()
}

function startInterviewPhase(wsPath: string): void {
  if (!ONBOARDING_CHAT_ENABLED) {
    progress({ phase: 'setup-only' })
    return
  }
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

// ---- FDA effective grant -----------------------------------------------------------------------
// FDA now lives on the HELPER (it forces a quit-and-reopen, so it can't sit on BlitzOS). The effective
// FDA = the helper's fullDisk when the helper is available, else BlitzOS's own (dev-inherited / the
// legacy path). The scan reads files through whichever holds it. Surfaced to the renderer's preboard
// via the onboarding:fda-status IPC.
async function fdaGrantedEffective(): Promise<boolean> {
  if (computerUseHelper().available()) {
    const ok = await computerUseHelper().ensure()
    if (ok.ok) return !!(await computerUseHelper().status())?.fullDisk
  }
  return hasFDA()
}

// ---- entry ------------------------------------------------------------------------------------
// V1 is chat-only: create + switch to the single Home workspace, run the scan (its context.md primes
// the chat agent), then hand off to the primary interview agent. No widget board is seeded.
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
    if (ONBOARDING_CHAT_ENABLED) ensureInterviewArtifacts(wsPath) // legacy chat interview: make the standing duty visible before any boot-resume of agent 0
    // A restart mid-onboarding (the scan already ran): don't re-scan, just hand back to the canvas +
    // resume the interview agent (or no-op when the interview is done).
    if (existsSync(join(onboardingDir(wsPath), 'context.md'))) {
      osGoToPrimary()
      progress({ phase: 'board-ready', cached: true, fda: await fdaGrantedEffective() })
      startInterviewPhase(wsPath)
      return { ok: true, cached: true }
    }
    const scan = await runScan(wsPath)
    if (!scan) return { ok: false } // 'error' phase already sent — renderer degrades to plain desktop
    osGoToPrimary()
    progress({ phase: 'board-ready', fda: scan.meta.fda })
    startInterviewPhase(wsPath) // the resident brain's first duty
    return { ok: true }
  } finally {
    starting = false
  }
}

export function registerOnboarding(getWindow: () => BrowserWindow | null): void {
  mainWindow = getWindow
  ipcMain.handle('onboarding:start', () => start())
  // P0 JIT/recovery: the renderer (attach panel cards) + the agent (TCC choice card) trigger a connection grant here.
  ipcMain.handle('os:request-grant', (_e, grant?: string) => requestGrant(String(grant || '')))
  // Which of a browser's connection grants are already satisfied (prompt-free), so the mini-onboarding hides granted rows.
  ipcMain.handle('os:browser-grant-states', (_e, browser?: string) => browserGrantStates(String(browser || 'chrome')))
  ipcMain.handle('onboarding:claude-status', (_e, opts?: { recheck?: boolean }) => claudeCliStatus(!!opts?.recheck))
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
    browser: defaultBrowser(), // gate the Chrome-bridge step on the DEFAULT browser, not first-installed
    canDrag: !!appBundlePath(),
    appIcon: await appIconDataUrl(),
    // Chromium profiles available to import a Google sign-in from (the account picker). Read-only,
    // no prompt — decryption + the Keychain prompt happen only when the user picks one and confirms.
    importSources: importSources()
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
    // Drag ghost = the dragged bundle's OWN icon (precomputed in openDragHelper from its .icns, so the ghost
    // matches the floating tile AND the row that lands in Settings), NOT app.getFileIcon(bundle) — for the helper
    // getFileIcon renders blank under the cursor. Fall back to getFileIcon only if the precompute failed.
    const dragIcon = currentDragIcon
    if (dragIcon && !dragIcon.isEmpty()) {
      try {
        e.sender.startDrag({ file: bundle, icon: dragIcon })
      } catch {
        /* drag raced a navigation — harmless */
      }
      return
    }
    void app.getFileIcon(bundle, { size: 'normal' }).then((icon) => {
      try {
        e.sender.startDrag({ file: bundle, icon })
      } catch {
        /* drag raced a navigation — harmless */
      }
    })
  })
  // Hovering the floating drag-helper (the user is heading to grab the icon) VEILS the island (hidden but still
  // mounted) so the full Settings window is visible to drop into; closeDragHelper unveils it (grant / skip / leave).
  ipcMain.on('onboarding:drag-hover', () => send('os:island-veil', true))
  // The automation rows veil the island WHILE the macOS consent dialog is up (so it isn't covered by the island),
  // then unveil when the grant resolves — a two-way version of drag-hover (which only veils).
  ipcMain.on('onboarding:island-veil', (_e, on) => send('os:island-veil', !!on))
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
  // Chrome "Allow JavaScript from Apple Events" step: open View ▸ Developer, float the helper at the row,
  // and poll the bridge until the user ticks it (→ chromejs-granted). Mirrors the drag-helper handlers.
  ipcMain.handle('onboarding:open-chromejs', async (_e, force?: boolean) => {
    await openChromeJsHelper(!!force)
    return { ok: true }
  })
  ipcMain.handle('onboarding:close-chromejs', (_e, immediate?: boolean) => {
    requestCloseChromeJs(!!immediate)
    return { ok: true }
  })
  // The automation permission rows' "Enable": fire the helper-held Automation consent for one target.
  ipcMain.handle('onboarding:request-helper-automation', (_e, target?: 'systemevents' | 'browser') =>
    requestHelperAutomation(target === 'browser' ? 'browser' : 'systemevents'))
  ipcMain.handle('onboarding:open-automation-settings', () => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Automation')
    return { ok: true }
  })
  // Google sign-in import (the Dia move): list the user's Chrome profiles for the account picker,
  // then import the chosen profile's Google cookies into the BlitzOS session (one Keychain prompt).
  ipcMain.handle('onboarding:list-import-profiles', () => importSources())
  ipcMain.handle('onboarding:import-signin', async (_e, src: string, profileId: string) => {
    const r = await importGoogleSignin(src || 'chrome', profileId)
    markPreboard('signin', r.ok ? 'granted' : 'denied')
    return r
  })
  // V1 has no seeded unlock card / board (onboarding is chat-only) — the legacy renderer hook is a no-op.
  ipcMain.handle('onboarding:dismiss-unlock', () => ({ ok: true }))
  app.on('before-quit', () => {
    closeDragHelper()
    closeChromeJsHelper()
  })
}
