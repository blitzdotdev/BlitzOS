// The STANDALONE Launcher (Shell A of plans/blitzos-job-entrypoints.md) — a global Raycast-style bar
// with a message/tray toggle (a self-hosted "dynamic island" tray, the NotchNook/Boring-Notch idea: there
// is no native macOS Dynamic Island API on any version, so apps draw their own always-on-top window — we do
// the same).
//
// A global hotkey (default ⌥Space; BLITZ_LAUNCHER_HOTKEY overrides) TOGGLES the window. Two modes:
//   MESSAGE — a minimal multiline prompt; if the tray holds items it shows a count badge.
//   TRAY    — a big drop zone showing dropped files/folders/tabs as proper Finder-icon previews.
// Dragging anything over the bar AUTO-EXPANDS it into tray mode (a large target — the small bar was too
// short to drop onto), and Send → electronOps.startWorkflow({ task, contextRefs }) spawns an orchestrator
// agent seeded with the task. The bar STAYS OPEN while gathering (no hide-on-blur), so dragging
// from Finder or clicking another window never vanishes it; dismiss is explicit (Esc / Send / re-toggle).
//
// The window is its OWN isolated UI (a self-contained inline HTML data: URL + the shared preload's
// `agentOS.launcher` bridge) — it is NOT wired into the renderer (App.tsx/store/PrimarySpace), so the
// user's single-canvas-navigation WIP is untouched.
//
// The window is a NORMAL frameless always-on-top window, deliberately NOT a macOS panel. An NSPanel
// defaults hidesOnDeactivate to YES, so the bar vanished the instant the user clicked Finder to grab a
// file (the reported drag-drop blocker); a normal NSWindow keeps it visible while the app is in the
// background. The frosted-glass look is NATIVE macOS vibrancy (NSVisualEffectView): a standalone
// transparent window cannot frost the desktop with CSS backdrop-filter (the way the in-renderer radial
// menu does), because there is nothing in its own document to sample. It takes key focus on reveal
// (focusable:true + show()+focus()) so the user can type.
//
// A2 (drag-drop files/folders → workflow context) is wired: dropped paths ride to start_workflow as `contextRefs`
//   so the orchestrator agent sees them in scope. TODO(A2-ingest): optionally COPY/symlink them INTO the
//   workspace folder (touches osIngestPaths + the three-serializer persistence rule).
// TODO(A3): a real "add browser tab" affordance + favicon/thumbnail previews (today a dragged tab/link is
//   accepted as a URL ref with a globe glyph). The extension-reframe is in job-entrypoints.md §3.
// TODO(B): the same UI behind an in-app keybind HUD over the BlitzOS window (Shell B) — share the HTML
//   when that lands instead of duplicating it.
// TODO(notch): anchor the island under the camera notch (reference the open-source Boring Notch behavior)
//   instead of top-center; this POC uses the conventional Spotlight/Raycast top-center spot.
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'

// NOTE: ⌥Space is owned by the NATIVE dynamic island (BlitzIsland.app, Carbon RegisterEventHotKey), NOT
// this Electron launcher — see plans/blitzos-dynamic-island.md (P0c). This module no longer registers a
// global hotkey (registering the same chord would double-fire: the island AND this bar). Its window +
// Send IPC stay available for a possible in-app Shell B HUD.

// The native macOS vibrancy material (the frosted glass). 'under-window' is an adaptive light/dark
// translucency that reads as system glass on macOS 26 (Tahoe). BLITZ_LAUNCHER_VIBRANCY overrides it
// (e.g. 'hud', 'fullscreen-ui', 'sidebar', 'menu', 'popover') so the look can be tuned without a rebuild.
type Vibrancy = NonNullable<Electron.BrowserWindowConstructorOptions['vibrancy']>
function launcherVibrancy(): Vibrancy {
  const v = (process.env.BLITZ_LAUNCHER_VIBRANCY || '').trim()
  return (v || 'under-window') as Vibrancy
}

const LAUNCHER_W = 640
const LAUNCHER_H = 72
const LAUNCHER_MAX_H = 560

