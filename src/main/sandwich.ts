import { BrowserWindow, type Rectangle } from 'electron'

// The sandwich compositor (plans/blitzos-sandwich-compositor.md): BlitzOS has exactly two visual
// layers, so it runs as two congruent windows. L0 "pages" (bottom) hosts every page
// WebContentsView and nothing else; L1 "UI" (top, transparent) hosts the entire renderer, with a
// transparent HOLE where each browser body is. DOM covers pages by being physically above them;
// pages cover DOM via clip-path holes on the lower DOM (renderer-side). Nothing ever freezes.
//
// The pair is PARENTED (ui = child of pages) — this is load-bearing, not cosmetic: macOS occlusion-
// culls a standalone window that another window fully covers (the views in L0 simply stop
// compositing — verified by bisect spike: unparented = blank hole, parented = live page), and an
// attached parent/child group is exempt AND cannot be interleaved by foreign apps' windows
// (observed pre-parenting: a messenger window slotted between the layers and composited through
// the transparency). The cost: the child must never be moved/resized DIRECTLY (macOS child-window
// glue is one-way, parent→child, and feedback-loops if you mirror a child drag back), so:
//   - window DRAG is manual — the renderer titlebar streams drag deltas (os:shell-drag) and main
//     moves the PARENT; the child follows natively. No CSS app-region anywhere.
//   - the UI window is non-resizable for now (manual edge-resize is a noted follow-up); fullscreen
//     still works via the parent (children join the parent's fullscreen Space, bounds-synced).

export interface Sandwich {
  /** L1 — the transparent UI window: the renderer, all input, the app's face. */
  ui: BrowserWindow
  /** L0 — the pages window: hosts page WebContentsViews, nothing else. */
  pages: BrowserWindow
  /** Keyboard to a page: L0 becomes key (native typing/IME into the focused view); the attached
   *  child stays above it regardless of key status. */
  focusPages(): void
  /** Keyboard back to the UI (any pointerdown on UI chrome). */
  focusUi(): void
  /** Titlebar drag protocol: 'start' latches the current origin, 'move' applies screen deltas to
   *  the PARENT (the child follows natively — moving the child directly would detach it). */
  dragShell(op: 'start' | 'move', dx: number, dy: number): void
  /** Fullscreen rides the parent; the attached child joins its Space (bounds-synced on arrival). */
  setFullScreen(on: boolean): void
  /** Native-input passthrough (plans/blitzos-native-input.md, SPIKE): make the UI window
   *  click-through so the human's mouse falls to the page below as a REAL, trusted OS event;
   *  `forward` keeps move events flowing so the renderer can flip it back off over chrome. Idempotent. */
  setPassthrough(on: boolean): void
}

const UI_BG = '#e9e9e7' // what a hole shows before its page paints (and the desktop's canvas color)

export function createSandwich(opts: { width: number; height: number; fullscreen: boolean; preload: string }): Sandwich {
  const pages = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    show: false,
    frame: false,
    backgroundColor: UI_BG,
    // Never the app's face: one window in Mission Control / the Window menu / the dock.
    skipTaskbar: true,
    webPreferences: { sandbox: true } // its own webContents is just the backdrop; never loads content
  })
  pages.setHiddenInMissionControl?.(true)
  pages.excludedFromShownWindowsMenu = true

  const ui = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    show: false,
    // The UI layer composites over the live pages below it: transparent window, opaque DOM
    // everywhere except browser holes. Native traffic lights render fine with titleBarStyle on a
    // transparent window (verified live).
    transparent: true,
    titleBarStyle: 'hiddenInset',
    // Native fullscreen/resize on the CHILD would detach it from the parent; both are handled at
    // the pair level (setFullScreen below; resize is a follow-up).
    fullscreenable: false,
    resizable: false,
    // A click on the UI while a page (L0) holds macOS key must ACT, not be swallowed just to re-key
    // L1 (the other half of the "click twice" bug — e.g. after typing in a page, the first click on
    // the tab strip / chrome would otherwise be eaten). Standard AppKit first-mouse opt-in.
    acceptFirstMouse: true,
    webPreferences: {
      preload: opts.preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  // The load-bearing attachment (see header). Set before show so the group exists from first paint.
  ui.setParentWindow(pages)

  // Closing the UI closes the pair (pages alone is meaningless).
  ui.on('closed', () => {
    if (!pages.isDestroyed()) pages.destroy()
  })

  const focusPages = (): void => {
    if (!pages.isDestroyed()) pages.focus() // attached child stays above its parent regardless of key
  }
  const focusUi = (): void => {
    if (!ui.isDestroyed() && !ui.isFocused()) ui.focus()
  }

  // Native-input passthrough (SPIKE, default OFF): the renderer flips this as the cursor crosses a
  // page hole. ignore=true → L1 is click-through and the event falls to L0's page (trusted); forward
  // keeps L1 receiving mousemove so it can detect leaving the hole and flip back to opaque.
  let passthrough = false
  const setPassthrough = (on: boolean): void => {
    if (ui.isDestroyed() || on === passthrough) return
    passthrough = on
    ui.setIgnoreMouseEvents(on, { forward: true })
  }

  // Manual titlebar drag: move the PARENT by screen deltas; the child follows natively.
  let dragOrigin: { x: number; y: number } | null = null
  const dragShell = (op: 'start' | 'move', dx: number, dy: number): void => {
    if (pages.isDestroyed()) return
    if (op === 'start') {
      const [x, y] = pages.getPosition()
      dragOrigin = { x, y }
      return
    }
    if (!dragOrigin) return
    pages.setPosition(Math.round(dragOrigin.x + dx), Math.round(dragOrigin.y + dy))
  }

  // Fullscreen rides the parent; the child joins the Space but keeps stale bounds — sync on arrival.
  const syncFs = (): void => {
    if (ui.isDestroyed() || pages.isDestroyed()) return
    const b: Rectangle = pages.getBounds()
    ui.setBounds(b)
  }
  // The child never enters NATIVE fullscreen (it can't — attached), so its chrome won't auto-hide
  // like a normal fullscreen window's: hide the traffic lights + tell the renderer to drop its
  // titlebar strip while the pair is fullscreen. Resent on every renderer load (boot fullscreen
  // via BLITZ_FULLSCREEN, dev reloads) so the state never goes stale.
  const setChromeFs = (on: boolean): void => {
    if (ui.isDestroyed()) return
    ui.setWindowButtonVisibility(!on)
    try {
      ui.webContents.send('os:fullscreen', { on })
    } catch {
      /* window mid-teardown */
    }
  }
  pages.on('enter-full-screen', () => {
    setTimeout(syncFs, 50)
    setChromeFs(true)
  })
  pages.on('leave-full-screen', () => {
    setTimeout(syncFs, 50)
    setChromeFs(false)
  })
  ui.webContents.on('did-finish-load', () => {
    if (!pages.isDestroyed() && pages.isFullScreen()) setChromeFs(true)
  })
  const setFullScreen = (on: boolean): void => {
    if (!pages.isDestroyed()) pages.setFullScreen(on)
  }

  // Show order: the parent first, then the attached child above it.
  ui.once('ready-to-show', () => {
    pages.show()
    ui.show()
    if (opts.fullscreen) setFullScreen(true)
  })

  return { ui, pages, focusPages, focusUi, dragShell, setFullScreen, setPassthrough }
}
