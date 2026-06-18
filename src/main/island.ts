// The Notch-spill Island (plans/blitzos-dynamic-island.md; RE'd from the notch-spill-poc) — a self-hosted
// "dynamic island" that lives in the macOS notch and SPILLS to fullscreen, handing off seamlessly to the
// real BlitzOS canvas. It is a NEW standalone Electron window (mirrors launcher.ts: an inline-HTML data: URL
// + the shared preload's `agentOS.island` bridge + a wire/register DI seam), NOT wired into the renderer
// (App.tsx/store), so the single-canvas-navigation WIP is untouched.
//
// The window covers the FULL primary display incl. the menu-bar/notch band (the PoC-proven config from
// notch-spill-poc/main.js, replicated EXACTLY): collapsed = click-through everywhere except the notch pill;
// click the pill or the hover-panel "Send" → the notch grows to fullscreen (during the morph the plate is
// #e9e9e7 = the BlitzOS canvas color / sandwich UI_BG / tokens --canvas, so the color is seamless, then on
// transitionend the plate goes TRANSPARENT so the REAL live canvas — windows, dock, tiles, the sandwich L0 —
// shows through; a passthrough plate that stayed opaque would just paint a flat blank screen, defeating the
// whole handoff) AND we ask index.ts to sandwich.setFullScreen(true) + raise the real BlitzOS window behind us,
// then go click-through (passthrough), leaving the pill as the collapse handle on top. Suck = restore the
// pre-spill sandwich fullscreen state + the island returns to the notch.
//
// STATE-SYNC: spill is NOT a thing the island owns alone — `pages` fullscreen is also driven by the green
// traffic light + the Ctrl+Cmd+F accelerator + macOS itself. So the island is a FOLLOWER: index.ts forwards the
// sandwich's real enter/leave-full-screen on the `island:fullscreen` channel and the renderer reconciles `open`
// to it (an external exit collapses the plate; an external enter is left to the user's own pill, since the
// island never wants to commandeer a non-island fullscreen). And hiding via ⌥Space while spilled SUCKS BACK
// first (shrink → restore fullscreen) so the sandwich can never strand in fullscreen with the collapse pill
// gone. The island only EXITS the fullscreen it itself entered (fill() captures the pre-spill state in main).
//
// The hover panel carries the Blitz ENTRY: a multiline prompt + a "Deep" on/off toggle + Send. Deep = the
// orchestrators/workflow capability. Send routes through the DI seam (filled by index.ts):
//   Deep ON  → startWorkflow({task, contextRefs:[], title})            (electronOps.startWorkflow)
//   Deep OFF → a = spawnAgent(title); userMessage(prompt, a.id)        (electronOps.spawnAgent + userMessage)
//
// The legacy native BlitzIsland.app + island-bridge.mjs (WS) are a SEPARATE path — distinct symbols
// (setIslandDeps / launchIslandHelper / recordIslandId), distinct IPC namespace (os:island-* here vs the WS
// bridge there). They are MUTUALLY EXCLUSIVE at runtime: exactly ONE owns the ⌥Space Carbon chord per launch
// (index.ts gates launchIslandHelper behind BLITZ_NATIVE_ISLAND and only registers ⌥Space for THIS island when
// the native helper is NOT launched) — never two Carbon owners of the same combo. Do NOT import from
// island-bridge.mjs.
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'

let islandWin: BrowserWindow | null = null

// The DI seam back to the OS control plane (same pattern as wireLauncher): index.ts injects the spawn seam
// (CALLing electronOps — Deep ON startWorkflow / Deep OFF spawnAgent+userMessage) + the fill/suck seam
// (CALLing sandwich.setFullScreen + raising mainWindow), so this module never imports
// osActions/electron-os-tools/sandwich (which would create an import cycle and pull the whole control plane
// into a window helper).
type SpawnResult = { ok?: boolean; id?: string | null; error?: string }
let sendFn: ((args: { prompt: string; deep: boolean }) => SpawnResult) | null = null
let fillFn: ((on: boolean) => void) | null = null

export function wireIsland(opts: {
  // Deep ON → startWorkflow; Deep OFF → spawnAgent + userMessage. Returns { ok, id } so the panel settles.
  send: (args: { prompt: string; deep: boolean }) => SpawnResult
  // on=true → capture the sandwich's pre-spill fullscreen + sandwich.setFullScreen(true) + raise mainWindow;
  // on=false → restore the pre-spill state (only exit fullscreen if the island itself entered it).
  fill: (on: boolean) => void
}): void {
  sendFn = opts.send
  fillFn = opts.fill
}

