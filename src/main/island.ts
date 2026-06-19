// The Notch-spill Island (plans/blitzos-dynamic-island.md; RE'd from the notch-spill-poc + the native dynamic
// island) — a self-hosted "dynamic island" that lives in the macOS notch and SPILLS to fullscreen, handing off
// seamlessly to the real BlitzOS canvas. It is a NEW standalone Electron window (mirrors launcher.ts: an
// inline-HTML data: URL + the shared preload's `agentOS.island` bridge + a wire/register DI seam), NOT wired into
// the renderer (App.tsx/store), so the single-canvas-navigation WIP is untouched.
//
// THE ONE BLACK SHAPE. There is a single black plate (#home) whose clip-path morphs through three stops, exactly
// like the native dynamic island then continued to fullscreen:
//   closed  → the notch pill (small black NotchShape on the physical notch)
//   hover   → the BLACK shape GROWS into the island panel; the Blitz entry (prompt + Deep + Send) lives INSIDE
//             the black shape (white-on-black). This is the native dynamic-island hover-expand, NOT a separate
//             bar painted below the notch.
//   fill    → the SAME black shape grows to fullscreen while fading black → #e9e9e7 (the BlitzOS canvas color /
//             sandwich UI_BG / tokens --canvas), so the morph color-matches the real canvas.
// On fill we ask index.ts to sandwich.setFullScreen(true) + raise the real BlitzOS window BEHIND us. The plate
// stays OPAQUE (canvas-colored) until the sandwich's fullscreen ACTUALLY lands, then drops to TRANSPARENT so the
// REAL live canvas shows through. The reveal is SYNCED to the sandwich's real `enter-full-screen` (forwarded as
// island:fullscreen(true)), NOT to the CSS transitionend — the old code revealed on transitionend (~0.5s) while
// native fullscreen (a separate-Space transition) had not landed yet, so the transparent plate flashed the OLD
// space (the desktop / the app underneath = "it disappears, leaving macOS"). A safety timeout covers the
// already-fullscreen case (no enter event fires) + a dropped event. Suck = restore the pre-spill fullscreen and
// the shape shrinks back to the notch (opaque the whole way, covering the fullscreen-exit).
//
// STATE-SYNC: spill is NOT a thing the island owns alone — `pages` fullscreen is also driven by the green
// traffic light + the Ctrl+Cmd+F accelerator + macOS itself. So the island is a FOLLOWER: index.ts forwards the
// sandwich's real enter/leave-full-screen on the `island:fullscreen` channel and the renderer reconciles to it
// (an external exit collapses the plate; an external enter is left to the user's own pill, since the island never
// commandeers a non-island fullscreen). And hiding via ⌥Space while spilled SUCKS BACK first (shrink → restore
// fullscreen) so the sandwich can never strand in fullscreen with the collapse pill gone. The island only EXITS
// the fullscreen it itself entered (fill() captures the pre-spill state in main).
//
// The entry's Send routes through the DI seam (filled by index.ts):
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
import { appendFileSync } from 'node:fs'

let islandWin: BrowserWindow | null = null

// TEMP diagnostic (gated on BLITZ_ISLAND_DEBUG=1, off by default — remove once the notch interaction is confirmed):
// the notch did nothing on hover/click in one report while the build/types/inline-script-syntax were ALL clean, so
// log the load-bearing signals to /tmp/island-debug.log to find the real cause instead of guessing. setI() in the
// renderer fires on the FIRST mousemove regardless of result, so 'interactive' tells us whether mousemove is even
// delivered (forward:true) AND whether the notch hit-test ever turns true; 'fill' tells us the click landed; the
// showIsland bounds tell us whether the window actually covers the menu-bar/notch band (coversMenuBar).
const ISLAND_DEBUG = process.env.BLITZ_ISLAND_DEBUG === '1'
function islandLog(msg: string): void {
  if (!ISLAND_DEBUG) return
  try { appendFileSync('/tmp/island-debug.log', new Date().toISOString() + ' ' + msg + '\n') } catch { /* best-effort */ }
}

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
  // on=true → capture the sandwich's pre-spill fullscreen + sandwich.setFullScreen(true) + raise mainWindow, and
  //   cue island:fullscreen(true) when fullscreen lands (the renderer reveals on it); on=false → restore the
  //   pre-spill state (only exit fullscreen if the island itself entered it).
  fill: (on: boolean) => void
}): void {
  sendFn = opts.send
  fillFn = opts.fill
}

