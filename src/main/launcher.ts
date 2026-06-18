// The STANDALONE Job Launcher (Shell A of plans/blitzos-job-entrypoints.md) — a global Raycast-style bar.
//
// A global hotkey (default ⌥Space; BLITZ_LAUNCHER_HOTKEY overrides) TOGGLES a small always-on-top
// NSPanel: the user types a prompt AND drops files/folders OR a browser tab/link onto the bar (shown as
// attachment chips), then Send → electronOps.startJob({ goal, contextRefs }), which mints a Job whose planning agent
// authors the editable plan widget. The bar STAYS OPEN while gathering (no hide-on-blur), so dragging
// from Finder or clicking another window never vanishes it; dismiss is explicit (Esc / Send / re-toggle).
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
// A2 (drag-drop files/folders → Job context) is wired: dropped paths ride to start_job as `contextRefs`
//   so the planning agent sees them in scope. TODO(A2-ingest): optionally COPY/symlink them INTO the
//   workspace folder + associate a jobId (touches osIngestPaths + the three-serializer persistence rule).
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
let startJobFn: ((spec: { goal: string; contextRefs?: string[] }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string }) | null = null
let focusMainFn: (() => void) | null = null
export function wireLauncher(opts: {
  startJob: (spec: { goal: string; contextRefs?: string[] }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string }
  focusMain: () => void
}): void {
  startJobFn = opts.startJob
  focusMainFn = opts.focusMain
}