let launcherWin: BrowserWindow | null = null
// The seam back to the OS control plane — index.ts injects start_workflow + a focus-main callback, so this
// module never imports osActions/electron-os-tools (which would create an import cycle and pull the whole
// control plane into a window helper). Same DI pattern as setLaunchAgent / setBootTaskProvider.
let startWorkflowFn: ((spec: { task: string; contextRefs?: string[] }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string }) | null = null
let focusMainFn: (() => void) | null = null
export function wireLauncher(opts: {
  startWorkflow: (spec: { task: string; contextRefs?: string[] }) => { ok?: boolean; agent?: { id: string; title?: string }; error?: string }
  focusMain: () => void
}): void {
  startWorkflowFn = opts.startWorkflow
  focusMainFn = opts.focusMain
}

// Self-contained launcher UI. CSP locks it to inline style/script + data: images (the Finder-icon previews
// arrive as data URLs); the window shares the app preload, so the bar talks to main through
// `window.agentOS.launcher` (startWorkflow / hide / autosize / fileIcon / onShow) and `agentOS.dropPaths`.
//
// VISUALS: the native vibrancy window IS the glass panel (rounded + shadowed by macOS), so the DOM stays
// transparent and only paints content on top. MESSAGE mode = a Blitz-red bolt, a multiline prompt, a tray
// toggle that shows the attachment count, and an accent send arrow that appears once you type. TRAY mode =
// a big drop area with proper Finder-icon previews (file/folder) or a globe (URL/tab), each removable.
// Colors are the BlitzOS token values inlined (the window cannot import tokens.css): accent #e31c30, with
// ink/muted/chip tones that flip with the system theme so they stay legible on light or dark glass.
function launcherHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<style>
  :root { color-scheme: light dark;
          --accent:#e31c30; --ink:#1a1b1d; --muted:rgba(60,60,67,0.5);
          --chip:rgba(0,0,0,0.05); --chip-line:rgba(0,0,0,0.09); --hair:rgba(0,0,0,0.10); }
  @media (prefers-color-scheme: dark){
    :root { --ink:#f5f6f7; --muted:rgba(235,235,245,0.45);
            --chip:rgba(255,255,255,0.07); --chip-line:rgba(255,255,255,0.12); --hair:rgba(255,255,255,0.12); }
  }
  html,body { margin:0; padding:0; height:auto; overflow:hidden; background:transparent; color:var(--ink);
              -webkit-user-select:none; user-select:none;
              font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter',system-ui,sans-serif; }
  .wrap { padding:0 16px; box-sizing:border-box; }
  button { font-family:inherit; }
  .ib { flex:0 0 auto; border:0; background:transparent; color:var(--ink); cursor:pointer; padding:0;
        width:30px; height:30px; border-radius:8px; display:grid; place-items:center; position:relative; opacity:0.62; }
  .ib:hover { opacity:1; background:var(--chip); }
  .ib svg { width:18px; height:18px; display:block; }
  .badge { position:absolute; top:-3px; right:-3px; min-width:15px; height:15px; padding:0 3px; box-sizing:border-box;
           border-radius:8px; background:var(--accent); color:#fff; font-size:10px; font-weight:600; line-height:15px;
           text-align:center; display:none; }
  .badge.on { display:block; }
  .go { flex:0 0 auto; height:28px; border:0; border-radius:14px; cursor:pointer; padding:0 4px; min-width:28px;
        background:var(--accent); color:#fff; display:none; align-items:center; gap:5px; justify-content:center;
        box-shadow:0 1px 4px rgba(227,28,48,0.40); }
  .go.on { display:inline-flex; }
  .go:disabled { opacity:0.4; cursor:default; box-shadow:none; }
  .go svg { width:15px; height:15px; display:block; }
  .go .lbl { font-size:13px; font-weight:600; padding-right:6px; }

  /* ---- MESSAGE MODE ---- */
  .msg { display:block; }
  body.tray-mode .msg { display:none; }
  .row { display:flex; align-items:center; gap:11px; min-height:64px; }
  .mark { flex:0 0 auto; width:21px; height:21px; display:block; }
  #q { flex:1 1 auto; min-width:0; background:transparent; border:0; outline:0; resize:none; overflow:hidden;
       font-size:18px; line-height:1.35; max-height:132px; color:var(--ink); caret-color:var(--accent);
       -webkit-user-select:text; user-select:text; padding:0; margin:0; }
  #q::placeholder { color:var(--muted); }

  /* ---- TRAY MODE ---- */
  .tray { display:none; }
  body.tray-mode .tray { display:block; }
  .tray-head { display:flex; align-items:center; gap:9px; min-height:48px; }
  .tray-title { font-size:13px; font-weight:600; letter-spacing:0.01em; }
  .tray-count { font-size:12px; color:var(--muted); }
  .tray-head .sp { flex:1 1 auto; }
  .drop { position:relative; min-height:150px; border-radius:14px; margin:0 0 14px;
          border:1.5px dashed var(--hair); box-sizing:border-box; }
  body.drag .drop { border-color:color-mix(in srgb, var(--accent) 60%, transparent);
                    background:color-mix(in srgb, var(--accent) 6%, transparent); }
  .grid { display:flex; flex-wrap:wrap; gap:4px; padding:10px; max-height:300px; overflow:auto; }
  .empty { position:absolute; inset:0; display:grid; place-items:center; text-align:center; padding:16px;
           color:var(--muted); font-size:13px; pointer-events:none; }
  .tile { width:92px; box-sizing:border-box; display:flex; flex-direction:column; align-items:center; gap:7px;
          padding:10px 4px 8px; border-radius:10px; position:relative; }
  .tile:hover { background:var(--chip); }
  .tile .pv { width:54px; height:54px; display:grid; place-items:center; }
  .tile .pv img { max-width:54px; max-height:54px; display:block; }
  .tile .pv .gl { width:40px; height:40px; opacity:0.55; }
  .tile .nm { font-size:11px; line-height:1.25; text-align:center; max-width:86px; max-height:28px; overflow:hidden;
              word-break:break-word; }
  .tile .rm { position:absolute; top:3px; right:7px; width:16px; height:16px; border:0; border-radius:50%;
              background:var(--chip-line); color:var(--ink); font-size:12px; line-height:16px; cursor:pointer;
              opacity:0; padding:0; }
  .tile:hover .rm { opacity:0.8; }
  .tile .rm:hover { opacity:1; }
