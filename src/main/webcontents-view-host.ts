import { app, WebContentsView, webContents, type BrowserWindow, type Input, type Rectangle, type WebContents } from 'electron'
import { attachGuestWindowPolicy } from './guest-capabilities'

// App teardown destroys every webContents, which fires the same events as live tab death/navigation.
// Emitting those into the renderer during quit races the final workspace flush (a quit-time
// onTabGone closes store tabs; a teardown push then persists the mutilated state). Once quitting,
// the host goes silent — the on-disk truth is whatever the last LIVE state was.
let quitting = false
app.once('before-quit', () => {
  quitting = true
})

const PARTITION = 'persist:agentos'

// A browser surface is ONE window frame holding N page tabs — one WebContentsView per tab (the
// min-browser/wexond architecture; see .repos/min/main/viewManager.js). The renderer owns the tab
// LIST (surface.tabs, persisted in the .weblink node); this host owns the live views and mirrors
// that list declaratively via syncWebContentsViewTabs. Per-tab page state (url/title/favicon/
// loading/canGoBack/canGoForward) is PUSHED back per event (wexond's updateNavigationState model),
// so the chrome never polls.

/** What the renderer declares per tab. url is the INITIAL url (later navs flow via navigate). */
export interface TabDecl {
  id: string
  url?: string
}

/** Per-tab page state pushed to the renderer chrome. */
export interface TabStatePatch {
  url?: string
  title?: string
  favicon?: string
  loading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
}

interface HostCallbacks {
  getWindow: () => BrowserWindow | null
  /** A tab's page state changed. isActive = it is the surface's active tab right now. */
  onTabState: (surfaceId: string, tabId: string, patch: TabStatePatch, isActive: boolean) => void
  /** A tab's webContents died underneath us (crash/kill) — the renderer should drop the tab. */
  onTabGone: (surfaceId: string, tabId: string) => void
  /** The surface's ACTIVE webContents changed (tab created/switched/closed). wcId null = none left.
   *  This is the CDP + perception target — exactly one per surface. */
  onActiveContent: (surfaceId: string, wcId: number | null) => void
  /** A page popup classified `surface` (link disposition) — browser semantics: open it as a NEW TAB
   *  of the surface that spawned it. The renderer owns tabs, so it materializes the tab and syncs. */
  onOpenTab: (surfaceId: string, url: string) => void
  /** The page's cursor changed — the UI window owns the OS cursor, so it mirrors this onto the hole. */
  onCursor: (surfaceId: string, cursor: string) => void
  onFocus: (surfaceId: string) => void
  onContextMenu: (surfaceId: string, x: number, y: number) => void
  onShiftTap: () => void
  /** Bare-Option hold state from a focused guest (radial create menu); 'cancel' = another key
   *  joined the hold (the user is typing an Option-modified shortcut, not asking for the menu). */
  onAltHold: (phase: 'down' | 'up' | 'cancel') => void
}

interface TabEntry {
  tabId: string
  view: WebContentsView
  wcId: number
}

interface Entry {
  id: string
  tabs: TabEntry[]
  activeTab: string | null
  rect: Rectangle | null
  visible: boolean
  z: number
  zoom: number
}

const entries = new Map<string, Entry>()
// React StrictMode (dev) mounts → cleans up → remounts every effect, so a close for a surface can be
// IMMEDIATELY followed by a re-sync of the same id. Defer the actual teardown one beat; a sync within
// the window cancels it and the views (and their loaded pages) survive the remount untouched.
const pendingCloses = new Map<string, ReturnType<typeof setTimeout>>()
let callbacks: HostCallbacks | null = null
let inputForwarder: ((input: Input) => boolean) | null = null

// Console-safe url: origin + a short path slice, NO query or fragment. Auth tokens ride in the query
// (e.g. a Cloudflare ?token=<JWT>, a session redirect) — never log them. Used only for dev logs; the
// real url still flows to the chrome via pushNavState for the address bar.
const redactUrl = (u: string | undefined): string => {
  try { const x = new URL(String(u)); return x.origin + (x.pathname.length > 1 ? x.pathname.slice(0, 32) : '') } catch { return String(u ?? '').split('?')[0].slice(0, 48) }
}

export function setWebContentsViewInputForwarder(fn: ((input: Input) => boolean) | null): void {
  inputForwarder = fn
}

