import { app, BrowserWindow, screen } from 'electron'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

// notch-overlay — the dynamic-island window mode, extracted from the retired sandwich compositor. Master nuked
// sandwich.ts + the per-tab WebContentsView host (web surfaces are now in-DOM <webview>), which removed the ONLY
// reason the notch needed two windows: with no native page-holes to composite under the DOM, the island is just
// ONE frameless, transparent, all-Spaces, full-display overlay window. The real canvas clips ITSELF to the notch
// shape (renderer) and grows the clip to reveal the live canvas — no pages window, no parenting, no focus handoff,
// no page-input forwarding, no manual drag (all of which only existed to glue the old two-window pair). This module
// owns ONLY that window's overlay configuration + the click-through toggle the renderer drives on notch hover.

/** BrowserWindow options that turn the single app window into the notch overlay. Spread over the base options in
 *  createWindow when notch mode is active (INSTEAD of the normal hiddenInset titlebar). The window must cover the
 *  FULL display incl. the menu-bar/notch band (enableLargerThanScreen) and be fully transparent: the renderer's
 *  GPU-promoted canvas backing (translateZ(0), the clip-grow lag fix) defaults to WHITE, which pokes square corners
 *  past the rounded notch clip — '#00000000' makes the backing transparent so only the rounded island paints. */
export function notchOverlayWindowOptions(): Electron.BrowserWindowConstructorOptions {
  return {
    frame: false,
    transparent: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    // Keep the island OUT of Mission Control / Exposé. It's system chrome (the dynamic island), not a real app
    // window, so it must not appear as a window tile when the user swipes up into Mission Control (the "Agent OS"
    // tile bug). Electron maps this to NSWindowCollectionBehaviorTransient ("floats in Spaces, hidden in Mission
    // Control"); the bit is OR'd in, so it preserves the all-Spaces (canJoinAllSpaces) behavior applyNotchOverlay
    // sets via setVisibleOnAllWorkspaces. The native island/computer-use helpers use .stationary (stays pinned and
    // visible like the menu bar); we want it GONE during Mission Control, which is .transient instead.
    hiddenInMissionControl: true,
    backgroundColor: '#00000000',
    // Native fullscreen/resize would fight an all-Spaces overlay; the only "fullscreen" is the renderer clip-grow.
    fullscreenable: false,
    resizable: false,
    // A click on the overlay must ACT, not be swallowed just to re-key the window (AppKit first-mouse opt-in).
    acceptFirstMouse: true
  }
}

/** Configure the notch overlay window (call on ready-to-show, BEFORE geometry is known). Sets the
 *  persistent overlay properties — bounds, z-order, click-through — but does NOT show the window.
 *  Call showNotchOverlay() after geometry has been pushed to the renderer so the window only appears
 *  once the island clip is ready (no flash of the un-clipped full-screen canvas). */
export function configureNotchOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = screen.getPrimaryDisplay().bounds
  win.setWindowButtonVisibility?.(false)
  win.setBounds(b)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
}

/** Show the notch overlay (call ONCE, after notch geometry has been pushed to the renderer). Separated
 *  from configureNotchOverlay so the window only appears when the island is ready — no flash of the
 *  un-clipped full-screen canvas or the windowed-mode titlebar. showInactive so the notch never steals
 *  focus. Bounds re-asserted post-show and after 700ms because Electron clamps y into the workArea. */
export function showNotchOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = screen.getPrimaryDisplay().bounds
  win.showInactive()
  win.setBounds(b) // re-assert post-show (pre-show Electron clamps y into the workArea)
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.setBounds(b)
      win.setAlwaysOnTop(true, 'screen-saver')
    }
  }, 700)
}

/** The click-through toggle the renderer drives (os:notch-interactive): on=false → click-through except where the
 *  renderer re-enables it (the notch handle); on=true → fully interactive (the expanded canvas). forward keeps
 *  mousemove flowing so the renderer can keep detecting the notch hover and flip this back. */
export function setNotchInteractive(win: BrowserWindow | null, on: boolean): void {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true })
}

// ── The notch HIT-WINDOW: a tiny, always-interactive, transparent window placed EXACTLY over the physical notch so
// the toggle is bulletproof (no click-through→arm race) and constant in every state. Its geometry comes from the
// native CLI (native/notch-geometry) which reads the real notch from NSScreen (the gap between the menu-bar ears +
// the safe-area top inset); on a display with no notch there is no window (⌥Space only). The overlay still paints
// the black pill + peek dots UNDER this transparent catcher; the catcher only owns the click + hover. ────────────