</style></head><body>
<div class="wrap">
  <!-- MESSAGE MODE -->
  <div class="msg">
    <div class="row">
      <svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 L5 13.4 h5.1 L9.5 22 l9.5-12.1 h-5.6 L14.5 2 Z" fill="#e31c30"/></svg>
      <textarea id="q" rows="1" autocomplete="off" spellcheck="false" placeholder="Describe what you want done"></textarea>
      <button class="ib" id="trayBtn" type="button" title="Tray (drop files here)" aria-label="Open tray">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
        <span class="badge" id="badge"></span>
      </button>
      <button class="go" id="go" type="button" title="Start (Return)" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12 h12 M12 6 l6 6 -6 6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>
  <!-- TRAY MODE -->
  <div class="tray">
    <div class="tray-head">
      <button class="ib" id="backBtn" type="button" title="Back to message" aria-label="Back to message">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </button>
      <span class="tray-title">Tray</span>
      <span class="tray-count" id="trayCount"></span>
      <span class="sp"></span>
      <button class="go" id="go2" type="button" title="Start (Return)" disabled>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12 h12 M12 6 l6 6 -6 6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="lbl">Start</span>
      </button>
    </div>
    <div class="drop" id="drop">
      <div class="grid" id="grid"></div>
      <div class="empty" id="empty">Drag files, folders, or a browser tab here</div>
    </div>
  </div>