/** Every live hosted page webContents (all tabs of all surfaces). */
export function hostedWebContents(): WebContents[] {
  const out: WebContents[] = []
  for (const e of entries.values()) {
    for (const t of e.tabs) {
      const wc = t.view.webContents
      if (!wc.isDestroyed()) out.push(wc)
    }
  }
  return out
}

/** The surface's ACTIVE tab webContents id (the CDP/read/screenshot target), or null. */
export function webContentsViewIdForSurface(surfaceId: string): number | null {
  const e = entries.get(surfaceId)
  const t = e && activeEntry(e)
  return t && !t.view.webContents.isDestroyed() ? t.wcId : null
}

export function webContentsForSurface(surfaceId: string): WebContents | null {
  const wcId = webContentsViewIdForSurface(surfaceId)
  if (wcId == null) return null
  const wc = webContents.fromId(wcId)
  return wc && !wc.isDestroyed() ? wc : null
}

export function initWebContentsViewHost(opts: HostCallbacks): void {
  callbacks = opts
}

function activeEntry(e: Entry): TabEntry | null {
  return e.tabs.find((t) => t.tabId === e.activeTab) ?? e.tabs[0] ?? null
}

// Electron 31 still ships canGoBack/goBack on webContents (deprecated in 32); navigationHistory.*
// is the forward API. Feature-detect so this code survives the Electron bump unchanged.
function navHistory(wc: WebContents): { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void } {
  const nh = (wc as unknown as { navigationHistory?: { canGoBack?: () => boolean; canGoForward?: () => boolean; goBack?: () => void; goForward?: () => void } }).navigationHistory
  if (nh && typeof nh.canGoBack === 'function' && typeof nh.goBack === 'function') {
    return nh as ReturnType<typeof navHistory>
  }
  return {
    canGoBack: () => wc.canGoBack(),
    canGoForward: () => wc.canGoForward(),
    goBack: () => wc.goBack(),
    goForward: () => wc.goForward()
  }
}

function pushNavState(e: Entry, t: TabEntry, extra: TabStatePatch = {}): void {
  const wc = t.view.webContents
  if (quitting || wc.isDestroyed()) return
  const nav = navHistory(wc)
  // An empty url/title means "no document committed yet" (did-start-loading fires before the first
  // commit), NOT page state — omitting them keeps a pre-commit push from clearing the tab's intended
  // url in the store (the race that blanked persisted tabs at boot).
  const url = wc.getURL()
  const title = wc.getTitle()
  callbacks?.onTabState(
    e.id,
    t.tabId,
    { ...(url ? { url } : {}), ...(title ? { title } : {}), canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward(), ...extra },
    activeEntry(e)?.tabId === t.tabId
  )
}

// Hide-by-position, NEVER setVisible: macOS WebContentsView has a wedge where a view that starts
// (or cycles through) setVisible(false) can stay blank after setVisible(true) — the renderer
// reports document.visibilityState 'visible' and paints internally, but the window never composites
// it (exactly the live symptom: blank holes over the backdrop). Views are always "visible"; hidden
// tabs are simply PARKED far offscreen, and showing one is a plain setBounds.
const PARKED: Rectangle = { x: -32000, y: -32000, width: 800, height: 600 }