// Self-contained island UI. Ported from notch-spill-poc/{index.html, styles.css, renderer.js}: the NotchShape
// clip-path, the closed→fullscreen clip-path GROW (ease-out cubic-bezier(0.22,1,0.36,1) ≈ BlitzOS --ease-out),
// and the click-through region logic. ADDED: the Blitz hover panel (prompt + Deep toggle + Send) anchored under
// the notch, the transparent-on-spill reveal, the island:fullscreen follower, and the window.agentOS.island
// bridge calls (geometry/setInteractive/send/fill/onHide/onFullscreen). CSP locks it to inline style/script +
// data: images (it is a data: URL — an opaque origin, so the PoC's 'self' would not resolve; mirror launcher.ts).
//
// GROW BACKGROUND IS #e9e9e7 (= sandwich UI_BG / tokens --canvas) DURING the morph so the closed→open tween is a
// seamless color match; ON transitionend the plate drops to TRANSPARENT (body.spilled) so the live canvas behind
// it is the actual BlitzOS desktop, not a flat plate. The live-tuning arrow keys are DEV-ONLY (gated on a
// ?tune=1 hash so they never hijack the textarea cursor in the shipped island).
function islandHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<style>
  :root { color-scheme: light dark;
          --accent:#e31c30; --canvas:#e9e9e7; --ink:#1a1b1d; --muted:#797c7f;
          --font-ui:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter',system-ui,sans-serif; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; width:100%; background:transparent; overflow:hidden;
              font-family:var(--font-ui); color:var(--ink); -webkit-user-select:none; user-select:none; cursor:default; }
  /* #home grows from the notch to fullscreen via a clip-path morph; bg is the CANVAS color DURING the morph
     for a seamless color handoff, then drops to TRANSPARENT once spilled (body.spilled) so the real sandwich L0
     behind it shows through — an opaque plate would just paint a blank screen. Content STATIC inside (nothing
     scales). ease-out matches --ease-out. */
  #home { position:fixed; inset:0; background:var(--canvas);
          transition:clip-path 0.58s cubic-bezier(0.22,1,0.36,1); will-change:clip-path; }
  /* Fully spilled (the grow finished): the plate is transparent so the LIVE BlitzOS canvas shows through the
     passthrough window. Re-collapsing removes .spilled instantly so the suck-back tweens over the canvas color. */
  body.spilled #home { background:transparent; }
  /* The notch handle: always on top, the clickable protrusion (the collapse handle). clip-path (NotchShape) set in JS. */
  #notch { position:fixed; top:0; left:50%; transform:translateX(-50%); width:200px; height:38px;
           background:#000; z-index:10; cursor:pointer; display:grid; place-items:center; transition:background .2s; }
  #notch:hover { background:#0b0b0c; }
  .peek { display:flex; gap:5px; transition:opacity .25s; }
  .peek i { width:7px; height:7px; border-radius:2px; background:var(--c,#cfd0d2); }
  body.open .peek { opacity:0; }
  /* The Blitz hover panel: anchored just under the notch, shown on notch/panel hover (body.panel). It is NOT
     shown while spilled — spilled is passthrough, ONLY the pill stays as the collapse handle (see the mousemove
     handler), so a panel painting solid over the live canvas but unclickable would be a dead plate. */
  #panel { position:fixed; top:46px; left:50%; transform:translateX(-50%) translateY(-8px); z-index:11;
           width:560px; max-width:90vw; opacity:0; pointer-events:none; transition:opacity .18s, transform .18s;
           background:color-mix(in srgb,#fff 92%,transparent);
           -webkit-backdrop-filter:blur(20px) saturate(1.4); backdrop-filter:blur(20px) saturate(1.4);
           border-radius:18px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.06), 0 14px 40px rgba(0,0,0,.18);
           padding:12px 14px; }
  @media (prefers-color-scheme: dark){
    #panel { background:color-mix(in srgb,#1c1d1f 88%,transparent);
             box-shadow:inset 0 0 0 1px rgba(255,255,255,.08), 0 14px 40px rgba(0,0,0,.5); } }
  body.panel #panel { opacity:1; pointer-events:auto; transform:translateX(-50%) translateY(0); }
  .prow { display:flex; align-items:flex-end; gap:10px; }
  #pq { flex:1 1 auto; min-width:0; background:transparent; border:0; outline:0; resize:none; overflow:hidden;
        font-size:16px; line-height:1.35; max-height:120px; color:var(--ink); caret-color:var(--accent);
        -webkit-user-select:text; user-select:text; }
  #pq::placeholder { color:var(--muted); }
  .ctl { display:flex; align-items:center; gap:10px; margin-top:10px; }
  .deep { display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); cursor:pointer; }
  .sw { width:34px; height:20px; border-radius:10px; background:#d8d8d6; position:relative; transition:background .15s; }
  .sw::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%;
               background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.25); transition:left .15s; }
  .deep.on .sw { background:var(--accent); } .deep.on .sw::after { left:16px; }
  .sp { flex:1 1 auto; }
  .send { height:30px; border:0; border-radius:15px; background:var(--accent); color:#fff; cursor:pointer;
          padding:0 14px; font-size:14px; font-weight:600; box-shadow:0 1px 4px rgba(227,28,48,.4); }
  .send:disabled { opacity:.4; cursor:default; box-shadow:none; }
  /* live-tuning readout (arrow keys) — DEV ONLY (?tune=1); hidden in the shipped island. */
  #hud { position:fixed; left:12px; bottom:12px; z-index:20; font:11px var(--font-ui); color:#fff;
         background:rgba(0,0,0,.55); padding:5px 9px; border-radius:7px; pointer-events:none; opacity:.85; display:none; }
  body.tune #hud { display:block; }
