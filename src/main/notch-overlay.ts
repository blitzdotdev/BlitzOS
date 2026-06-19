import { BrowserWindow, screen } from 'electron'

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
    backgroundColor: '#00000000',
    // Native fullscreen/resize would fight an all-Spaces overlay; the only "fullscreen" is the renderer clip-grow.
    fullscreenable: false,
    resizable: false,
    // A click on the overlay must ACT, not be swallowed just to re-key the window (AppKit first-mouse opt-in).
    acceptFirstMouse: true
  }
}

/** Post-show overlay setup (call on ready-to-show): hide the native traffic lights (the renderer draws its own),
 *  cover the full display incl. the menu bar, float over everything on ALL Spaces, and start CLICK-THROUGH so only
 *  the notch captures the mouse until the renderer flips it via setNotchInteractive. showInactive so the notch never
 *  steals focus from whatever app the user is over. Bounds are re-asserted post-show because Electron clamps y into
 *  the workArea (below the menu bar) before the window is shown, and again after 700ms (post-show clamping settles). */
export function applyNotchOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = screen.getPrimaryDisplay().bounds
  win.setWindowButtonVisibility?.(false)
  win.setBounds(b)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.showInactive() // the notch must NOT steal focus from whatever app the user is over (all-Spaces overlay)
  win.setBounds(b) // re-assert post-show (pre-show Electron clamps y into the workArea, below the menu bar)
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