function createTab(e: Entry, decl: TabDecl): TabEntry {
  const cb = callbacks!
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      // OPAQUE guest page, like every real browser tab. `transparent` DEFAULTS TO TRUE for a guest
      // page (electron.d.ts: "the background will remain transparent"), so Blink composites the page
      // WITH ALPHA and any region it leaves unpainted (a centered column's margins, a short page) is
      // see-through. Over the desktop that just reveals the L0 backdrop (unnoticed); when one browser
      // overlaps ANOTHER, the lower page shows THROUGH the upper one even though the upper view is
      // correctly on top (the reported overlap bleed). This must be set at CONSTRUCTION — it is a
      // webPreferences flag, not a runtime setter; setBackgroundColor alone does NOT defeat it.
      transparent: false
    }
  })
  view.setBackgroundColor('#ffffff') // the pre-paint flash color (white, browser default) under the now-opaque page
  view.setBounds(PARKED)
  cb.getWindow()?.contentView.addChildView(view)

  const wc = view.webContents
  wc.zoomFactor = e.zoom
  const t: TabEntry = { tabId: decl.id, view, wcId: wc.id }
  e.tabs.push(t)

  attachGuestWindowPolicy(wc, {
    openSurface: (url) => cb.onOpenTab(e.id, url),
    logPlan: (plan, d) =>
      console.log(
        `[guest] popup ${plan.kind} <- ${JSON.stringify({ url: String(d.url).slice(0, 80), disposition: d.disposition, features: d.features })}`
      )
  })

  // This block intentionally attaches 11 listeners (focus/context/dom-ready/load/fail + 6 nav-state
  // pushes) — over Node's default warn threshold of 10, which fired MaxListenersExceededWarning on
  // every web surface (caught by telemetry on two machines). Raise the cap; the count is by design.
  wc.setMaxListeners(20)
  wc.on('focus', () => cb.onFocus(e.id))
  wc.on('cursor-changed', (_ev, type) => cb.onCursor(e.id, String(type)))
  wc.on('context-menu', (ev, params) => {
    ev.preventDefault()
    cb.onContextMenu(e.id, params.x, params.y)
  })
  // Every page load of the ACTIVE tab re-registers it (CDP target + perception sensor re-inject —
  // a navigation destroys the in-page sensors, so dom-ready must re-install them, as the old
  // single-view host did via its onReady).
  wc.on('dom-ready', () => {
    const cur = entries.get(e.id)
    if (cur && activeEntry(cur)?.tabId === t.tabId) cb.onActiveContent(e.id, wc.id)
  })
  wc.on('did-finish-load', () => console.log('[guest] loaded:', redactUrl(wc.getURL())))
  wc.on('did-fail-load', (_ev, code, desc, failedUrl) => {
    if (code !== -3) console.log(`[guest] fail-load ${code} ${desc} ${failedUrl}`)
  })
  // Push-model page state (wexond updateNavigationState): the chrome re-renders off these, never polls.
  wc.on('did-start-loading', () => pushNavState(e, t, { loading: true, favicon: '' })) // clear a stale favicon on nav (wexond view.ts:153)
  wc.on('did-stop-loading', () => pushNavState(e, t, { loading: false }))
  wc.on('did-navigate', () => pushNavState(e, t))
  wc.on('did-navigate-in-page', () => pushNavState(e, t))
  wc.on('page-title-updated', () => pushNavState(e, t))
  wc.on('page-favicon-updated', (_ev, icons) => pushNavState(e, t, { favicon: icons[icons.length - 1] || '' }))
  wc.once('destroyed', () => {
    if (quitting) return // app teardown, not tab death — never mutate renderer state from it
    // Identity-checked drop: ONLY remove the tab whose webContents this was. (The original
    // single-view host deleted by surfaceId alone here — a StrictMode remount then made the OLD
    // view's async death delete the NEW entry, orphaning a live view on screen with no owner.)
    const cur = entries.get(e.id)
    const idx = cur ? cur.tabs.findIndex((x) => x.tabId === t.tabId && x.wcId === t.wcId) : -1
    if (!cur || idx < 0) return
    cur.tabs.splice(idx, 1)
    cb.onTabGone(e.id, t.tabId)
    if (cur.activeTab === t.tabId) {
      cur.activeTab = cur.tabs[Math.min(idx, cur.tabs.length - 1)]?.tabId ?? null
      applyEntry(cur)
      cb.onActiveContent(e.id, webContentsViewIdForSurface(e.id))
    }
  })

  let shiftDown = false
  let sawOther = false
  let altHeld = false
  wc.on('before-input-event', (ev, input) => {
    if (inputForwarder?.(input)) {
      ev.preventDefault()
      return
    }
    if (input.type === 'keyDown') {
      if (input.key === 'Shift') {
        shiftDown = true
        sawOther = false
      } else if (shiftDown) {
        sawOther = true
      }
      if (input.key === 'Alt') {
        if (!input.isAutoRepeat && !input.meta && !input.control && !input.shift) {
          altHeld = true
          cb.onAltHold('down')
        }
      } else if (altHeld) {
        altHeld = false
        cb.onAltHold('cancel')
      }
    } else if (input.type === 'keyUp') {
      if (input.key === 'Shift') {
        // TODO: a bare ⇧ then a mouse click IN this page (⇧-click / range-select) still reads as a tap —
        // before-input-event is keyboard-only, so the click never sets sawOther here (the renderer sees
        // that pointerdown, not main). A single ⇧ tap now splays the stages (two open the workspace
        // selector), so a stray ⇧-click in a focused page can trigger that. A full fix needs main to
        // forward the ⇧ down/up edges so the renderer (which sees page clicks) can arbitrate the bare tap.
        if (shiftDown && !sawOther) cb.onShiftTap()
        shiftDown = false
      } else if (input.key === 'Alt' && altHeld) {
        altHeld = false
        cb.onAltHold('up')
      }
    }
  })

  // An url-less tab still loads about:blank: a webContents with NO committed document queues every
  // executeJavaScript on an internal did-stop-loading forever (observed: a hung CDP eval + a
  // listener pile-up from the perception drain, both pointed at an empty "+" tab).
  void wc.loadURL(decl.url || 'about:blank').catch(() => {})
  return t
}