</style></head><body>
  <div id="home"></div>
  <div id="notch"><div class="peek"><i style="--c:#e31c30"></i><i></i><i></i><i style="--c:#2e9e6b"></i></div></div>
  <div id="panel">
    <div class="prow"><textarea id="pq" rows="1" placeholder="Ask Blitz, or describe a task"></textarea></div>
    <div class="ctl">
      <div class="deep" id="deep" title="Deep = run as an orchestrated workflow">
        <span class="sw"></span><span>Deep</span>
      </div>
      <span class="sp"></span>
      <button class="send" id="send" disabled>Send</button>
    </div>
  </div>
  <div id="hud"></div>
  <script>
    var home=document.getElementById('home'), notch=document.getElementById('notch'),
        panel=document.getElementById('panel'), pq=document.getElementById('pq'),
        deep=document.getElementById('deep'), send=document.getElementById('send'), hud=document.getElementById('hud');
    var SCREEN_W=window.innerWidth, SCREEN_H=window.innerHeight, NOTCH_W=200, NOTCH_H=38, NOTCH_X=0;
    var open=false, deepOn=false, sending=false, hoverPanel=false;
    // DEV-ONLY live-tuning of the notch geometry (arrow keys). OFF unless the data: URL carries #tune=1, so it
    // can never preventDefault a textarea cursor move in the shipped island. (See the keydown guard below too.)
    var TUNE = /(?:^|[#&?])tune=1(?:&|$)/.test(location.hash || '');
    if (TUNE) document.body.classList.add('tune');

    // One generator → identical command list for closed + open so clip-path tweens cleanly (PoC notchPath).
    // Concave top fillets (tuck into the menu bar) + rounded bottom. y-DOWN, viewport px.
    function notchPath(left,top,w,h,t,b){ t=Math.max(0.5,Math.min(t,w/2)); b=Math.max(0.5,Math.min(b,h-t,(w-2*t)/2));
      var L=left,T=top,R=left+w,B=top+h;
      return "path('M "+L+" "+T+" Q "+(L+t)+" "+T+" "+(L+t)+" "+(T+t)+" L "+(L+t)+" "+(B-b)+" "+
             "Q "+(L+t)+" "+B+" "+(L+t+b)+" "+B+" L "+(R-t-b)+" "+B+" Q "+(R-t)+" "+B+" "+(R-t)+" "+(B-b)+" "+
             "L "+(R-t)+" "+(T+t)+" Q "+(R-t)+" "+T+" "+R+" "+T+" Z')"; }
    function closedClip(){ var cx=SCREEN_W/2+NOTCH_X; return notchPath(cx-NOTCH_W/2,0,NOTCH_W,NOTCH_H,7,16); }
    function openClip(){ return notchPath(0,0,SCREEN_W,SCREEN_H,1,1); }
    function applyGeom(){ var cx=SCREEN_W/2+NOTCH_X;
      notch.style.width=NOTCH_W+'px'; notch.style.height=NOTCH_H+'px'; notch.style.left=cx+'px';
      notch.style.transform='translateX(-50%)'; notch.style.clipPath=notchPath(0,0,NOTCH_W,NOTCH_H,7,16);
      home.style.clipPath=open?openClip():closedClip();
      hud.textContent='notch  W '+NOTCH_W+'  H '+NOTCH_H+'  x'+(NOTCH_X>=0?'+':'')+NOTCH_X+'   screen '+SCREEN_W+'x'+SCREEN_H+'   (← → ↑ ↓, ⇧← ⇧→, ⌥=1px)'; }

    // Click-through region: collapsed → interactive only over the notch pill OR the hover panel; spilled →
    // ONLY the notch pill (the body is passthrough so clicks reach the REAL canvas behind the now-transparent
    // plate). This is the KEY correction to the PoC (whose open=whole-screen made sense only with its own fake
    // board). The panel is HIDDEN while spilled to match (no dead plate over the live canvas).
    var lastI=null;
    function setI(on){ if(on!==lastI){ lastI=on; try{ window.agentOS.island.setInteractive(on); }catch(_){} } }
    function inRect(el,x,y){ var r=el.getBoundingClientRect(); return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom; }
    document.addEventListener('mousemove',function(e){
      var overNotch=inRect(notch,e.clientX,e.clientY);
      if(open){ document.body.classList.remove('panel'); setI(overNotch); return; }   // spilled: pill-only (collapse handle); rest falls through to the canvas
      hoverPanel = overNotch || inRect(panel,e.clientX,e.clientY) || (document.activeElement===pq);
      document.body.classList.toggle('panel', hoverPanel);
      setI(overNotch || hoverPanel);
    });

    // The plate is the CANVAS color during the morph (seamless color); once the grow finishes, drop to
    // TRANSPARENT so the live BlitzOS canvas shows through (body.spilled). Only when it actually grew (open).
    home.addEventListener('transitionend',function(e){
      if(e.propertyName==='clip-path' && open) document.body.classList.add('spilled');
    });

    // GROW to fullscreen + ask main to fill the real canvas; SHRINK + tell main to suck back. The clip-path
    // tween (CSS) is the visible spill; the fill() bridge drives the real canvas behind it (index.ts). On grow
    // the plate stays canvas-colored until transitionend, THEN goes transparent (the reveal). On shrink we drop
    // .spilled FIRST so the plate is opaque again and the suck-back tweens over the canvas color, never blank.
    function grow(){ if(open) return; open=true; document.body.classList.add('open');
      home.style.clipPath=openClip(); lastI=null; setI(true);
      try{ window.agentOS.island.fill(true); }catch(_){} }     // → sandwich.setFullScreen(true) + raise mainWindow
    function shrink(){ if(!open) return; open=false;
      document.body.classList.remove('open'); document.body.classList.remove('spilled');
      home.style.clipPath=closedClip(); lastI=null;
      try{ window.agentOS.island.fill(false); }catch(_){} }    // → restore the pre-spill sandwich fullscreen
    function toggle(){ open?shrink():grow(); }
    notch.addEventListener('click',function(e){ e.stopPropagation(); toggle(); });

    // Blitz entry.
    function syncSend(){ send.disabled = !(pq.value.trim() && !sending); }
    function autoGrowQ(){ pq.style.height='auto'; pq.style.height=Math.min(120,pq.scrollHeight)+'px'; }
    pq.addEventListener('input',function(){ autoGrowQ(); syncSend(); });
    pq.addEventListener('focus',function(){ document.body.classList.add('panel'); setI(true); });
    deep.addEventListener('click',function(){ deepOn=!deepOn; deep.classList.toggle('on',deepOn); });
    function submit(){ var prompt=pq.value.trim(); if(!prompt||sending) return; sending=true; syncSend();
      try{ window.agentOS.island.send(prompt, deepOn).then(function(r){
        sending=false; if(r&&r.ok){ pq.value=''; autoGrowQ(); grow(); } syncSend();
      }).catch(function(){ sending=false; syncSend(); }); }catch(_){ sending=false; syncSend(); } }
    send.addEventListener('click',submit);
    pq.addEventListener('keydown',function(e){
      if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); submit(); }   // Shift+Enter = newline
      else if(e.key==='Escape'){ e.preventDefault(); if(open) shrink(); else { pq.blur(); document.body.classList.remove('panel'); } } });

    // Geometry from main (real screen size + menu-bar height → notch height) + DEV-ONLY live tuning (?tune=1).
    try{ window.agentOS.island.onGeometry(function(g){
      SCREEN_W=(g&&g.width)||window.innerWidth; SCREEN_H=(g&&g.height)||window.innerHeight;
      if(g&&g.menuBarH&&g.menuBarH>0) NOTCH_H=Math.round(g.menuBarH); applyGeom(); }); }catch(_){}
    // FOLLOWER: main forwards the sandwich's real fullscreen state (green light / Ctrl+Cmd+F / macOS, not just
    // our own fill). If pages LEFT fullscreen while we are spilled, collapse so the plate doesn't cover a
    // non-fullscreen canvas. We do NOT auto-grow on an external ENTER — the island never commandeers a
    // fullscreen it didn't start. Re-collapse via shrink(), but DON'T re-issue fill(false) (main already knows
    // it left; shrink's fill would double-toggle), so we collapse the plate directly here.
    try{ window.agentOS.island.onFullscreen(function(on){
      if(!on && open){ open=false; document.body.classList.remove('open'); document.body.classList.remove('spilled');
        document.body.classList.remove('panel'); home.style.clipPath=closedClip(); lastI=null; setI(false); }
    }); }catch(_){}
    // SUCK-BACK ON HIDE: ⌥Space-off / any hide while spilled must restore the sandwich first (else it strands in
    // fullscreen with the collapse pill gone). Main fires this just before islandWin.hide().
    try{ window.agentOS.island.onHide(function(){ if(open) shrink(); }); }catch(_){}

    window.addEventListener('keydown',function(e){
      // DEV-ONLY notch tuning. Hard-gated: never run unless ?tune=1, and never while typing in the prompt (an
      // arrow key must move the textarea cursor, not resize the notch + preventDefault the keystroke).
      if(!TUNE) return;
      var t=document.activeElement; if(t===pq || (t&&(t.isContentEditable||t.tagName==='INPUT'||t.tagName==='TEXTAREA'))) return;
      var step=e.altKey?1:4; var h=true;
      if(e.key==='ArrowLeft'){ if(e.shiftKey) NOTCH_X-=step; else NOTCH_W=Math.max(40,NOTCH_W-step); }
      else if(e.key==='ArrowRight'){ if(e.shiftKey) NOTCH_X+=step; else NOTCH_W+=step; }
      else if(e.key==='ArrowUp'){ NOTCH_H=Math.max(16,NOTCH_H-2); }
      else if(e.key==='ArrowDown'){ NOTCH_H+=2; }
      else h=false; if(h){ e.preventDefault(); applyGeom(); } });
    applyGeom();
  </script></body></html>`
}

function ensureWindow(): BrowserWindow {
  if (islandWin && !islandWin.isDestroyed()) return islandWin
  const display = screen.getPrimaryDisplay()
  const b = display.bounds // FULL screen incl. the menu-bar/notch band (workArea would exclude it)
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    // PoC-proven config (notch-spill-poc/main.js) — replicate EXACTLY so the frame covers the notch. NOTE:
    // transparent:true (unlike launcher.ts's vibrancy window) — the island must show the real desktop / the
    // real canvas through its click-through body; native vibrancy would frost the whole screen and defeat that.
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false, // our own CSS "fullscreen" via a clip-path grow, never the native green-button kind
    skipTaskbar: true,
    enableLargerThanScreen: true, // permit a frame covering the full display incl. the menu-bar band
    backgroundColor: '#00000000', // fully transparent base
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
  })
  // Float above EVERYTHING incl. the menu bar + ride every Space (and other apps' fullscreen) so the island
  // serves both "anywhere over macOS" and "in BlitzOS". 'screen-saver' is the highest Electron level
  // (NSScreenSaverWindowLevel 1000 > the menu bar's 24). The spilled plate is TRANSPARENT (body.spilled), so
  // the real canvas behind it composites through even at this level — no need to raise the sandwich above us.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }) // re-assert so y reaches the menu-bar band (Electron clamps to workArea otherwise)
  // Start COLLAPSED == click-through everywhere; forward:true still delivers mousemove so the renderer can
  // detect "over the notch handle / panel" and flip hits on there. Toggled by os:island-interactive.
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setMenuBarVisibility(false)
  win.on('closed', () => { if (islandWin === win) islandWin = null })
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(islandHtml()))
  islandWin = win
  return win
}

// Push the real display geometry to the renderer (screen size + the menu-bar height it uses as the notch height).
function sendGeometry(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const d = screen.getPrimaryDisplay()
  win.webContents.send('island:geometry', {
    width: d.bounds.width,
    height: d.bounds.height,
    menuBarH: Math.max(0, d.workArea.y - d.bounds.y),
    scaleFactor: d.scaleFactor
  })
}

export function showIsland(): void {
  const win = ensureWindow()
  const b = screen.getPrimaryDisplay().bounds
  // showInactive (NOT show()/focus()) — the island must NEVER steal focus from whatever app the user is over
  // (the whole point of an all-Spaces overlay; PoC requirement 4).
  win.showInactive()
  // Re-assert AFTER show (Electron clamps a window's y into the workArea, below the menu bar, until bounds are
  // re-set post-show) + re-assert the level, then push geometry. A t+700ms re-assert defeats the late clamp
  // that would land the notch pill ~37px too low (the PoC's exact placement fix).
  win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) sendGeometry(win) })
  } else {
    sendGeometry(win)
  }
  setTimeout(() => { if (!win.isDestroyed()) win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height }) }, 700)
}

// Hide the island. If it is spilled, SUCK BACK FIRST (the renderer's onHide runs shrink → restore the sandwich
// fullscreen) so we never strand the sandwich in fullscreen with the collapse pill gone. The actual hide is
// deferred a beat so the suck-back's fill(false) round-trips to main before the window vanishes.
export function hideIsland(): void {
  const win = islandWin
  if (!win || win.isDestroyed() || !win.isVisible()) return
  try { win.webContents.send('island:hide') } catch { /* mid-teardown */ }
  // Give the renderer one tick to run shrink() → fill(false) (restore the sandwich) before the window hides.
  setTimeout(() => { if (win && !win.isDestroyed() && win.isVisible()) win.hide() }, 60)
}

export function toggleIsland(): void {
  if (islandWin && !islandWin.isDestroyed() && islandWin.isVisible()) hideIsland()
  else showIsland()
}

// Push the sandwich's REAL fullscreen state to the island so it can follow (collapse on an external exit). Called
// from index.ts on the sandwich's pages enter/leave-full-screen. No-op if the island isn't up.
export function pushIslandFullscreen(on: boolean): void {
  if (islandWin && !islandWin.isDestroyed()) {
    try { islandWin.webContents.send('island:fullscreen', { on: !!on }) } catch { /* mid-teardown */ }
  }
}

// Wire the IPC handlers. Call ONCE from app.whenReady AFTER wireIsland. All channels are NEW + island:-namespaced
// (no collision with launcher:* / os:shell-* / the legacy island-bridge WS).
export function registerIsland(): void {
  // Collapsed → only the notch/panel captures clicks; spilled → only the notch pill (the body is passthrough).
  // The renderer flips this as the pointer enters/leaves the interactive region (the PoC's 'interactive' channel).
  ipcMain.on('os:island-interactive', (_e, on: boolean) => {
    if (islandWin && !islandWin.isDestroyed()) islandWin.setIgnoreMouseEvents(!on, { forward: true })
  })
  // Send → spawn via the DI seam (Deep ON → startWorkflow; Deep OFF → spawnAgent + userMessage). The seam may
  // throw 'no workspace host' before a host exists (same as the launcher); the try/catch surfaces { ok:false }
  // and the renderer leaves the panel up.
  ipcMain.handle('os:island-send', (_e, payload: { prompt?: unknown; deep?: unknown }) => {
    const prompt = String(payload?.prompt ?? '').trim()
    if (!prompt) return { ok: false, error: 'empty prompt' }
    if (!sendFn) return { ok: false, error: 'island not wired (no workspace host yet)' }
    try {
      const r = sendFn({ prompt, deep: !!payload?.deep })
      return r && r.ok !== false ? { ok: true, id: r.id ?? null } : { ok: false, error: r?.error || 'send failed' }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || 'send threw' }
    }
  })
  // Fill/suck → drive the sandwich + the real window via the DI seam (grow → capture pre-spill fullscreen +
  // fullscreen + raise; suck → restore the pre-spill state). The seam owns the "only exit the fullscreen we
  // entered" logic (index.ts), so the island never yanks the user out of a fullscreen it didn't start.
  ipcMain.on('os:island-fill', (_e, on: boolean) => {
    try { fillFn?.(!!on) } catch { /* sandwich / mainWindow gone */ }
  })
}