// Self-contained island UI. The NotchShape clip-path + the closed→fullscreen GROW (ease-out
// cubic-bezier(0.22,1,0.36,1) ≈ BlitzOS --ease-out) are ported from notch-spill-poc; the THREE-stop shape
// (closed → black panel with the entry inside → fullscreen) + the synced reveal are the native-island port. CSP
// locks it to inline style/script + data: images (it is a data: URL — an opaque origin, so the PoC's 'self'
// would not resolve; mirror launcher.ts).
//
// COLOR: the shape is BLACK while closed/hover (the native dynamic island). On fill it fades black → #e9e9e7
// (= sandwich UI_BG / tokens --canvas) as it grows, so the morph color-matches the real canvas, then drops to
// TRANSPARENT (body.spilled) ON the synced reveal so the live BlitzOS desktop behind it shows through (an opaque
// plate would just paint a flat screen). The live-tuning arrow keys are DEV-ONLY (gated on a ?tune=1 hash so
// they never hijack the textarea cursor in the shipped island).
function islandHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<style>
  :root { color-scheme: light dark;
          --accent:#e31c30; --canvas:#e9e9e7;
          --font-ui:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter',system-ui,sans-serif; }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; width:100%; background:transparent; overflow:hidden;
              font-family:var(--font-ui); -webkit-user-select:none; user-select:none; cursor:default; }
  /* THE ONE BLACK SHAPE. #home is full-window but CLIPPED (clip-path = NotchShape) to the current stop: notch
     (closed) → panel (hover) → fullscreen (fill). It is BLACK closed/hover; on fill the bg tweens to the canvas
     color, then drops to transparent on the synced reveal (body.spilled). Content STATIC inside (nothing scales). */
  #home { position:fixed; inset:0; background:#000;
          transition:clip-path .5s cubic-bezier(0.22,1,0.36,1), background-color .42s ease; will-change:clip-path; }
  body.open #home { background:var(--canvas); }          /* fill grow → canvas color (seamless with BlitzOS) */
  body.spilled #home { background:transparent; transition:clip-path .5s cubic-bezier(0.22,1,0.36,1); } /* revealed → live canvas shows through (no bg fade: crisp reveal) */
  /* The notch handle: the small black pill ALWAYS on top (z above #home). Closed/hover it blends into the black
     shape; spilled it is the lone visible piece = the click-to-suck-back handle over the live canvas. */
  #notch { position:fixed; top:0; left:50%; transform:translateX(-50%); width:200px; height:38px;
           background:#000; z-index:10; cursor:pointer; display:grid; place-items:center; }
  .peek { display:flex; gap:5px; transition:opacity .2s; }
  .peek i { width:7px; height:7px; border-radius:2px; background:var(--c,#cfd0d2); }
  body.panel .peek, body.open .peek { opacity:0; }
  /* The Blitz entry — INSIDE the black panel (white-on-black), revealed on hover (body.panel). z above #home so
     it paints on the black shape. Hidden closed + while spilled (spilled is passthrough to the live canvas). */
  #entry { position:fixed; top:50px; left:50%; width:536px; max-width:84vw; z-index:11;
           opacity:0; pointer-events:none; transform:translateX(-50%) translateY(-6px);
           transition:opacity .16s .03s, transform .2s cubic-bezier(0.22,1,0.36,1); }
  body.panel #entry { opacity:1; pointer-events:auto; transform:translateX(-50%) translateY(0); }
  #pq { width:100%; background:transparent; border:0; outline:0; resize:none; overflow:hidden;
        font-size:16px; line-height:1.4; max-height:120px; color:#f4f4f5; caret-color:var(--accent);
        -webkit-user-select:text; user-select:text; }
  #pq::placeholder { color:#86888b; }
  .ctl { display:flex; align-items:center; gap:10px; margin-top:12px; }
  .deep { display:flex; align-items:center; gap:7px; font-size:13px; color:#b7b9bc; cursor:pointer; }
  .sw { width:34px; height:20px; border-radius:10px; background:#3a3a3d; position:relative; transition:background .15s; }
  .sw::after { content:''; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%;
               background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.4); transition:left .15s; }
  .deep.on .sw { background:var(--accent); } .deep.on .sw::after { left:16px; }
  .sp { flex:1 1 auto; }
  .send { height:30px; border:0; border-radius:15px; background:var(--accent); color:#fff; cursor:pointer;
          padding:0 16px; font-size:14px; font-weight:600; box-shadow:0 1px 5px rgba(227,28,48,.45); }
  .send:disabled { opacity:.35; cursor:default; box-shadow:none; }
  /* live-tuning readout (arrow keys) — DEV ONLY (?tune=1); hidden in the shipped island. */
  #hud { position:fixed; left:12px; bottom:12px; z-index:20; font:11px var(--font-ui); color:#fff;
         background:rgba(0,0,0,.55); padding:5px 9px; border-radius:7px; pointer-events:none; opacity:.85; display:none; }
  body.tune #hud { display:block; }