export interface NotchGeometry {
  hasNotch: boolean
  notchLeft: number // points from the display's left edge to the notch's left edge
  notchWidth: number // physical notch width (points)
  notchHeight: number // physical notch height = safe-area top inset (points)
}


/** Read the active display's physical notch via the bundled native CLI. hasNotch:false on non-notched displays.
 *  Best-effort: any failure → null and the caller skips the hit-window. No TCC/permission needed (NSScreen read). */
export function readNotchGeometry(): Promise<NotchGeometry | null> {
  // Dist: scripts/dist-mac.sh builds native/notch-geometry and electron-builder.yml extraResources copies the
  // binary into Contents/Resources; dev builds it via scripts/ensure-helper.sh (predev) and runs it from there.
  const bin = app.isPackaged
    ? join(process.resourcesPath, 'notch-geometry')
    : join(__dirname, '..', '..', 'native', 'notch-geometry', 'notch-geometry')
  return new Promise((resolve) => {
    execFile(bin, { timeout: 4000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      try {
        const g = JSON.parse(String(stdout).trim())
        resolve({
          hasNotch: !!g.hasNotch,
          notchLeft: Number(g.notchLeft) || 0,
          notchWidth: Number(g.notchWidth) || 0,
          notchHeight: Number(g.notchHeight) || 0
        })
      } catch {
        resolve(null)
      }
    })
  })
}

/** The on-screen rect (Electron top-left coords) of the physical notch on the primary display, or null if none.
 *  NSScreen.safeAreaInsets.top can be taller than the visible menu-bar band; the catcher must stay in that band
 *  or it steals hover/clicks from the island content rendered directly below the notch. */
export function notchHitRect(
  g: NotchGeometry | null,
  menuBarH = 0
): { x: number; y: number; width: number; height: number } | null {
  if (!g || !g.hasNotch || g.notchWidth <= 0) return null
  const b = screen.getPrimaryDisplay().bounds
  const safeTop = Math.max(1, Math.round(g.notchHeight))
  const visibleBand = Math.max(28, Math.round(menuBarH || 0))
  return {
    x: Math.round(b.x + g.notchLeft),
    y: Math.round(b.y),
    width: Math.round(g.notchWidth),
    height: Math.min(safeTop, visibleBand)
  }
}

/** Options for the notch hit-window: frameless, transparent, NOT click-through (it owns the click). The preload is
 *  the MAIN preload (it only exposes APIs at load, no side effects) so the inline page can use window.agentOS.notch. */
export function notchHitWindowOptions(
  rect: { x: number; y: number; width: number; height: number },
  preloadPath: string
): Electron.BrowserWindowConstructorOptions {
  return {
    ...rect,
    frame: false,
    transparent: true,
    // Place the catcher OVER the physical notch (y=0). Without this, macOS clamps a fresh window's y into the work
    // area (below the menu bar), dropping the catcher ~34px BELOW the notch onto the content — it stole clicks from
    // browser tabs. enableLargerThanScreen (like the main overlay) lets it sit in the menu-bar/notch band; index.ts
    // re-asserts setBounds after show to defeat the clamp.
    enableLargerThanScreen: true,
    // Show only on ready-to-show (see index.ts). A transparent macOS window shown before its first transparent frame
    // paints keeps its opaque WHITE backing; this catcher page is otherwise empty so nothing repaints over it — that
    // was the persistent "white pill" at the notch. Created hidden, shown after the first paint.
    show: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Same as the overlay: this transparent notch catcher is system chrome, so hide it from Mission Control / Exposé.
    hiddenInMissionControl: true,
    backgroundColor: '#00000000',
    acceptFirstMouse: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: false, backgroundThrottling: false }
  }
}

/** The fixed, trusted inline page the hit-window loads (no remote content, no navigation): a full-bleed transparent
 *  catcher that forwards click + hover to main through the existing notch preload bridge (window.agentOS.notch). */
export const NOTCH_HIT_HTML =
  '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100vw;height:100vh;background:transparent;cursor:pointer;-webkit-user-select:none;overflow:hidden}</style><body><script>' +
  'var n=window.agentOS&&window.agentOS.notch;' +
  'if(n){' +
  'document.body.addEventListener("click",function(){n.click()});' +
  'document.body.addEventListener("mouseenter",function(){n.hover(true)});' +
  'document.body.addEventListener("mouseleave",function(){n.hover(false)});' +
  '}</script></body>'
