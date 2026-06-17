// The STANDALONE Job Launcher (Shell A of plans/blitzos-job-entrypoints.md) — a global Raycast-style bar.
//
// A global hotkey (default ⌥Space; BLITZ_LAUNCHER_HOTKEY overrides) TOGGLES a small always-on-top
// NSPanel: the user types a prompt, Send → electronOps.startJob({ goal }), which mints a Job whose
// planning agent authors the editable plan widget. v1 is JUST prompt + Send.
//
// The window is its OWN isolated UI (a self-contained inline HTML data: URL + the shared preload's
// `agentOS.launcher` bridge) — it is NOT wired into the renderer (App.tsx/store/PrimarySpace), so the
// user's single-canvas-navigation WIP is untouched.
//
// Construction CLONES the onboarding dragHelper NSPanel recipe (onboarding.ts:230-264): a macOS `panel`
// window, frameless, transparent, no shadow, skipTaskbar, always-on-top 'floating',
// setVisibleOnAllWorkspaces({ visibleOnFullScreen }). The deliberate differences from that drag helper:
// `focusable: true` + show()+focus() on reveal (NOT the helper's showInactive()) — unlike the helper (a
// non-activating drop target), the launcher must take key focus so the user can TYPE into it.
//
// TODO(A2): drag-drop files/folders onto the bar → associate as Job context (copy|symlink flag +
//   jobId on ingest; touches osIngestPaths + the three-serializer persistence rule).
// TODO(A3): an "add browser tab" affordance that hands the logged-in persist:agentos page to the Job
//   (the extension-reframe in plans/blitzos-job-entrypoints.md §3).
// TODO(B): the same UI behind an in-app keybind HUD over the BlitzOS window (Shell B) — share the HTML
//   when that lands instead of duplicating it.
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { join } from 'path'

// The default toggle hotkey. ⌥Space (Alt+Space) is the canonical Raycast/Spotlight-style chord and does
// not collide with any current BlitzOS keybind (those are ⌘T / ⇧⌘T / bare-⌥ / bare-⇧, none global). An
// env override (e.g. BLITZ_LAUNCHER_HOTKEY='Cmd+Shift+Space') lets a user dodge a conflict with another
// app's global hotkey without a rebuild.
const DEFAULT_HOTKEY = 'Alt+Space'
function launcherHotkey(): string {
  const h = (process.env.BLITZ_LAUNCHER_HOTKEY || '').trim()
  return h || DEFAULT_HOTKEY
}

const LAUNCHER_W = 640
const LAUNCHER_H = 132

let launcherWin: BrowserWindow | null = null
// The seam back to the OS control plane — index.ts injects electronOps.startJob + a focus-main callback,
// so this module never imports osActions/electron-os-tools (which would create an import cycle and pull the
// whole control plane into a window helper). Same DI pattern as setLaunchAgent / setBootTaskProvider.
let startJobFn: ((spec: { goal: string }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string }) | null = null
let focusMainFn: (() => void) | null = null
export function wireLauncher(opts: {
  startJob: (spec: { goal: string }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string }
  focusMain: () => void
}): void {
  startJobFn = opts.startJob
  focusMainFn = opts.focusMain
}