function destroyTab(e: Entry, t: TabEntry): void {
  const i = e.tabs.indexOf(t)
  if (i >= 0) e.tabs.splice(i, 1)
  try {
    callbacks?.getWindow()?.contentView.removeChildView(t.view)
  } catch {
    /* already detached */
  }
  const wc = t.view.webContents
  try {
    if (!wc.isDestroyed()) {
      // destroy(), not close(): close() is async (beforeunload, graceful teardown) and its late
      // 'destroyed' is exactly the race that orphaned views. destroy() is immediate + final.
      const d = (wc as unknown as { destroy?: () => void }).destroy
      if (typeof d === 'function') d.call(wc)
      else wc.close()
    }
  } catch {
    /* already gone */
  }
}

/** Position the active tab's view; PARK the rest offscreen. The single place visibility is decided
 *  — by POSITION, never setVisible (see PARKED above for the macOS wedge this avoids). */
function applyEntry(e: Entry): void {
  const act = activeEntry(e)
  for (const t of e.tabs) {
    const show = t === act && e.visible && !!e.rect
    try {
      t.view.setBounds(show && e.rect ? e.rect : PARKED)
      if (!t.view.webContents.isDestroyed()) t.view.webContents.zoomFactor = e.zoom
    } catch {
      /* view torn down mid-apply */
    }
  }
  reorderViews()
}

/**
 * Declaratively mirror the renderer's tab list: create missing views, destroy removed ones, switch
 * the active view. Idempotent — the renderer calls it on any tabs/activeTab/zoom change.
 */
export function syncWebContentsViewTabs(surfaceId: string, tabs: TabDecl[], active: string | null, zoom = 1): void {
  const cb = callbacks
  if (!cb || !cb.getWindow()) return
  console.log('[host] sync', surfaceId.slice(0, 8), JSON.stringify(tabs.map((t) => ({ id: t.id.slice(0, 8), url: redactUrl(t.url) }))), 'active', active?.slice(0, 8))
  const pending = pendingCloses.get(surfaceId)
  if (pending) {
    clearTimeout(pending) // remount within the grace window (StrictMode) — keep the live views
    pendingCloses.delete(surfaceId)
  }
  let e = entries.get(surfaceId)
  if (!e) {
    e = { id: surfaceId, tabs: [], activeTab: null, rect: null, visible: false, z: 0, zoom }
    entries.set(surfaceId, e)
  }
  e.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1

  // Capture the pre-reconcile active BEFORE creating/destroying views, or the first sync's
  // null→tab transition is invisible and CDP/perception never get their target.
  const prevActive = activeEntry(e)
  const want = new Map(tabs.filter((t) => t && t.id).map((t) => [t.id, t]))
  for (const t of [...e.tabs]) if (!want.has(t.tabId)) destroyTab(e, t)
  // LAZY session restore: materialize ONLY the active tab on first sight; a background tab stays
  // DEFERRED (no view, no process, no load) until it is first activated, then keeps its live view.
  // Restoring/opening a browser with N tabs otherwise spawned N WebContentsViews + N loads at once
  // (the spike behind "open my Chrome tabs"). Activating a deferred tab re-syncs (the renderer's
  // active-id dep) → it materializes here; navigate is a no-op for the unmaterialized (below).
  const activeId = active && want.has(active) ? active : (e.tabs.find((t) => want.has(t.tabId))?.tabId ?? [...want.keys()][0] ?? null)
  for (const decl of want.values()) {
    if (e.tabs.some((t) => t.tabId === decl.id)) continue // already materialized → keep its live view
    if (decl.id === activeId) createTab(e, decl) // the visible tab loads now; the rest wait for a click
  }

  e.activeTab = activeId && e.tabs.some((t) => t.tabId === activeId) ? activeId : (e.tabs[0]?.tabId ?? null)
  applyEntry(e)

  const nowActive = activeEntry(e)
  if (nowActive !== prevActive || !prevActive) {
    cb.onActiveContent(surfaceId, webContentsViewIdForSurface(surfaceId))
    if (nowActive) {
      pushNavState(e, nowActive) // freshly shown tab: give the chrome its current url/title/nav state
      // Do NOT wc.focus() here. In the sandwich, focusing a page's webContents hands macOS KEY to the
      // L0 pages window — but a tab switch is driven by a click on the L1 tab strip, which just took
      // key to L1 (App.tsx pointerdown → uiFocus). Stealing it back to L0 leaves L1 non-key, so the
      // user's NEXT UI click is swallowed by macOS just to re-key L1 (the "click a tab twice to switch"
      // bug). The page receives keyboard focus when the user clicks INTO it (onHoleDown → pageFocus),
      // the intended handoff; an agent/programmatic tab switch likewise must never grab the human's key.
    }
  }
}


