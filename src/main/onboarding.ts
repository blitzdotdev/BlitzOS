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
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
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

/** The Blitz icon as a NativeImage for the native drag preview (cosmetic — the dragged FILE stays the
    target bundle so the TCC grant still lands on the right app). */
function blitzDragIconImage(): Electron.NativeImage | null {
  const file = blitzIconFile()
  if (!file) return null
  try {
    const img = nativeImage.createFromPath(file)
    if (img.isEmpty()) return null
    const sized = img.resize({ width: 64, height: 64 })
    // An empty image would make startDrag({ icon }) throw — return null so the caller falls back instead.
    return sized.isEmpty() ? null : sized
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
  <div class="c">Drag the Blitz Icon into ${label}</div>
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
  // Visual clarity: show the Blitz icon in the helper, but keep dragging currentDragBundle (the
  // computer-use helper app) so the TCC grant still lands on the process that needs it.
  const html = dragHelperHtml(kind, await blitzVisualIconDataUrl())
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
const CHROME_JS_HELPER_W = 320
const CHROME_JS_HELPER_H = 92

/** The helper card content. `pointed` (the Developer row's screen rect was read) → a LEFT-pointing arrow on
 *  the card's left edge + the short "Click ..." copy; the card sits just right of the row so the arrow lands
 *  on it. Not pointed (menu could not be opened/read) → no arrow + a manual instruction, so we never point an
 *  arrow at nothing. Same frosted chrome + CSP as the drag helper; this step is a click, not a drag. */
function chromeJsHelperHtml(pointed: boolean): string {
  const arrow = pointed ? '<div class="arrow" aria-hidden="true"></div>' : ''
  const copy = pointed
    ? 'Click &ldquo;Allow JavaScript from Apple Events&rdquo;'
    : 'In Chrome, open View &rsaquo; Developer and tick &ldquo;Allow JavaScript from Apple Events&rdquo;'
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; overflow:hidden; -webkit-user-select:none; user-select:none; font-family:-apple-system,system-ui,sans-serif; }
  .h { height:100%; display:flex; align-items:center; gap:12px; padding:0 16px; box-sizing:border-box;
       background:rgba(245,245,247,0.86); border-radius:16px; border:1px solid rgba(0,0,0,0.10);
       -webkit-backdrop-filter:saturate(1.3) blur(20px); backdrop-filter:saturate(1.3) blur(20px);
       box-shadow:0 8px 30px rgba(0,0,0,0.22); }
  @media (prefers-color-scheme: dark){ .h{ background:rgba(40,42,46,0.86); border-color:rgba(255,255,255,0.12); color:#f5f5f7; } }
  /* The arrow points LEFT toward the menu row (the card sits just to the row's right). */
  .arrow { position:relative; width:40px; height:24px; flex:0 0 auto; color:#0a84ff; animation:chromeArrowHint 1.65s cubic-bezier(.22,1,.36,1) infinite; }
  .arrow:before { content:''; position:absolute; left:6px; top:11px; width:30px; height:2px; border-radius:999px; background:currentColor; }
  .arrow:after { content:''; position:absolute; left:4px; top:6px; width:12px; height:12px; border-bottom:2px solid currentColor; border-left:2px solid currentColor; transform:rotate(45deg); }
  .c { min-width:0; color:inherit; font-size:15px; line-height:1.25; font-weight:700; letter-spacing:-0.01em; }
  @keyframes chromeArrowHint {
    0%,62%,100% { opacity:.42; transform:translateX(0); }
    32% { opacity:1; transform:translateX(-6px); }
  }
</style></head><body>
<div class="h">
  ${arrow}
  <div class="c">${copy}</div>
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
  const applescript = [
    'tell application "Google Chrome" to activate',
    'delay 0.25',
    'tell application "System Events" to tell process "Google Chrome"',
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

/** Probe whether Chrome's Apple-Events JavaScript bridge is ON: run a trivial `1` against the front
 *  window's active tab. The decisive signal is the EXACT "turned off / through AppleScript" error
 *  (connection-chrome-applescript-link.mjs documents it); 'on' = the probe ran (returned a value).
 *  'unknown' = no front window or a non-toggle failure (e.g. the Automation prompt is still pending) —
 *  we do NOT advance on unknown, so there is never a false auto-advance. */
function probeChromeAppleEventsJs(): Promise<'on' | 'off' | 'unknown'> {
  return new Promise((resolve) => {
    const script = 'tell application "Google Chrome" to execute front window\'s active tab javascript "1"'
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 8000 }, (err, stdout, stderr) => {
      if (!err) {
        // Chrome returns the evaluated value ("1") when the bridge is on AND a window/tab exists.
        return resolve(String(stdout || '').trim() === '1' ? 'on' : 'unknown')
      }
      const msg = String(stderr || '')
      // The bridge being off has one exact message: "Executing JavaScript through AppleScript is turned off."
      if (/JavaScript through AppleScript|Allow JavaScript from Apple Events|is turned off/i.test(msg)) return resolve('off')
      // Anything else (no front window, Automation prompt pending / denied) is indeterminate.
      resolve('unknown')
    })
  })
}

async function openChromeJsHelper(): Promise<void> {
  if (process.platform !== 'darwin') return
  // First: is the bridge already on? Then the step is already satisfied — auto-advance without showing
  // the helper (e.g. a relaunch after the user ticked it on a prior run).
  if ((await probeChromeAppleEventsJs()) === 'on') {
    send('onboarding:chromejs-granted', {})
    return
  }
  const row = await openChromeJsRow()
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
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(chromeJsHelperHtml(!!row)))
  win.showInactive()
  startChromeJsPoll()
}

function closeChromeJsHelper(): void {
  if (chromeJsPollTimer) {
    clearInterval(chromeJsPollTimer)
    chromeJsPollTimer = null
  }
  if (chromeJsHelper && !chromeJsHelper.isDestroyed()) chromeJsHelper.close()
  chromeJsHelper = null
}

// Poll the bridge; the moment the probe reports 'on' (the user ticked the row), tear down the helper and
// tell the card to advance. 'off'/'unknown' keep polling — never a false auto-advance (see the probe).
let chromeJsPolling = false
function startChromeJsPoll(): void {
  if (chromeJsPollTimer) clearInterval(chromeJsPollTimer)
  chromeJsPollTimer = setInterval(async () => {
    if (chromeJsPolling) return
    chromeJsPolling = true
    try {
      if ((await probeChromeAppleEventsJs()) !== 'on') return
      closeChromeJsHelper()
      send('onboarding:chromejs-granted', {})
    } finally {
      chromeJsPolling = false
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

/** Where the captured live working set (open tabs) is persisted — machine-level (pre-workspace), so
 *  the scan child (run later by the director) can fold it in via --open-tabs. */
function preboardTabsPath(): string { return join(app.getPath('userData'), 'preboard-tabs.json') }

/** Probe Automation (AppleEvents) consent by ASKING: ONE AppleScript to the detected browser that
 *  dumps the title+URL of every open tab, grouped by window. The FIRST call raises the macOS consent
 *  prompt (attributed to this app — the scan-child pattern); the promise resolves AFTER the user
 *  answers. On success we PERSIST the working set (the single highest-signal browser artifact — what
 *  the user is doing RIGHT NOW) to userData for the scan to fold in, and return live counts as the
 *  immediate visible reward. Errors: -1743 = user denied; -600/-10810 = browser not running (the
 *  tell launches it, so these are rare). */
function requestAutomation(): Promise<{ status: 'granted' | 'denied' | 'unavailable'; windows?: number; tabs?: number; browser?: string }> {
  const browser = detectBrowser()
  if (process.platform !== 'darwin' || !browser) return Promise.resolve({ status: 'unavailable' })
  return new Promise((resolve) => {
    // Delimited dump: a @@WIN@@ line opens each window, then "title @@T@@ url" per tab. URLs never
    // contain newlines, so a title that somehow does just yields a skipped row (no @@T@@) — it can
    // never corrupt the parse or the JSON we persist.
    const script = [
      `tell application id "${browser.id}"`,
      '  set out to ""',
      '  repeat with w in windows',
      '    set out to out & "@@WIN@@" & linefeed',
      '    repeat with t in tabs of w',
      '      set out to out & (title of t) & "@@T@@" & (URL of t) & linefeed',
      '    end repeat',
      '  end repeat',
      '  return out',
      'end tell'
    ].join('\n')
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const denied = /-1743/.test(String(stderr)) || /not allowed/i.test(String(stderr))
        resolve({ status: denied ? 'denied' : 'unavailable', browser: browser.name })
        return
      }
      const windows: { tabs: { title: string; url: string }[] }[] = []
      let cur: { tabs: { title: string; url: string }[] } | null = null
      let tabs = 0
      for (const line of String(stdout).split('\n')) {
        if (line.startsWith('@@WIN@@')) { cur = { tabs: [] }; windows.push(cur); continue }
        const i = line.indexOf('@@T@@')
        if (i < 0 || !cur) continue
        const url = line.slice(i + 5).trim()
        if (!/^https?:/i.test(url)) continue // skip chrome://, about:, file:// — not working-set signal
        cur.tabs.push({ title: line.slice(0, i), url })
        tabs++
      }
      const live = windows.filter((w) => w.tabs.length)
      try {
        writeFileSync(preboardTabsPath(), JSON.stringify({ browser: browser.name, capturedAt: Date.now(), windows: live }, null, 2))
      } catch (e) {
        console.error('[onboarding] could not persist open tabs:', (e as Error).message)
      }
      resolve({ status: 'granted', windows: live.length, tabs, browser: browser.name })
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
  // Fold the pre-board live working set (open tabs) into the scan when it was captured. Absolute
  // userData path, readable by both the direct spawn AND the helper's child (--open-tabs).
  const tabsSnap = preboardTabsPath()
  if (existsSync(tabsSnap)) args.push('--open-tabs', tabsSnap)
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
    browser: detectBrowser(),
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
    // Drag preview = the Blitz icon (the tile the user sees), NOT app.getFileIcon(bundle) — for the
    // computer-use pair the bundle is the helper, whose file icon renders blank under the cursor.
    const blitzIcon = blitzDragIconImage()
    if (blitzIcon) {
      try {
        e.sender.startDrag({ file: bundle, icon: blitzIcon })
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
  // Hovering the floating drag-helper (the user is heading to grab the icon) HIDES the island so the full Settings
  // window is visible to drop into; the grant poll (startDragPoll) re-shows it via os:notch-open.
  ipcMain.on('onboarding:drag-hover', () => send('os:island-veil', true))
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
  ipcMain.handle('onboarding:open-chromejs', async () => {
    await openChromeJsHelper()
    return { ok: true }
  })
  ipcMain.handle('onboarding:close-chromejs', () => {
    closeChromeJsHelper()
    return { ok: true }
  })
  ipcMain.handle('onboarding:request-automation', () => requestAutomation())
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