// Self-contained launcher UI. CSP locks it to inline style/script only; the window shares the app preload,
// so the bar talks to main through `window.agentOS.launcher` and reuses `agentOS.dropPaths` to resolve
// dropped File objects to absolute OS paths. Enter submits, Esc hides; dropped files become attachment
// chips; the bar reports its content height so main can grow/shrink the window to fit (autosize).
function launcherHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; padding:0; height:auto; overflow:hidden; background:transparent; -webkit-user-select:none; user-select:none;
              font-family:-apple-system,system-ui,sans-serif; }
  .wrap { padding:10px 12px 16px; box-sizing:border-box; }
  .bar { box-sizing:border-box; padding:16px 18px; display:flex; flex-direction:column; gap:11px;
         background:rgba(245,245,247,0.86); border-radius:18px; border:1px solid rgba(0,0,0,0.10);
         -webkit-backdrop-filter:saturate(1.3) blur(24px); backdrop-filter:saturate(1.3) blur(24px);
         box-shadow:0 10px 30px rgba(0,0,0,0.24); transition:border-color .12s, box-shadow .12s; }
  .bar.drag { border-color:#0a84ff; box-shadow:0 0 0 2px rgba(10,132,255,0.45), 0 10px 30px rgba(0,0,0,0.24); }
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
  .atts { display:flex; flex-wrap:wrap; gap:6px; }
  .atts:empty { display:none; }
  .chip { display:flex; align-items:center; gap:6px; max-width:260px; font-size:12px; line-height:1;
          padding:5px 6px 5px 8px; border-radius:8px; background:rgba(0,0,0,0.06); border:1px solid rgba(0,0,0,0.08); }
  @media (prefers-color-scheme: dark){ .chip{ background:rgba(255,255,255,0.10); border-color:rgba(255,255,255,0.12); } }
  .chip .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chip .rm { flex:0 0 auto; cursor:pointer; border:0; background:transparent; color:inherit; opacity:0.5; font-size:14px; line-height:1; padding:0 1px; }
  .chip .rm:hover { opacity:1; }
  .hint { display:flex; align-items:center; justify-content:space-between; font-size:11px; opacity:0.5; }
  kbd { font-family:inherit; font-size:11px; padding:1px 5px; border-radius:5px; background:rgba(0,0,0,0.08); }
  @media (prefers-color-scheme: dark){ kbd { background:rgba(255,255,255,0.12); } }
</style></head><body>
<div class="wrap"><div class="bar" id="bar">
  <div class="row">
    <span class="glyph">&#9889;</span>
    <input id="q" type="text" autocomplete="off" spellcheck="false" placeholder="Start a job&hellip; describe what you want done">
    <button class="send" id="go" disabled>Send</button>
  </div>
  <div class="atts" id="atts"></div>
  <div class="hint"><span id="lbl">BlitzOS Job Launcher</span><span><kbd>&#9166;</kbd> start &nbsp; <kbd>esc</kbd> close &nbsp; drop files / a tab to attach</span></div>
</div></div>
<script>
  var q = document.getElementById('q');
  var go = document.getElementById('go');
  var bar = document.getElementById('bar');
  var attsEl = document.getElementById('atts');
  var lbl = document.getElementById('lbl');
  var attachments = []; // [{ path, name }]
  var sending = false;

  function basename(p){ var s = String(p || ''); if (s.charAt(s.length - 1) === '/') s = s.slice(0, -1); var i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
  function isUrl(p){ var s = String(p).slice(0, 8).toLowerCase(); return s.indexOf('http://') === 0 || s.indexOf('https://') === 0; }
  function labelFor(p){ if (isUrl(p)) { var s = String(p); var i = s.indexOf('://'); var rest = i >= 0 ? s.slice(i + 3) : s; var slash = rest.indexOf('/'); return (slash >= 0 ? rest.slice(0, slash) : rest) || p; } return basename(p) || p; }
  function sync(){ go.disabled = sending || q.value.trim().length === 0; }
  function autosize(){ try { window.agentOS.launcher.autosize(Math.ceil(document.querySelector('.wrap').getBoundingClientRect().height)); } catch(_){} }
  function renderAtts(){
    attsEl.textContent = '';
    attachments.forEach(function(a, idx){
      var chip = document.createElement('span'); chip.className = 'chip';
      var ic = document.createElement('span'); ic.textContent = a.url ? '\\uD83C\\uDF10' : '\\uD83D\\uDCCE';
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = a.name; nm.title = a.path;
      var rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\\u00D7';
      rm.addEventListener('click', function(){ attachments.splice(idx, 1); renderAtts(); sync(); });
      chip.appendChild(ic); chip.appendChild(nm); chip.appendChild(rm); attsEl.appendChild(chip);
    });
    lbl.textContent = attachments.length ? (attachments.length + ' attachment' + (attachments.length > 1 ? 's' : '')) : 'BlitzOS Job Launcher';
    autosize();
  }
  function addPaths(paths){
    var have = {}; attachments.forEach(function(a){ have[a.path] = 1; });
    (paths || []).forEach(function(p){ if (p && !have[p]) { have[p] = 1; attachments.push({ path: p, name: labelFor(p), url: isUrl(p) }); } });
    renderAtts(); sync(); try { q.focus(); } catch(_){}
  }
  function hide(){ try { window.agentOS.launcher.hide(); } catch(_){} }
  function submit(){
    var goal = q.value.trim();
    if (!goal || sending) return;
    sending = true; sync();
    var paths = attachments.map(function(a){ return a.path; });
    try {
      window.agentOS.launcher.startJob(goal, paths).then(function(){ q.value=''; attachments=[]; renderAtts(); sending=false; sync(); hide(); })
        .catch(function(){ sending=false; sync(); });
    } catch(_) { sending=false; sync(); }
  }
  q.addEventListener('input', sync);
  q.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  go.addEventListener('click', submit);

  // Drag-drop attachments. preventDefault on window dragover/drop so Electron does NOT navigate the
  // webContents to the dropped file (that would destroy this UI); resolve File -> absolute path via the
  // shared preload helper (webUtils.getPathForFile), then show chips. Folders resolve to their path too.
  function stop(e){ e.preventDefault(); e.stopPropagation(); }
  var dragDepth = 0;
  window.addEventListener('dragenter', function(e){ stop(e); dragDepth++; bar.classList.add('drag'); });
  window.addEventListener('dragover', stop);
  window.addEventListener('dragleave', function(e){ stop(e); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) bar.classList.remove('drag'); });
  window.addEventListener('drop', function(e){
    stop(e); dragDepth = 0; bar.classList.remove('drag');
    var dt = e.dataTransfer;
    var files = (dt && dt.files) ? Array.prototype.slice.call(dt.files) : [];
    var paths = [];
    try { paths = (window.agentOS && window.agentOS.dropPaths) ? window.agentOS.dropPaths(files) : []; } catch(_){}
    // Also accept a dragged browser TAB / link (a URL via uri-list or plain text) → attach as a URL ref.
    if (!paths.length && dt) {
      var uri = '';
      try { uri = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch(_){}
      uri = String(uri).split('\\n')[0].trim();
      if (isUrl(uri)) paths = [uri];
    }
    addPaths(paths);
  });

  // Refocus + re-measure whenever main re-shows the panel.
  try { window.agentOS.launcher.onShow(function(){ try { q.focus(); q.select(); } catch(_){} autosize(); }); } catch(_){}
  window.addEventListener('load', function(){ try { q.focus(); } catch(_){} autosize(); });
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
    // Resizable so the autosize IPC can grow/shrink the window to fit attachment chips (programmatic
    // setBounds is unreliable on a non-resizable macOS window); width is LOCKED via min/max, height bounded.
    resizable: true,
    minWidth: LAUNCHER_W,
    maxWidth: LAUNCHER_W,
    minHeight: 96,
    maxHeight: 600,
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
  // NO hide-on-blur: the bar must STAY OPEN while the user gathers attachments — dragging a file from
  // Finder or clicking another window blurs the panel, and auto-hiding there would vanish it mid-attach
  // (the reported bug). Dismiss is explicit: Esc, Send, or the ⌥Space toggle.
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
  // Send → start a Job. Accepts { prompt, attachments } (attachments = absolute OS paths the user dropped
  // onto the bar; they ride to start_job as `contextRefs` so the planning agent sees them in scope). A bare
  // string prompt is still accepted (back-compat). Returns the spawned planning agent's id (or an error) so
  // the renderer settles its sending state; on success, hide the bar and raise the main BlitzOS window.
  ipcMain.handle('launcher:start-job', (_e, payload: unknown) => {
    const obj = (payload && typeof payload === 'object')
      ? (payload as { prompt?: unknown; attachments?: unknown })
      : { prompt: payload, attachments: [] }
    const goal = String(obj.prompt ?? '').trim()
    if (!goal) return { ok: false, error: 'empty prompt' }
    if (!startJobFn) return { ok: false, error: 'launcher not wired (no workspace host yet)' }
    const contextRefs = Array.isArray(obj.attachments)
      ? obj.attachments.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
    try {
      const r = startJobFn({ goal, contextRefs })
      if (r && r.ok === false) return { ok: false, error: r.error || 'start_job failed' }
      hideLauncher()
      try { focusMainFn?.() } catch { /* main window gone */ }
      return { ok: true, agentId: r?.agent?.id ?? null }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'start_job threw' }
    }
  })
  ipcMain.on('launcher:hide', () => hideLauncher())
  // The bar reports its content height (the `.wrap` box) so the window grows/shrinks to fit attachment
  // chips. Width stays LAUNCHER_W; height is clamped to the window's [96,600] min/max band.
  ipcMain.on('launcher:autosize', (_e, h: unknown) => {
    if (!launcherWin || launcherWin.isDestroyed()) return
    const height = Math.max(96, Math.min(600, Math.round(Number(h) || LAUNCHER_H)))
    const b = launcherWin.getBounds()
    if (b.height !== height) launcherWin.setBounds({ x: b.x, y: b.y, width: LAUNCHER_W, height })
  })

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
