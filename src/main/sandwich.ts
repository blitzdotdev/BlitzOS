import { BrowserWindow, screen, type Rectangle } from 'electron'

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
  /** PoC-style "fake fullscreen": cover the WHOLE display on the CURRENT Space via setSimpleFullScreen — NO
   *  native-fullscreen Space transition, so NO jarring macOS animation. Used by the notch-island spill so the
   *  real canvas fills edge-to-edge as smoothly as the PoC. Reversible; never fights a real user fullscreen. */
  setSpillCover(on: boolean): void
  /** OVERLAY (notch-merge) mode: toggle the UI window click-through. on=false → click-through except where the
   *  renderer re-enables it (the notch); on=true → fully interactive (expanded canvas). Forward keeps mousemove
   *  flowing so the renderer can detect the notch-hover and flip it. The real "fill" is the renderer clip-grow. */
  setInteractive(on: boolean): void
  /** Minimize the pair to the Dock (the parent miniaturizes; the attached child follows via AppKit). */
  minimize(): void
  /** Native-input passthrough (plans/blitzos-native-input.md, SPIKE): make the UI window
   *  click-through so the human's mouse falls to the page below as a REAL, trusted OS event;
   *  `forward` keeps move events flowing so the renderer can flip it back off over chrome. Idempotent. */
  setPassthrough(on: boolean): void
}

const UI_BG = '#e9e9e7' // what a hole shows before its page paints (and the desktop's canvas color)

