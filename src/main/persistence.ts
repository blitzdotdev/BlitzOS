import { app, session, webContents, type Session, type WebContents } from 'electron'

// Why this exists: keeping web surfaces (`WebContentsView` guests in `persist:agentos`) logged in
// across a quit + relaunch turned out to need two distinct guarantees, because there are two
// different ways a site persists its session:
//
//  1. Cookies / plain localStorage. Chromium commits these to disk lazily (a multi-second
//     idle timer); the partition is persistent, but an abrupt quit can drop the tail of that
//     buffer. Guard: flush the stores to disk on a short cadence + once on quit.
//
//  2. Auth held in memory, written only on page unload. Some sites (Discord, etc.) deliberately
//     keep their token OUT of storage while running (so an XSS can't read it at rest) and write
//     it to localStorage only from a real `pagehide`/`unload` handler, reading + re-clearing it
//     on the next boot. If Electron tears the guest down abruptly on quit, that unload write
//     never runs and the token is lost -> logged out next launch. Guard: before we flush + exit,
//     navigate each guest to about:blank so a REAL unload fires (the site persists its session)
//     WITHOUT rebooting the site (which would just re-read and re-clear the token). Verified
//     against Discord: the `token` key is absent from localStorage mid-session and present in
//     the backing store immediately after this navigation.

const PARTITION = 'persist:agentos'
const FLUSH_INTERVAL_MS = 20_000
// flushStorageData() returns void with no completion signal, so on quit we give the storage
// thread a brief moment to land the write before letting the process exit.
const QUIT_FLUSH_GRACE_MS = 200
// Cap how long we wait for guests to unload so quit can never hang on a stuck page.
const GUEST_UNLOAD_TIMEOUT_MS = 1500

function targetSessions(): Session[] {
  // persist:agentos = every `web` surface guest; defaultSession = the desktop renderer.
  return [session.fromPartition(PARTITION), session.defaultSession]
}

function flushAll(): Promise<unknown> {
  return Promise.allSettled(
    targetSessions().map((s) => {
      s.flushStorageData() // localStorage/sessionStorage -> disk (fire-and-forget)
      return s.cookies.flushStore() // cookies -> disk (awaitable)
    })
  )
}

function webGuests(): WebContents[] {
  // Every web surface is an in-DOM <webview> guest now (getType() === 'webview').
  return webContents.getAllWebContents().filter((wc) => {
    try {
      return !wc.isDestroyed() && wc.getType() === 'webview'
    } catch {
      return false
    }
  })
}

// Fire a real unload on every web guest (see guarantee #2 above), bounded so quit never hangs.
function unloadGuestsForPersist(): Promise<void> {
  const guests = webGuests()
  if (guests.length === 0) return Promise.resolve()
  const perGuest = guests.map(
    (wc) =>
      new Promise<void>((resolve) => {
        wc.on('will-prevent-unload', (e) => e.preventDefault()) // never let a beforeunload prompt block exit
        wc.once('did-stop-loading', () => resolve()) // about:blank settled => the old document unloaded
        wc.once('destroyed', () => resolve())
        Promise.resolve(wc.loadURL('about:blank')).catch(() => resolve())
      })
  )
  return Promise.race([
    Promise.allSettled(perGuest).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, GUEST_UNLOAD_TIMEOUT_MS))
  ])
}

export function startSessionPersistence(): void {
  // Cadence guard for #1: bounds how much recent cookie/localStorage state an abrupt kill can
  // drop to a few seconds. unref so we never hold the app open just to flush.
  const timer = setInterval(() => void flushAll(), FLUSH_INTERVAL_MS)
  timer.unref?.()

  // Clean-quit guard for #1 + #2. Note: a dev-server Ctrl+C sends a signal that bypasses
  // before-quit, so this protects a real quit (Cmd+Q / a packaged app), which is the case the
  // logged-out-on-reopen report is about.
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    void (async () => {
      try {
        await unloadGuestsForPersist() // let sites persist their session on a real unload
        await flushAll() // cookies + DOM storage -> disk
      } finally {
        setTimeout(() => app.quit(), QUIT_FLUSH_GRACE_MS)
      }
    })()
  })
}