export function updateWebContentsViewBounds(surfaceId: string, rect: Rectangle, visible: boolean, z: number, zoom = 1): void {
  const e = entries.get(surfaceId)
  if (!e || !callbacks?.getWindow()) return
  // NO clamping: a frame partially panned off the window's top/left must keep its view glued to the
  // anchor (negative coords are valid — Electron clips to the window). The old Math.max(0,…) clamp
  // pinned views to the edge and visibly detached them from their frames.
  e.rect = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  }
  e.z = Number.isFinite(z) ? z : 0
  e.visible = !!visible && e.rect.width > 1 && e.rect.height > 1
  e.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : e.zoom
  applyEntry(e)
}

/** Navigate ONE tab (address bar submit, agent update_surface{url}, bookmark click). */
export function navigateWebContentsView(surfaceId: string, tabId: string | null, url: string): void {
  const e = entries.get(surfaceId)
  if (!e) return
  // A specified-but-unmaterialized tab (a deferred lazy-restore tab) is a NO-OP — it loads when first
  // activated. NEVER fall back to the active tab here, or a per-tab navigate would hijack the visible
  // tab to a background tab's url. tabId:null still means "the active tab" (chrome address bar).
  const t = tabId ? e.tabs.find((x) => x.tabId === tabId) : activeEntry(e)
  const wc = t?.view.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    if (wc.getURL() !== url) void wc.loadURL(url).catch(() => {})
  } catch {
    /* not ready */
  }
}

/** Browser chrome buttons → the surface's ACTIVE tab. */
export function webContentsViewNavAction(surfaceId: string, action: 'back' | 'forward' | 'reload' | 'stop'): void {
  const wc = webContentsForSurface(surfaceId)
  if (!wc) return
  try {
    const nav = navHistory(wc)
    if (action === 'back' && nav.canGoBack()) nav.goBack()
    else if (action === 'forward' && nav.canGoForward()) nav.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'stop') wc.stop()
  } catch {
    /* view torn down */
  }
}


export function focusWebContentsView(surfaceId: string): void {
  const wc = webContentsForSurface(surfaceId)
  try {
    if (wc && !wc.isDestroyed()) wc.focus()
  } catch {
    /* ignore */
  }
}

export function closeWebContentsView(surfaceId: string): void {
  const e = entries.get(surfaceId)
  if (!e || pendingCloses.has(surfaceId)) return
  pendingCloses.set(
    surfaceId,
    setTimeout(() => {
      pendingCloses.delete(surfaceId)
      const cur = entries.get(surfaceId)
      if (!cur) return
      entries.delete(surfaceId)
      for (const t of [...cur.tabs]) destroyTab(cur, t)
      callbacks?.onActiveContent(surfaceId, null)
    }, 80)
  )
}

/** Stack all visible active views by their surface z (child-array order IS the z-order). */
function reorderViews(): void {
  const win = callbacks?.getWindow()
  if (!win) return
  const ordered = [...entries.values()]
    .map((e) => ({ e, t: activeEntry(e) }))
    .filter((x): x is { e: Entry; t: TabEntry } => !!x.t && x.e.visible)
    .sort((a, b) => a.e.z - b.e.z)
  for (const { t } of ordered) {
    try {
      win.contentView.addChildView(t.view)
    } catch {
      /* view/window gone */
    }
  }
}