export function createSandwich(opts: { width: number; height: number; fullscreen: boolean; preload: string; startHidden?: boolean; overlay?: boolean }): Sandwich {
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
    // Transparent window, opaque DOM everywhere except browser holes.
    transparent: true,
    // Native fullscreen/resize on the CHILD would detach it from the parent; both are handled at
    // the pair level (setFullScreen below; resize is a follow-up).
    fullscreenable: false,
    resizable: false,
    // A click on the UI while a page (L0) holds macOS key must ACT, not be swallowed just to re-key
    // L1 (the other half of the "click twice" bug — e.g. after typing in a page, the first click on
    // the tab strip / chrome would otherwise be eaten). Standard AppKit first-mouse opt-in.
    acceptFirstMouse: true,
    // OVERLAY (notch-merge): ONE frameless transparent window covering the FULL display incl. the menu-bar/notch
    // band (enableLargerThanScreen), the real canvas clipping itself to the notch + growing — so the live canvas
    // IS what expands, no separate window/plate. Else the normal sandwich child uses the hiddenInset title bar.
    // backgroundColor fully TRANSPARENT in overlay mode: the GPU texture (translateZ(0) in the renderer, the lag
    // fix) gives the window an opaque backing whose default is WHITE — it showed as square white corners poking out
    // behind the notch's rounded clip. '#00000000' makes the backing transparent so only the rounded island paints.
    ...(opts.overlay
      ? { frame: false, hasShadow: false, enableLargerThanScreen: true, skipTaskbar: true, backgroundColor: '#00000000' }
      : { titleBarStyle: 'hiddenInset' as const }),
    webPreferences: {
      preload: opts.preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  // The load-bearing attachment (see header). Set before show so the group exists from first paint.
  // OVERLAY (notch-merge): NOT parented — the UI window is a standalone full-display transparent overlay
  // (screen-saver, all-Spaces; set on ready-to-show), and pages stays hidden (the renderer's opaque .bg paints
  // the canvas color). Parenting would hide the UI when pages is hidden + cap its window level. (L0/browser is
  // being retired, so its occlusion-culling reason no longer applies.)
  if (!opts.overlay) ui.setParentWindow(pages)

  // The native traffic lights are REPLACED by custom DOM ones in the renderer titlebar (App.tsx). The
  // green/fullscreen light cannot be native: a macOS child window can't enter native fullscreen without
  // detaching from its parent (which blanks L0), so we own all three and wire green → setFullScreen (the
  // parent rides into fullscreen, the child follows), yellow → minimize, red → close. Hide the native
  // buttons so only the custom set shows (re-asserted on did-finish-load for dev reloads).
  ui.setWindowButtonVisibility(false)

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
  // The child never enters NATIVE fullscreen (it can't — attached), so its chrome won't auto-hide like
  // a normal fullscreen window's: tell the renderer to drop its titlebar strip (which carries the custom
  // traffic lights) while the pair is fullscreen. The native lights are already hidden — custom ones
  // replace them — so there's nothing to toggle here. Resent on every renderer load (boot fullscreen via
  // BLITZ_FULLSCREEN, dev reloads) so the state never goes stale.
  const setChromeFs = (on: boolean): void => {
    if (ui.isDestroyed()) return
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
    ui.setWindowButtonVisibility(false) // re-assert across dev reloads — custom DOM lights replace native
    if (!pages.isDestroyed() && pages.isFullScreen()) setChromeFs(true)
  })
  const setFullScreen = (on: boolean): void => {
    // OVERLAY (notch-merge): the UI window is ALREADY a full-display, all-Spaces overlay and `pages` is a hidden
    // backdrop, so native-fullscreening it is incoherent and TRAPS the user — it covers every desktop with no
    // native fullscreen-exit chrome (the top-left traffic lights never reveal), and key/Cmd+Q misroute. The
    // overlay's only "fullscreen" is the renderer's notch clip-grow; native fullscreen is disabled here. (The
    // green light / Ctrl+Cmd+F still drive real native fullscreen in the non-overlay sandwich + BLITZ_FULLSCREEN.)
    if (opts.overlay) return
    if (!pages.isDestroyed()) pages.setFullScreen(on)
  }
  // PoC-style "fake fullscreen" (plans/blitzos-dynamic-island.md): cover the display on the CURRENT Space with
  // NO native-fullscreen Space transition (so no macOS fullscreen animation — the notch island's clip-path
  // spill is the only motion the user sees). setSimpleFullScreen resizes the PARENT to the whole screen incl.
  // the menu-bar band; the attached child keeps stale bounds (same as native fullscreen) so we syncFs it.
  // Reversible (setSimpleFullScreen(false) restores the prior bounds). We never fight a REAL native fullscreen
  // the user started (green light / Ctrl+Cmd+F) — guarded by isFullScreen() / the spillCovering flag.
  let spillCovering = false
  const setSpillCover = (on: boolean): void => {
    if (pages.isDestroyed() || ui.isDestroyed()) return
    if (on) {
      if (spillCovering || pages.isFullScreen()) return
      spillCovering = true
      // Show the pair (notch-gated → it was hidden on launch / sucked away). A freshly-shown hidden window
      // appears on the user's CURRENT Space, so the island reveal shows the REAL canvas THERE — not on another
      // Space, the bug behind "the fill is just a flat plate". Parent first, then the attached child above it;
      // focus the child for keyboard.
      pages.show()
      ui.show()
      ui.focus()
      pages.setSimpleFullScreen(true)  // cover the CURRENT Space — no native-fullscreen Space transition
      syncFs(); setTimeout(syncFs, 30) // child matches the now-full parent (immediately + after the resize settles)
      setChromeFs(true)                // edge-to-edge: drop the titlebar strip like real fullscreen
    } else {
      if (!spillCovering) return
      spillCovering = false
      pages.setSimpleFullScreen(false) // restore the prior bounds
      setChromeFs(false)
      if (opts.startHidden) {
        ui.hide()
        pages.hide()                   // notch-gated: suck back to JUST the notch (the child hides with its parent)
      } else {
        syncFs(); setTimeout(syncFs, 30) // non-gated: stay shown; just re-sync the child to the restored bounds
      }
    }
  }
  // OVERLAY (notch-merge) click-through toggle: collapsed → click-through except where the renderer re-enables it
  // (the notch); expanded → fully interactive. forward keeps mousemove flowing so the renderer detects the hover.
  const setInteractive = (on: boolean): void => {
    if (!ui.isDestroyed()) ui.setIgnoreMouseEvents(!on, { forward: true })
  }

  // Minimize the pair: the parent miniaturizes to the Dock and its attached child follows (AppKit
  // removes ordered child windows from screen with their parent and restores them together).
  const minimize = (): void => {
    if (!pages.isDestroyed()) pages.minimize()
  }

  // Show order: the parent first, then the attached child above it.
  ui.once('ready-to-show', () => {
    if (opts.overlay) {
      // Notch-merge: the UI window IS the canvas AND the notch. Show ONLY the UI (pages stays hidden — the
      // renderer's opaque .bg paints the canvas color, and OUTSIDE the renderer's notch clip the transparent
      // window shows the desktop). Cover the full display incl. the menu-bar/notch band, float over everything +
      // all Spaces, and start click-through (collapsed = only the notch captures; the renderer flips it via
      // setInteractive). The renderer clips #root-canvas to the notch shape and grows it to fullscreen.
      const b = screen.getPrimaryDisplay().bounds
      ui.setBounds(b)
      ui.setAlwaysOnTop(true, 'screen-saver')
      ui.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      ui.setIgnoreMouseEvents(true, { forward: true })
      ui.showInactive() // the notch must NOT steal focus from whatever app the user is over (it's an all-Spaces overlay)
      ui.setBounds(b) // re-assert post-show (Electron clamps y into the workArea pre-show, below the menu bar)
      setTimeout(() => { if (!ui.isDestroyed()) { ui.setBounds(b); ui.setAlwaysOnTop(true, 'screen-saver') } }, 700)
      return
    }
    // Notch-gated (startHidden): stay HIDDEN on launch. Otherwise show normally.
    if (opts.startHidden) return
    pages.show()
    ui.show()
    if (opts.fullscreen) setFullScreen(true)
  })

  return { ui, pages, focusPages, focusUi, dragShell, setFullScreen, setSpillCover, setInteractive, minimize, setPassthrough }
}