</style></head><body>
  <div id="home"></div>
  <div id="notch"><div class="peek"><i style="--c:#e31c30"></i><i></i><i></i><i style="--c:#2e9e6b"></i></div></div>
  <div id="entry">
    <textarea id="pq" rows="1" placeholder="Ask Blitz, or describe a task"></textarea>
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
        entry=document.getElementById('entry'), pq=document.getElementById('pq'),
        deep=document.getElementById('deep'), send=document.getElementById('send'), hud=document.getElementById('hud');
    var SCREEN_W=window.innerWidth, SCREEN_H=window.innerHeight, NOTCH_W=200, NOTCH_H=38, NOTCH_X=0;
    var PANEL_W=580, PANEL_H=160;                 // the hover-expanded black panel (the native island stop)
    var state='closed';                           // 'closed' | 'panel' | 'open'
    var deepOn=false, sending=false, awaitingReveal=false, revealTimer=null;
    // DEV-ONLY live-tuning of the notch geometry (arrow keys). OFF unless the data: URL carries #tune=1.
    var TUNE = /(?:^|[#&?])tune=1(?:&|$)/.test(location.hash || '');
    if (TUNE) document.body.classList.add('tune');

    // One generator → identical command list for every stop so clip-path tweens cleanly (PoC notchPath).
    // Concave top fillets (tuck into the menu bar) + rounded bottom. y-DOWN, viewport px.
    function notchPath(left,top,w,h,t,b){ t=Math.max(0.5,Math.min(t,w/2)); b=Math.max(0.5,Math.min(b,h-t,(w-2*t)/2));
      var L=left,T=top,R=left+w,B=top+h;
      return "path('M "+L+" "+T+" Q "+(L+t)+" "+T+" "+(L+t)+" "+(T+t)+" L "+(L+t)+" "+(B-b)+" "+
             "Q "+(L+t)+" "+B+" "+(L+t+b)+" "+B+" L "+(R-t-b)+" "+B+" Q "+(R-t)+" "+B+" "+(R-t)+" "+(B-b)+" "+
             "L "+(R-t)+" "+(T+t)+" Q "+(R-t)+" "+T+" "+R+" "+T+" Z')"; }
    function cx(){ return SCREEN_W/2 + NOTCH_X; }
    function closedClip(){ return notchPath(cx()-NOTCH_W/2,0,NOTCH_W,NOTCH_H,7,16); }
    function panelClip(){ return notchPath(cx()-PANEL_W/2,0,PANEL_W,PANEL_H,16,28); }
    function fillClip(){ return notchPath(0,0,SCREEN_W,SCREEN_H,1,1); }
    function homeClip(){ return state==='open'?fillClip(): state==='panel'?panelClip(): closedClip(); }
    function applyGeom(){
      notch.style.width=NOTCH_W+'px'; notch.style.height=NOTCH_H+'px'; notch.style.left=cx()+'px';
      notch.style.transform='translateX(-50%)'; notch.style.clipPath=notchPath(0,0,NOTCH_W,NOTCH_H,7,16);
      entry.style.left=cx()+'px';
      home.style.clipPath=homeClip();
      hud.textContent='notch  W '+NOTCH_W+'  H '+NOTCH_H+'  x'+(NOTCH_X>=0?'+':'')+NOTCH_X+'   screen '+SCREEN_W+'x'+SCREEN_H+'   (← → ↑ ↓, ⇧← ⇧→, ⌥=1px)'; }

    // Click-through region. closed → only NEAR the notch captures (hover-expands); panel → the whole panel rect
    // captures (so moving within it / typing keeps it open); spilled → ONLY the notch pill (the body is
    // passthrough so clicks reach the REAL canvas behind the now-transparent plate).
    var lastI=null;
    function setI(on){ if(on!==lastI){ lastI=on; try{ window.agentOS.island.setInteractive(on); }catch(_){} } }
    function ptIn(left,top,w,h,x,y){ return x>=left&&x<=left+w&&y>=top&&y<=top+h; }
    // The CLOSED-hover trigger measures the REAL #notch element (notch.getBoundingClientRect), EXACTLY like the
    // validated PoC's overNotch — not a computed cx() rect (that deviation could miss if the viewport coordinate
    // space and the geometry disagree). The PANEL-stay region is computed (the panel is #home's clip, no element).
    function overEl(el,x,y){ var r=el.getBoundingClientRect(); return x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom; }
    document.addEventListener('mousemove',function(e){
      var x=e.clientX,y=e.clientY;
      if(state==='open'){ setI(overEl(notch,x,y)); return; }              // spilled: pill-only handle (EXACT PoC)
      var onNotch = overEl(notch,x,y);                                    // REAL element (validated PoC hit-test)
      var inPanel = ptIn(cx()-PANEL_W/2, 0, PANEL_W, PANEL_H, x, y);
      var want = onNotch || (state==='panel' && (inPanel || document.activeElement===pq));
      if(onNotch && state==='closed'){ state='panel'; document.body.classList.add('panel'); home.style.clipPath=homeClip(); }
      else if(state==='panel' && !want){ state='closed'; document.body.classList.remove('panel'); home.style.clipPath=homeClip(); }
      setI(want);
    });

    function clearReveal(){ if(revealTimer){ clearTimeout(revealTimer); revealTimer=null; } awaitingReveal=false; }
    // Reveal = drop the plate to transparent so the LIVE canvas shows through. Driven by the clip-path grow
    // FINISHING (transitionend) — now safe + perfectly synced, EXACTLY like the PoC: main covers the real window
    // via setSpillCover (PoC-style fake fullscreen = setSimpleFullScreen, NO native-fullscreen Space transition),
    // so the real canvas is already behind us the instant we ask. There is no Space animation to race (the bug
    // the old native-fullscreen path had, which flashed the desktop). A short safety timeout backs up a missed event.
    function reveal(){ if(state==='open'&&awaitingReveal){ document.body.classList.add('spilled'); clearReveal(); } }
    // GROW the clip-path to fullscreen + ask main to fake-fullscreen the real canvas behind us. The plate stays
    // OPAQUE (canvas-colored) through the grow; reveal() (on transitionend) then drops it to transparent.
    function grow(){ if(state==='open') return; state='open';
      document.body.classList.remove('panel'); document.body.classList.add('open');
      home.style.clipPath=homeClip(); lastI=null; setI(true);
      clearReveal(); awaitingReveal=true;
      try{ window.agentOS.island.fill(true); }catch(_){}                 // → sandwich.setSpillCover(true) (fake fullscreen) + raise mainWindow
      revealTimer=setTimeout(reveal,900);                               // safety: if transitionend is missed
    }
    // The clip-path grow finished → the plate covers the screen (canvas-colored) and the real window is already
    // covering behind it → drop to transparent (the seamless handoff). Guarded so it only fires for a GROW
    // (awaitingReveal), not the panel hover / the suck-back, and only for the clip-path (not background-color).
    home.addEventListener('transitionend',function(e){ if(e.propertyName==='clip-path') reveal(); });
    // SHRINK + tell main to suck back. Drop .spilled FIRST so the plate is opaque again and the suck-back tweens
    // over the canvas color, covering the fullscreen-exit (never a blank/old-space flash).
    function shrink(){ if(state!=='open') return; state='closed'; clearReveal();
      document.body.classList.remove('open'); document.body.classList.remove('spilled'); document.body.classList.remove('panel');
      home.style.clipPath=homeClip(); lastI=null; setI(false);
      try{ window.agentOS.island.fill(false); }catch(_){}                // → restore the pre-spill sandwich fullscreen
    }
    notch.addEventListener('click',function(e){ e.stopPropagation(); if(state==='open') shrink(); else grow(); });

    // Blitz entry.
    function syncSend(){ send.disabled = !(pq.value.trim() && !sending); }
    function autoGrowQ(){ pq.style.height='auto'; pq.style.height=Math.min(120,pq.scrollHeight)+'px'; }
    pq.addEventListener('input',function(){ autoGrowQ(); syncSend(); });
    pq.addEventListener('focus',function(){ if(state!=='open'){ state='panel'; document.body.classList.add('panel'); home.style.clipPath=homeClip(); } setI(true); });
    deep.addEventListener('click',function(){ deepOn=!deepOn; deep.classList.toggle('on',deepOn); });
    function submit(){ var prompt=pq.value.trim(); if(!prompt||sending) return; sending=true; syncSend();
      try{ window.agentOS.island.send(prompt, deepOn).then(function(r){
        sending=false; if(r&&r.ok){ pq.value=''; autoGrowQ(); grow(); } syncSend();
      }).catch(function(){ sending=false; syncSend(); }); }catch(_){ sending=false; syncSend(); } }
    send.addEventListener('click',submit);
    pq.addEventListener('keydown',function(e){
      if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); submit(); }   // Shift+Enter = newline
      else if(e.key==='Escape'){ e.preventDefault(); if(state==='open') shrink(); else { pq.blur(); state='closed'; document.body.classList.remove('panel'); home.style.clipPath=homeClip(); } } });

    // Geometry from main (real screen size + menu-bar height → notch height) + DEV-ONLY live tuning (?tune=1).
    try{ window.agentOS.island.onGeometry(function(g){
      SCREEN_W=(g&&g.width)||window.innerWidth; SCREEN_H=(g&&g.height)||window.innerHeight;
      if(g&&g.menuBarH&&g.menuBarH>0) NOTCH_H=Math.round(g.menuBarH); applyGeom(); }); }catch(_){}
    // FOLLOWER (native-fullscreen reconciliation only): the spill uses fake fullscreen (setSpillCover), which
    // fires NO enter/leave-full-screen, so this is dormant for spills — it only reacts to the user's REAL native
    // fullscreen (green light / Ctrl+Cmd+F). on=true → reveal() as a harmless backup; on=false while open → an
    // external leave, so collapse (don't re-issue fill(false): main already knows it left).
    try{ window.agentOS.island.onFullscreen(function(on){
      if(on){ reveal(); return; }
      if(state==='open'){ state='closed'; clearReveal();
        document.body.classList.remove('open'); document.body.classList.remove('spilled'); document.body.classList.remove('panel');
        home.style.clipPath=homeClip(); lastI=null; setI(false); }
    }); }catch(_){}
    // SUCK-BACK ON HIDE: ⌥Space-off / any hide while spilled must restore the sandwich first (else it strands in
    // fullscreen with the collapse pill gone). Main fires this just before islandWin.hide().
    try{ window.agentOS.island.onHide(function(){ if(state==='open') shrink(); }); }catch(_){}

    window.addEventListener('keydown',function(e){
      // DEV-ONLY notch tuning. Hard-gated: never run unless ?tune=1, and never while typing in the prompt.
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
  if (ISLAND_DEBUG) {
    const wb = win.getBounds()
    islandLog(`showIsland bounds=${JSON.stringify(wb)} display=${JSON.stringify(b)} coversMenuBar=${wb.y <= b.y && wb.height >= b.height}`)
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) sendGeometry(win) })
  } else {
    sendGeometry(win)
  }
  setTimeout(() => {
    if (win.isDestroyed()) return
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
    if (ISLAND_DEBUG) { const wb = win.getBounds(); islandLog(`t+700 bounds=${JSON.stringify(wb)} coversMenuBar=${wb.y <= b.y && wb.height >= b.height}`) }
  }, 700)
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

// Push the sandwich's REAL fullscreen state to the island so it can follow: on=true REVEALS (our fill landed, or
// main's already-fullscreen cue); on=false collapses on an external exit. Called from index.ts on the sandwich's
// pages enter/leave-full-screen (and the already-fullscreen cue). No-op if the island isn't up.
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
    islandLog(`interactive=${on}`)
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
  // fullscreen + raise + cue the reveal; suck → restore the pre-spill state). The seam owns the "only exit the
  // fullscreen we entered" logic (index.ts), so the island never yanks the user out of a fullscreen it didn't start.
  ipcMain.on('os:island-fill', (_e, on: boolean) => {
    islandLog(`fill=${on}`)
    try { fillFn?.(!!on) } catch { /* sandwich / mainWindow gone */ }
  })
}