// Self-contained launcher UI. CSP locks it to inline style/script only (no remote, no data: needed); the
// window shares the app preload, so the bar talks to main through `window.agentOS.launcher`.
// Enter submits, Esc hides, the bar refocuses its input on every show.
function launcherHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%; overflow:hidden; background:transparent; -webkit-user-select:none; user-select:none;
              font-family:-apple-system,system-ui,sans-serif; }
  .bar { height:100%; box-sizing:border-box; padding:18px 20px; display:flex; flex-direction:column; gap:10px;
         background:rgba(245,245,247,0.86); border-radius:18px; border:1px solid rgba(0,0,0,0.10);
         -webkit-backdrop-filter:saturate(1.3) blur(24px); backdrop-filter:saturate(1.3) blur(24px);
         box-shadow:0 12px 40px rgba(0,0,0,0.26); }
  @media (prefers-color-scheme: dark){ .bar{ background:rgba(38,40,44,0.88); border-color:rgba(255,255,255,0.12); color:#f5f5f7; } }
  .row { display:flex; align-items:center; gap:12px; }
  .glyph { flex:0 0 auto; width:22px; height:22px; opacity:0.5; display:grid; place-items:center; font-size:18px; }
  #q { flex:1 1 auto; min-width:0; background:transparent; border:0; outline:0; font-size:19px; line-height:1.3;
       color:inherit; -webkit-user-select:text; user-select:text; }
  #q::placeholder { color:rgba(60,60,67,0.45); }
  @media (prefers-color-scheme: dark){ #q::placeholder { color:rgba(235,235,245,0.40); } }
  .send { flex:0 0 auto; border:0; cursor:pointer; font-size:13px; font-weight:600; color:#fff;
          background:#0a84ff; border-radius:9px; padding:7px 14px; opacity:0.95; }
  .send:disabled { opacity:0.4; cursor:default; }
  .hint { display:flex; align-items:center; justify-content:space-between; font-size:11px; opacity:0.5; }
  kbd { font-family:inherit; font-size:11px; padding:1px 5px; border-radius:5px; background:rgba(0,0,0,0.08); }
  @media (prefers-color-scheme: dark){ kbd { background:rgba(255,255,255,0.12); } }
</style></head><body>
<div class="bar">
  <div class="row">
    <span class="glyph">&#9889;</span>
    <input id="q" type="text" autocomplete="off" spellcheck="false" placeholder="Start a job&hellip; describe what you want done">
    <button class="send" id="go" disabled>Send</button>
  </div>
  <div class="hint"><span>BlitzOS Job Launcher</span><span><kbd>&#9166;</kbd> start &nbsp; <kbd>esc</kbd> close</span></div>
</div>
<script>
  var q = document.getElementById('q');
  var go = document.getElementById('go');
  var sending = false;
  function sync(){ go.disabled = sending || q.value.trim().length === 0; }
  function hide(){ try { window.agentOS && window.agentOS.launcher && window.agentOS.launcher.hide(); } catch(_){} }
  function submit(){
    var goal = q.value.trim();
    if (!goal || sending) return;
    sending = true; sync();
    try {
      window.agentOS.launcher.startJob(goal).then(function(){ q.value=''; sending=false; sync(); hide(); })
        .catch(function(){ sending=false; sync(); });
    } catch(_) { sending=false; sync(); }
  }
  q.addEventListener('input', sync);
  q.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  go.addEventListener('click', submit);
  // Refocus the input whenever main re-shows the panel (show()+focus() activates it but does not auto-focus the field).
  try {
    window.agentOS.launcher.onShow(function(){ try { q.focus(); q.select(); } catch(_){} });
  } catch(_){}
  window.addEventListener('load', function(){ try { q.focus(); } catch(_){} });
</script></body></html>`
}

function ensureWindow(): BrowserWindow {
  if (launcherWin && !launcherWin.isDestroyed()) return launcherWin
  const win = new BrowserWindow({
    width: LAUNCHER_W,
    height: LAUNCHER_H,
    // type:'panel' (macOS NSPanel) + always-on-top 'floating' = the same non-stealing overlay the
    // onboarding dragHelper uses. The ONE difference from that helper: focusable:true, so the user can
    // type into the prompt (the drag helper is focusable:false because it must never take focus).
    type: process.platform === 'darwin' ? 'panel' : undefined,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  win.on('closed', () => { if (launcherWin === win) launcherWin = null })
  // Hide (not close) when the user clicks away — a global hotkey toggles it back, so it stays warm.
  win.on('blur', () => { if (launcherWin && !launcherWin.isDestroyed()) launcherWin.hide() })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setMenuBarVisibility(false)
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(launcherHtml()))
  launcherWin = win
  return win
}

function positionWindow(win: BrowserWindow): void {
  // Top-third of the display under the cursor — the conventional Spotlight/Raycast spot, on whichever
  // monitor the user is looking at right now.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  win.setBounds({
    x: Math.round(area.x + (area.width - LAUNCHER_W) / 2),
    y: Math.round(area.y + area.height * 0.22),
    width: LAUNCHER_W,
    height: LAUNCHER_H
  })
}

export function showLauncher(): void {
  const win = ensureWindow()
  positionWindow(win)
  // Take focus so the user can immediately type. (show() activates the panel; the renderer's onShow then
  // focuses + selects the input, since a transparent panel won't auto-focus the field on its own.)
  win.show()
  win.focus()
  if (!win.isDestroyed()) win.webContents.send('launcher:show')
}

export function hideLauncher(): void {
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) launcherWin.hide()
}

export function toggleLauncher(): void {
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) hideLauncher()
  else showLauncher()
}

// Wire the Send IPC + register the global hotkey. Call once from app.whenReady AFTER wireLauncher.
export function registerLauncher(): void {
  // Send → start a Job. Returns the spawned planning agent's id (or an error string) so the renderer can
  // settle its sending state. On success, hide the bar and raise the main BlitzOS window so the user sees
  // the new job agent appear.
  ipcMain.handle('launcher:start-job', (_e, prompt: unknown) => {
    const goal = String(prompt ?? '').trim()
    if (!goal) return { ok: false, error: 'empty prompt' }
    if (!startJobFn) return { ok: false, error: 'launcher not wired (no workspace host yet)' }
    try {
      const r = startJobFn({ goal })
      if (r && r.ok === false) return { ok: false, error: r.error || 'start_job failed' }
      hideLauncher()
      try { focusMainFn?.() } catch { /* main window gone */ }
      return { ok: true, agentId: r?.agent?.id ?? null }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'start_job threw' }
    }
  })
  ipcMain.on('launcher:hide', () => hideLauncher())

  // The FIRST Electron globalShortcut in the tree (verified: none today). globalShortcut is process-wide
  // and survives until unregistered, so it is torn down on will-quit below. A failed registration (the OS
  // already owns that chord) is logged, not fatal — the in-app HUD (Shell B, later) is the fallback path.
  const accel = launcherHotkey()
  const ok = globalShortcut.register(accel, () => toggleLauncher())
  if (ok) console.log(`[launcher] global hotkey ${accel} → toggle job launcher`)
  else console.error(`[launcher] FAILED to register global hotkey ${accel} (already taken by another app?) — set BLITZ_LAUNCHER_HOTKEY to a free chord`)

  // Build the window up front (hidden) so the first hotkey press is instant.
  ensureWindow()

  app.on('will-quit', () => { try { globalShortcut.unregisterAll() } catch { /* ignore */ } })
}