</div>
<script>
  var q = document.getElementById('q');
  var go = document.getElementById('go');
  var go2 = document.getElementById('go2');
  var trayBtn = document.getElementById('trayBtn');
  var backBtn = document.getElementById('backBtn');
  var badge = document.getElementById('badge');
  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var trayCount = document.getElementById('trayCount');
  var attachments = []; // [{ path, name, url }]
  var iconCache = {};   // path -> data URL ('' = no icon, use glyph)
  var sending = false;
  var mode = 'message';

  var GLOBE = '<svg class="gl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>';
  var FILEG = '<svg class="gl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  function basename(p){ var s = String(p || ''); if (s.charAt(s.length - 1) === '/') s = s.slice(0, -1); var i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
  function isUrl(p){ var s = String(p).slice(0, 8).toLowerCase(); return s.indexOf('http://') === 0 || s.indexOf('https://') === 0; }
  function labelFor(p){ if (isUrl(p)) { var s = String(p); var i = s.indexOf('://'); var rest = i >= 0 ? s.slice(i + 3) : s; var slash = rest.indexOf('/'); return (slash >= 0 ? rest.slice(0, slash) : rest) || p; } return basename(p) || p; }
  function autosize(){ try { window.agentOS.launcher.autosize(Math.ceil(document.querySelector('.wrap').getBoundingClientRect().height)); } catch(_){} }

  function grow(){ q.style.height = 'auto'; q.style.height = Math.min(132, q.scrollHeight) + 'px'; }
  function sync(){
    var has = q.value.trim().length > 0;
    var en = has && !sending;
    go.disabled = !en; go.classList.toggle('on', has);
    go2.disabled = !en; go2.classList.toggle('on', true);
    var n = attachments.length;
    badge.textContent = n; badge.classList.toggle('on', n > 0);
    trayCount.textContent = n ? (n + (n > 1 ? ' items' : ' item')) : '';
  }

  function tileFor(a, idx){
    var tile = document.createElement('div'); tile.className = 'tile';
    var pv = document.createElement('div'); pv.className = 'pv';
    var cached = iconCache[a.path];
    if (a.url) { pv.innerHTML = GLOBE; }
    else if (cached) { var im = document.createElement('img'); im.src = cached; pv.appendChild(im); }
    else if (cached === '') { pv.innerHTML = FILEG; }
    else {
      pv.innerHTML = FILEG; // optimistic glyph until the real icon resolves
      (function(path){
        try { window.agentOS.launcher.fileIcon(path).then(function(url){ iconCache[path] = url || ''; if (mode === 'tray') renderTray(); }).catch(function(){ iconCache[path] = ''; }); }
        catch(_) { iconCache[path] = ''; }
      })(a.path);
    }
    var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = a.name; nm.title = a.path;
    var rm = document.createElement('button'); rm.className = 'rm'; rm.type = 'button'; rm.textContent = '\\u00D7';
    rm.addEventListener('click', function(){ attachments.splice(idx, 1); render(); });
    tile.appendChild(rm); tile.appendChild(pv); tile.appendChild(nm);
    return tile;
  }
  function renderTray(){
    grid.textContent = '';
    attachments.forEach(function(a, idx){ grid.appendChild(tileFor(a, idx)); });
    empty.style.display = attachments.length ? 'none' : 'grid';
    autosize();
  }
  function render(){ sync(); if (mode === 'tray') renderTray(); else autosize(); }

  function setMode(m){
    mode = m;
    document.body.classList.toggle('tray-mode', m === 'tray');
    if (m === 'tray') renderTray(); else { try { q.focus(); } catch(_){} }
    autosize();
  }

  function addPaths(paths){
    var have = {}; attachments.forEach(function(a){ have[a.path] = 1; });
    var added = 0;
    (paths || []).forEach(function(p){ if (p && !have[p]) { have[p] = 1; attachments.push({ path: p, name: labelFor(p), url: isUrl(p) }); added++; } });
    if (added && mode !== 'tray') setMode('tray'); // reveal the previews
    render();
  }
  function hide(){ try { window.agentOS.launcher.hide(); } catch(_){} }
  function submit(){
    var task = q.value.trim();
    if (!task || sending) return;
    sending = true; sync();
    var paths = attachments.map(function(a){ return a.path; });
    try {
      window.agentOS.launcher.startWorkflow(task, paths).then(function(){ q.value=''; attachments=[]; iconCache={}; grow(); setMode('message'); sending=false; render(); hide(); })
        .catch(function(){ sending=false; sync(); });
    } catch(_) { sending=false; sync(); }
  }

  q.addEventListener('input', function(){ grow(); sync(); autosize(); });
  q.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }   // Shift+Enter = newline
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  go.addEventListener('click', submit);
  go2.addEventListener('click', submit);
  trayBtn.addEventListener('click', function(){ setMode('tray'); });
  backBtn.addEventListener('click', function(){ setMode('message'); });

  // Drag-drop. preventDefault on window dragover/drop so Electron does NOT navigate the webContents to the
  // dropped file (that would destroy this UI). Dragging anything over the bar AUTO-EXPANDS it into tray mode
  // so there is a big drop target (the message bar alone is too short to drop onto). Resolve File -> path via
  // the shared preload helper (webUtils.getPathForFile); a dragged tab/link arrives as a URL via uri-list.
  function stop(e){ e.preventDefault(); e.stopPropagation(); }
  var dragDepth = 0;
  window.addEventListener('dragenter', function(e){ stop(e); dragDepth++; if (dragDepth === 1) { document.body.classList.add('drag'); if (mode !== 'tray') setMode('tray'); } });
  window.addEventListener('dragover', stop);
  window.addEventListener('dragleave', function(e){ stop(e); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('drag'); });
  window.addEventListener('drop', function(e){
    stop(e); dragDepth = 0; document.body.classList.remove('drag');
    var dt = e.dataTransfer;
    var files = (dt && dt.files) ? Array.prototype.slice.call(dt.files) : [];
    var paths = [];
    try { paths = (window.agentOS && window.agentOS.dropPaths) ? window.agentOS.dropPaths(files) : []; } catch(_){}
    if (!paths.length && dt) {
      var uri = '';
      try { uri = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch(_){}
      uri = String(uri).split('\\n')[0].trim();
      if (isUrl(uri)) paths = [uri];
    }
    addPaths(paths);
  });

  // Refocus + re-measure whenever main re-shows the window.
  try { window.agentOS.launcher.onShow(function(){ if (mode === 'message') { try { q.focus(); q.select(); } catch(_){} } autosize(); }); } catch(_){}
  window.addEventListener('load', function(){ grow(); try { q.focus(); } catch(_){} sync(); autosize(); });
</script></body></html>`
}

function ensureWindow(): BrowserWindow {
  if (launcherWin && !launcherWin.isDestroyed()) return launcherWin
  const win = new BrowserWindow({
    width: LAUNCHER_W,
    height: LAUNCHER_H,
    // NOT a macOS panel: NSPanel defaults hidesOnDeactivate to YES, so the bar vanished the moment the
    // user clicked Finder to grab a file (the drag-drop blocker). A normal NSWindow keeps it visible while
    // the app is in the background. The frosted glass is NATIVE vibrancy (NSVisualEffectView) because a
    // standalone transparent window has nothing in-document for CSS backdrop-filter to sample.
    // visualEffectState:'active' keeps the glass vibrant even while non-key (it usually is, while you drag
    // from another app). roundedCorners + hasShadow give the native panel silhouette.
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    vibrancy: launcherVibrancy(),
    visualEffectState: 'active',
    roundedCorners: true,
    // Resizable so the autosize IPC can grow/shrink the window between message (compact) and tray (tall);
    // width is LOCKED via min/max, height bounded.
    resizable: true,
    minWidth: LAUNCHER_W,
    maxWidth: LAUNCHER_W,
    minHeight: 56,
    maxHeight: LAUNCHER_MAX_H,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: true,
    hasShadow: true,
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  win.on('closed', () => { if (launcherWin === win) launcherWin = null })
  // NO hide-on-blur: the bar must STAY OPEN while the user gathers attachments — dragging a file from
  // Finder or clicking another window blurs the window, and auto-hiding there would vanish it mid-attach
  // (the reported bug). Dismiss is explicit: Esc, Send, or the ⌥Space toggle.
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setHiddenInMissionControl(true) // overlay chrome, not a real app window — keep it out of Mission Control / Exposé
  win.setMenuBarVisibility(false)
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(launcherHtml()))
  launcherWin = win
  return win
}

function positionWindow(win: BrowserWindow): void {
  // Top-third of the display under the cursor — the conventional Spotlight/Raycast spot, on whichever
  // monitor the user is looking at right now. (TODO(notch): anchor under the camera notch instead.)
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  win.setBounds({
    x: Math.round(area.x + (area.width - LAUNCHER_W) / 2),
    y: Math.round(area.y + area.height * 0.18),
    width: LAUNCHER_W,
    height: LAUNCHER_H
  })
}

export function showLauncher(): void {
  const win = ensureWindow()
  positionWindow(win)
  // Take focus so the user can immediately type. (show() activates the window; the renderer's onShow then
  // focuses + selects the input, since the field won't auto-focus on its own.)
  win.show()
  win.focus()
  if (!win.isDestroyed()) win.webContents.send('launcher:show')
}

export function hideLauncher(): void {
  if (launcherWin && !launcherWin.isDestroyed() && launcherWin.isVisible()) launcherWin.hide()
}

// Wire the Send IPC + register the global hotkey. Call once from app.whenReady AFTER wireLauncher.
export function registerLauncher(): void {
  // Send → start a WORKFLOW (spawn an orchestrator agent seeded with the prompt). Accepts { prompt, attachments }
  // (attachments = absolute OS paths the user dropped onto the bar; they ride to start_workflow as `contextRefs`
  // so the orchestrator agent sees them in scope). A bare string prompt is still accepted (back-compat). Returns
  // the spawned agent's id (or an error) so the renderer settles its sending state; on success, hide the bar and
  // raise the main BlitzOS window.
  ipcMain.handle('launcher:start-workflow', (_e, payload: unknown) => {
    const obj = (payload && typeof payload === 'object')
      ? (payload as { prompt?: unknown; attachments?: unknown })
      : { prompt: payload, attachments: [] }
    const task = String(obj.prompt ?? '').trim()
    if (!task) return { ok: false, error: 'empty prompt' }
    if (!startWorkflowFn) return { ok: false, error: 'launcher not wired (no workspace host yet)' }
    const contextRefs = Array.isArray(obj.attachments)
      ? obj.attachments.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
    try {
      const r = startWorkflowFn({ task, contextRefs })
      if (r && r.ok === false) return { ok: false, error: r.error || 'start_workflow failed' }
      hideLauncher()
      try { focusMainFn?.() } catch { /* main window gone */ }
      return { ok: true, agentId: r?.agent?.id ?? null }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'start_workflow threw' }
    }
  })
  ipcMain.on('launcher:hide', () => hideLauncher())
  // The bar reports its content height (the `.wrap` box) so the window grows/shrinks between message and
  // tray. Width stays LAUNCHER_W; height is clamped to the window's [56, LAUNCHER_MAX_H] band.
  ipcMain.on('launcher:autosize', (_e, h: unknown) => {
    if (!launcherWin || launcherWin.isDestroyed()) return
    const height = Math.max(56, Math.min(LAUNCHER_MAX_H, Math.round(Number(h) || LAUNCHER_H)))
    const b = launcherWin.getBounds()
    if (b.height !== height) launcherWin.setBounds({ x: b.x, y: b.y, width: LAUNCHER_W, height })
  })
  // Real Finder icon for a dropped path → a PNG data URL the tray previews render. Folders get the folder
  // icon, files get their type / Quick Look icon. A URL or a vanished path has no icon → return '' (the UI
  // falls back to a glyph). Wrapped so a getFileIcon rejection never breaks the bar.
  ipcMain.handle('launcher:file-icon', async (_e, p: unknown) => {
    const path = String(p ?? '')
    if (!path || /^https?:\/\//i.test(path)) return ''
    try {
      const img = await app.getFileIcon(path, { size: 'large' })
      return img.isEmpty() ? '' : img.toDataURL()
    } catch {
      return ''
    }
  })

  // No global hotkey here: ⌥Space belongs to the native dynamic island (P0c). Registering the same chord
  // would double-fire (the island AND this bar would both open — the reported bug). The Send IPC handlers
  // above stay wired for a future in-app Shell B HUD; nothing binds the launcher to a global chord anymore.
}
