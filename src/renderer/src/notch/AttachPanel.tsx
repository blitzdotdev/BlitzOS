// AttachPanel — the attachment section, INJECTED INLINE below the message bar (not a separate view). A composer's
// attach "+" toggles it; the island grows to accommodate it (island.css .isl-attach-wrap). Two equal rounded dashed
// boxes — LEFT = the drop zone (drag a macOS window in: it glows on screen and you drop its icon here, wired to the
// real window picker), RIGHT = the connectors list (REAL): the user's browser windows + tabs (Chrome connector +
// Safari) and app windows. Clicking a row toggles it CONNECTED — giving the agent access (connectTab/connectWindow);
// click again disconnects (connectionDrop). The marked set is the live `connections.list()`, matched by `ref`.
import './attach.css'
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'

type Tab = { tabId: number | string; title?: string; url?: string; browser?: string; windowId?: number; active?: boolean; favIconUrl?: string }
type Win = { windowId: number; app?: string; title?: string; icon?: string }
type Conn = { connId: string; type?: string; ref?: number | string | null; title?: string; sourceId?: string }
type ConnBridge = {
  listTabs(): Promise<{ tabs?: Tab[]; error?: string }>
  listWindows(): Promise<{ windows?: Win[]; error?: string }>
  list(agentId?: string): Promise<{ connections?: Conn[]; error?: string }>
  connectTab(id: number | string, agentId?: string): Promise<{ error?: string }>
  connectWindow(id: number, agentId?: string): Promise<{ error?: string }>
  disconnect(connId: string): Promise<{ error?: string }>
  installExtension(): Promise<{ error?: string; note?: string; extensionDir?: string }>
}

const bridge = (): ConnBridge | undefined =>
  (window as unknown as { agentOS?: { connections?: ConnBridge } }).agentOS?.connections

// One browser window = one expandable group, numbered per browser in discovery order ("Chrome", "Chrome (1)", …).
type Group = { id: string; label: string; tabs: Tab[] }
function browserGroups(tabs: Tab[]): Group[] {
  const order: string[] = []
  const byKey = new Map<string, { browser: string; tabs: Tab[] }>()
  for (const t of tabs) {
    const browser = t.browser || 'tab'
    const key = browser + ':' + (t.windowId ?? 0)
    let g = byKey.get(key)
    if (!g) {
      g = { browser, tabs: [] }
      byKey.set(key, g)
      order.push(key)
    }
    g.tabs.push(t)
  }
  const seen: Record<string, number> = {}
  return order.map((key) => {
    const g = byKey.get(key)!
    const name = g.browser.charAt(0).toUpperCase() + g.browser.slice(1)
    const n = seen[g.browser] || 0
    seen[g.browser] = n + 1
    return { id: key, label: n === 0 ? name : `${name} (${n})`, tabs: g.tabs }
  })
}

// A window DROPPED into the dropbox (via the macOS picker). The window TITLE is the general "what got added" signal —
// no per-app classification: Ghostty puts its working dir in the title, Chrome its page title, every app puts
// something identifying. So two Ghostty windows read as two dirs, two Chrome windows as two pages.
interface AddedSource {
  connId: string
  app: string // "Google Chrome", "Ghostty"
  icon?: string // base64 PNG of the real macOS app icon
  title: string // the window title (the dir for a terminal, the page for a browser)
}

// The grouped view of the attached tray (the LEFT box), derived from `connections`. An item is one connected
// source (a tab carries a favicon; a window item just a title). A group is one browser's tabs or one app's windows.
type AttachItem = { connId: string; favicon?: string; title: string }
type AttachGroup = { key: string; type: 'tab' | 'window'; label: string; appIcon?: string; items: AttachItem[] }

// activeSessionId = the chat this attach panel belongs to ('' = the new-session composer; sources attached there are
// reassigned to the agent on spawn). It OWNS what gets connected, so connection_list scopes per chat + the attach
// wakes the right agent.
export function AttachPanel({ activeSessionId = '' }: { activeSessionId?: string }): JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [windows, setWindows] = useState<Win[]>([])
  const [connections, setConnections] = useState<Conn[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null) // a row id mid connect/disconnect, or 'install'
  const [installNote, setInstallNote] = useState<string | null>(null)
  // Live feedback from the macOS window picker (NotchHost arms it while this panel is open).
  const [dragOver, setDragOver] = useState(false)
  // Live feedback for an INTERNAL drag: a connectors-list row (or child tab) being dragged onto the drop zone.
  const [listDragOver, setListDragOver] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  // Windows DROPPED into the dropbox: their real app icons live here (keyed by connId), hover one for its detail.
  const [dropped, setDropped] = useState<Record<string, AddedSource>>({})
  // the hovered item → a fixed-position tooltip (portaled to <body> so the dropbox clip can't cut it off).
  const [hover, setHover] = useState<{ app: string; title: string; x: number; y: number } | null>(null)
  const showTip = (el: HTMLElement, app: string, title: string): void => {
    const r = el.getBoundingClientRect()
    setHover({ app, title, x: r.left + r.width / 2, y: r.bottom + 8 })
  }

  // Latest-wins: listTabs/listWindows hit the extension/helper with variable latency, so an OLDER refresh can
  // resolve AFTER a newer one. Without this guard a stale snapshot (captured before a just-dropped connection
  // existed) clobbers the fresh one → the prune effect then culls the new icon. Stamp each run; apply only the latest.
  const refreshSeq = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const conn = bridge()
    if (!conn) return
    const seq = ++refreshSeq.current
    // Fault-tolerant: fetch each source independently so ONE missing/throwing bridge method (e.g. list() — a new
    // preload export — before the running dev has reloaded the preload) can't blank the whole list.
    const get = (fn: unknown): Promise<Record<string, unknown>> =>
      typeof fn === 'function'
        ? (fn as () => Promise<Record<string, unknown>>)().then((x) => x || {}).catch(() => ({}))
        : Promise.resolve({})
    // list() is scoped to THIS chat (its owned connections); the available tabs/windows are global.
    const listScoped = (): Promise<Record<string, unknown>> =>
      typeof conn.list === 'function' ? conn.list(activeSessionId).then((x) => x || {}).catch(() => ({})) : Promise.resolve({})
    const [t, w, c] = await Promise.all([get(conn.listTabs), get(conn.listWindows), listScoped()])
    if (seq !== refreshSeq.current) return // a newer refresh superseded this one — don't apply stale data
    setTabs(Array.isArray(t.tabs) ? (t.tabs as Tab[]) : [])
    setWindows(Array.isArray(w.windows) ? (w.windows as Win[]) : [])
    setConnections(Array.isArray(c.connections) ? (c.connections as Conn[]) : [])
  }, [activeSessionId])

  // Light reconcile after a toggle: re-fetch ONLY the connection set (cheap), NOT tabs/windows — those re-pull
  // every window's app icon (hundreds of KB) and don't change when you connect/disconnect.
  const refreshConnections = useCallback(async (): Promise<void> => {
    const conn = bridge()
    if (!conn || typeof conn.list !== 'function') return
    const c = (await conn.list(activeSessionId).then((x) => x || {}).catch(() => ({}))) as { connections?: Conn[] }
    setConnections(Array.isArray(c.connections) ? c.connections : [])
  }, [activeSessionId])

  // Poll-friendly: just the available tabs (listTabs is cheap — NO icons), so the Chrome group appears the moment
  // the connector connects, even while the panel stays open.
  const refreshTabs = useCallback(async (): Promise<void> => {
    const conn = bridge()
    if (!conn || typeof conn.listTabs !== 'function') return
    const t = (await conn.listTabs().then((x) => x || {}).catch(() => ({}))) as { tabs?: Tab[] }
    setTabs(Array.isArray(t.tabs) ? t.tabs : [])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Live updates while open: the connector/helper attach with latency, so poll the CHEAP sources (tabs +
  // connections, not the heavy window-icon fetch) so the list tracks reality without a manual re-open.
  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshTabs()
      void refreshConnections()
    }, 2500)
    return () => clearInterval(id)
  }, [refreshTabs, refreshConnections])

  useEffect(() => {
    const off = window.agentOS?.pick?.onEvent?.((m) => {
      if (m.kind === 'pick_over') setDragOver(!!m.inside)
      else if (m.kind === 'pick_cancel') setDragOver(false)
      else if (m.kind === 'connected') {
        setDragOver(false)
        if (!m.ok) {
          setNotice({ ok: false, text: `Couldn't add ${String(m.app || 'window')}` })
          return
        }
        void refresh() // a window was dropped in → reflect it in the connectors list too
        const connId = String(m.connId || '')
        if (!connId) return
        const src: AddedSource = {
          connId,
          app: String(m.app || 'Window'),
          icon: typeof m.icon === 'string' && m.icon ? m.icon : undefined,
          title: String(m.title || '')
        }
        setDropped((prev) => ({ ...prev, [connId]: { ...prev[connId], ...src } }))
      } else if (m.kind === 'error') setNotice({ ok: false, text: String(m.error || 'window picker unavailable') })
    })
    return () => {
      try {
        off?.()
      } catch {
        /* best-effort */
      }
    }
  }, [refresh])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 2800)
    return () => clearTimeout(t)
  }, [notice])

  // Keep the dropbox icons in sync with disconnects done from the connectors list: drop any whose connection is gone.
  useEffect(() => {
    setDropped((prev) => {
      const live = new Set(connections.map((c) => c.connId))
      const next: Record<string, AddedSource> = {}
      let changed = false
      for (const [k, v] of Object.entries(prev)) {
        if (live.has(k)) next[k] = v
        else changed = true
      }
      return changed ? next : prev
    })
  }, [connections])

  // Connected lookup: a tab/window is connected iff a live connection carries its id as `ref`.
  const connForTab = (t: Tab): Conn | undefined => connections.find((c) => c.type === 'tab' && String(c.ref) === String(t.tabId))
  const connForWin = (w: Win): Conn | undefined => connections.find((c) => c.type === 'window' && String(c.ref) === String(w.windowId))

  // OPTIMISTIC toggle: flip the row's connected state INSTANTLY (zero input delay), then run the real
  // connect/disconnect + a light connections-only reconcile in the background. If the op fails, the reconcile
  // restores the true state.
  function toggleTab(t: Tab): void {
    const conn = bridge()
    if (!conn) return
    const existing = connForTab(t)
    setConnections((prev) =>
      existing ? prev.filter((c) => c.connId !== existing.connId) : [...prev, { connId: 'pending:t' + t.tabId, type: 'tab', ref: t.tabId }]
    )
    void (existing ? conn.disconnect(existing.connId) : conn.connectTab(t.tabId, activeSessionId)).catch(() => {}).then(() => refreshConnections())
  }
  function toggleWin(w: Win): void {
    const conn = bridge()
    if (!conn) return
    const existing = connForWin(w)
    setConnections((prev) =>
      existing ? prev.filter((c) => c.connId !== existing.connId) : [...prev, { connId: 'pending:w' + w.windowId, type: 'window', ref: w.windowId }]
    )
    void (existing ? conn.disconnect(existing.connId) : conn.connectWindow(w.windowId, activeSessionId)).catch(() => {}).then(() => refreshConnections())
  }
  // Click a browser-group row → connect ALL its tabs at once (or disconnect them all if they're already all
  // connected). Each toggleTab is optimistic, so the whole group highlights instantly.
  function toggleGroup(g: Group): void {
    const allConnected = g.tabs.length > 0 && g.tabs.every((t) => connForTab(t))
    for (const t of g.tabs) if (!!connForTab(t) === allConnected) toggleTab(t)
  }

  // Remove an attached source via its hover X: disconnect the connection. Optimistic — drop it from `connections`
  // (the dropbox + the right list both render from that) and the pick cache immediately so it vanishes with zero
  // delay, then disconnect + reconcile in the background.
  function removeConn(connId: string): void {
    setHover(null)
    setConnections((prev) => prev.filter((c) => c.connId !== connId))
    setDropped((prev) => {
      if (!(connId in prev)) return prev
      const next = { ...prev }
      delete next[connId]
      return next
    })
    const conn = bridge()
    if (!conn) return
    void conn.disconnect(connId).catch(() => {}).then(() => refreshConnections())
  }
  // Remove a WHOLE group via its top-right X: disconnect every item in it (same optimistic path as removeConn).
  function removeGroup(g: AttachGroup): void {
    setHover(null)
    const ids = new Set(g.items.map((it) => it.connId))
    setConnections((prev) => prev.filter((c) => !ids.has(c.connId)))
    setDropped((prev) => {
      let changed = false
      const next: Record<string, AddedSource> = {}
      for (const [k, v] of Object.entries(prev)) {
        if (ids.has(k)) changed = true
        else next[k] = v
      }
      return changed ? next : prev
    })
    const conn = bridge()
    if (!conn) return
    void Promise.all(g.items.map((it) => conn.disconnect(it.connId).catch(() => {}))).then(() => refreshConnections())
  }

  // Internal drag-and-drop: drag a connectors-list row (a browser group, a child tab, or an app window) onto the
  // drop zone to connect it. HTML5 DnD inside the renderer — separate from the native macOS-window picker (the
  // cursor stays over the island, so the picker never grabs an external window). Drop = connect (never disconnect).
  const DRAG_MIME = 'application/x-blitz-conn'
  type DragPayload = { kind: 'tab'; tabId: number | string } | { kind: 'group'; tabIds: Array<number | string> } | { kind: 'window'; windowId: number }
  const onDragStartItem = (e: DragEvent<HTMLElement>, payload: DragPayload): void => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }
  const onBoxDragOver = (e: DragEvent<HTMLElement>): void => {
    if (!Array.from(e.dataTransfer.types).includes(DRAG_MIME)) return // only our internal rows, not files/text
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!listDragOver) setListDragOver(true)
  }
  const onBoxDragLeave = (e: DragEvent<HTMLElement>): void => {
    if (e.currentTarget === e.target) setListDragOver(false) // ignore leaves between the box's own children
  }
  const onBoxDrop = (e: DragEvent<HTMLElement>): void => {
    setListDragOver(false)
    let p: DragPayload | null = null
    try {
      p = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as DragPayload
    } catch {
      p = null
    }
    if (!p) return
    e.preventDefault()
    const connectTabById = (id: number | string): void => {
      const t = tabs.find((x) => String(x.tabId) === String(id))
      if (t && !connForTab(t)) toggleTab(t) // toggleTab connects when not already connected
    }
    if (p.kind === 'tab') connectTabById(p.tabId)
    else if (p.kind === 'group') for (const id of p.tabIds) connectTabById(id)
    else if (p.kind === 'window') {
      const w = windows.find((x) => String(x.windowId) === String(p.windowId))
      if (w && !connForWin(w)) toggleWin(w)
    }
  }

  // Force-install is dead on a non-MDM Mac (and we ship no .crx), so "Connect Chrome" shows the ONE reliable path:
  // load the connector unpacked, once. (installExtension is called only to recover the extension's folder path.)
  async function install(): Promise<void> {
    const conn = bridge()
    const r = (conn ? await conn.installExtension().catch(() => ({})) : {}) as { extensionDir?: string }
    const dir = r.extensionDir || '<repo>/extension'
    setInstallNote(`To connect Chrome, load the BlitzOS Connector once: chrome://extensions → enable Developer mode → “Load unpacked” → select ${dir}`)
  }

  const groups = browserGroups(tabs)
  const hasChrome = tabs.some((t) => t.browser === 'chrome')
  // The browser app icon for a group row (chevron → icon → name): reuse the helper's real app-window icon for the
  // matching browser (Chrome/Safari is also an open macOS app), falling back to a letter tile.
  const iconByApp = new Map<string, string>()
  for (const w of windows) if (w.app && w.icon) iconByApp.set(w.app, w.icon)
  const groupIcon = (b?: string): string | undefined => iconByApp.get(b === 'chrome' ? 'Google Chrome' : b === 'safari' ? 'Safari' : b || '')
  // The dropbox is the canonical ATTACHED tray, derived from `connections` (so it two-way-syncs with the right
  // list: connect a tab there and it shows here too). Grouped so 10 Chrome tabs read as ONE Chrome pill of
  // favicons, not 10 identical app icons. Tabs → one pill per browser (app icon | favicons). Windows → grouped by
  // app (app icon | title labels) at 2+, else a single plain app-icon chip. Enriched from the live tab/window
  // lists + the pick cache (a freshly dropped window's icon/title, before the lists refresh).
  const tabByRef = new Map(tabs.map((t) => [String(t.tabId), t]))
  const winByRef = new Map(windows.map((w) => [String(w.windowId), w]))
  const tabG = new Map<string, AttachGroup>()
  const winG = new Map<string, AttachGroup>()
  for (const c of connections) {
    if (c.type === 'window') {
      const w = winByRef.get(String(c.ref))
      const d = dropped[c.connId]
      const app = d?.app || w?.app || c.title || c.sourceId || 'Window'
      let g = winG.get(app)
      if (!g) {
        g = { key: 'a:' + app, type: 'window', label: app, appIcon: d?.icon || w?.icon, items: [] }
        winG.set(app, g)
      }
      if (!g.appIcon) g.appIcon = d?.icon || w?.icon
      g.items.push({ connId: c.connId, title: d?.title || w?.title || c.title || app })
    } else {
      const t = tabByRef.get(String(c.ref))
      const browser = t?.browser || 'chrome'
      let g = tabG.get(browser)
      if (!g) {
        g = { key: 'b:' + browser, type: 'tab', label: browser === 'safari' ? 'Safari' : 'Chrome', appIcon: groupIcon(browser), items: [] }
        tabG.set(browser, g)
      }
      g.items.push({ connId: c.connId, favicon: t?.favIconUrl, title: t?.title || t?.url || c.title || c.sourceId || 'Tab' })
    }
  }
  // Tab groups are always a pill (even one tab → a Chrome pill); a window group is a pill only at 2+, else a
  // single plain icon chip.
  const pillGroups = [...tabG.values(), ...winG.values()].filter((g) => g.type === 'tab' || g.items.length >= 2)
  const singleWindows = [...winG.values()].filter((g) => g.items.length === 1)
  const hasAttached = connections.length > 0

  return (
    <div className="att">
      <div className="att-boxes">
        {/* LEFT: the attached tray (canonical, from `connections`) — also still the live macOS-window drop zone. */}
        <div
          className={`att-drop${dragOver || listDragOver ? ' dragover' : ''}${hasAttached ? ' has-added' : ''}${notice && !notice.ok ? ' failed' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Drag a macOS window here"
          onDragOver={onBoxDragOver}
          onDragLeave={onBoxDragLeave}
          onDrop={onBoxDrop}
        >
          {!hasAttached ? (
            <div className="att-drop-hint" data-notice={notice && !notice.ok ? 'err' : undefined}>
              <span>{notice && !notice.ok ? notice.text : dragOver || listDragOver ? 'Release to add' : 'Drag a macOS window here'}</span>
            </div>
          ) : (
            <div className="att-added-stack">
              {pillGroups.map((g) => (
                <div className="att-pill" key={g.key}>
                  {/* group remove (top-right) — drops the WHOLE group at once; same glass X as a single chip */}
                  <button type="button" className="att-pill-remove" aria-label={`Remove all ${g.label}`} title={`Remove all ${g.label}`} onClick={() => removeGroup(g)}>
                    <RemoveX />
                  </button>
                  <span className="att-pill-app">
                    <AppIcon src={g.appIcon} name={g.label} />
                  </span>
                  <span className="att-pill-div" aria-hidden />
                  <span className="att-pill-items">
                    {g.items.map((it, i) => (
                      <div
                        className="att-pill-item"
                        key={it.connId}
                        onMouseEnter={(e) => showTip(e.currentTarget, g.label, it.title)}
                        onMouseLeave={() => setHover(null)}
                      >
                        {g.type === 'tab' ? (
                          <Favicon src={it.favicon} />
                        ) : (
                          // non-browser windows: a fake alphabet tile (A, B, C…) instead of the dir text; the real
                          // title is on hover (tooltip). Same size as every other icon.
                          <span className="att-pill-letter" aria-hidden>
                            {String.fromCharCode(65 + (i % 26))}
                          </span>
                        )}
                        <button type="button" className="att-added-remove" aria-label={`Remove ${it.title}`} title={`Remove ${it.title}`} onClick={() => removeConn(it.connId)}>
                          <RemoveX />
                        </button>
                      </div>
                    ))}
                  </span>
                </div>
              ))}
              {singleWindows.length > 0 && (
                <div className="att-singles">
                  {singleWindows.map((g) => {
                    const it = g.items[0]
                    return (
                      <div
                        className="att-added-chip"
                        key={g.key}
                        onMouseEnter={(e) => showTip(e.currentTarget, g.label, it.title)}
                        onMouseLeave={() => setHover(null)}
                      >
                        {g.appIcon ? (
                          <img className="att-added-icon" src={`data:image/png;base64,${g.appIcon}`} alt={g.label} draggable={false} />
                        ) : (
                          <span className="att-added-icon att-added-fallback" aria-hidden>
                            {g.label.slice(0, 1)}
                          </span>
                        )}
                        <button type="button" className="att-added-remove" aria-label={`Remove ${g.label}`} title={`Remove ${g.label}`} onClick={() => removeConn(it.connId)}>
                          <RemoveX />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT: the connectors list — browser windows (expand to tabs) + app windows. Click a row to connect it. */}
        <div className="att-apps" role="list">
          {groups.map((g) => {
            const isExp = expanded.has(g.id)
            const connCount = g.tabs.filter((t) => connForTab(t)).length
            const gAllConn = g.tabs.length > 0 && connCount === g.tabs.length
            return (
              <div key={g.id} className="att-app-group">
                <button
                  type="button"
                  className={`att-app${gAllConn ? ' connected' : ''}`}
                  onClick={() => toggleGroup(g)}
                  draggable
                  onDragStart={(e) => onDragStartItem(e, { kind: 'group', tabIds: g.tabs.map((t) => t.tabId) })}
                >
                  <span
                    className="att-twisty"
                    role="button"
                    aria-label={isExp ? 'Collapse' : 'Expand'}
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpanded((prev) => {
                        const next = new Set(prev)
                        next.has(g.id) ? next.delete(g.id) : next.add(g.id)
                        return next
                      })
                    }}
                  >
                    {isExp ? '▾' : '▸'}
                  </span>
                  <AppIcon src={groupIcon(g.tabs[0]?.browser)} name={g.label} />
                  <span className="att-app-name">{g.label}</span>
                  {connCount > 0 && <span className="att-app-conn">{connCount}</span>}
                  <span className="att-app-count">{g.tabs.length}</span>
                </button>
                {isExp && (
                  <div className="att-tabs">
                    {g.tabs.map((t) => {
                      const connected = !!connForTab(t)
                      return (
                        <button
                          key={String(t.tabId)}
                          type="button"
                          className={`att-tab${connected ? ' connected' : ''}`}
                          disabled={busy === 't' + t.tabId}
                          aria-pressed={connected}
                          onClick={() => void toggleTab(t)}
                          draggable
                          onDragStart={(e) => onDragStartItem(e, { kind: 'tab', tabId: t.tabId })}
                        >
                          <Favicon src={t.favIconUrl} />
                          <span className="att-tab-title">{t.title || t.url || String(t.tabId)}</span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* app windows (from the computer-use helper) — single connectables, no children. */}
          {windows.map((w, i) => {
            const connected = !!connForWin(w)
            const label = (w.title || '').trim() && w.title !== w.app ? w.title! : `${w.app || 'window'} ${i + 1}`
            return (
              <button
                key={w.windowId}
                type="button"
                className={`att-tab att-win${connected ? ' connected' : ''}`}
                disabled={busy === 'w' + w.windowId}
                aria-pressed={connected}
                onClick={() => void toggleWin(w)}
                draggable
                onDragStart={(e) => onDragStartItem(e, { kind: 'window', windowId: w.windowId })}
              >
                <AppIcon src={w.icon} name={w.app} />
                <span className="att-tab-title">{label}</span>
              </button>
            )
          })}

          {/* empty / install affordances */}
          {!hasChrome && (
            <button type="button" className="att-install" disabled={busy === 'install'} onClick={() => void install()}>
              {busy === 'install' ? 'Installing…' : '+ Connect Chrome'}
            </button>
          )}
          {installNote && <div className="att-note">{installNote}</div>}
          {groups.length === 0 && windows.length === 0 && !installNote && (
            <div className="att-note">Open a tab in Chrome/Safari, or a macOS app window, to connect it.</div>
          )}
        </div>
      </div>
      {/* hover tooltip for a dropped app icon — portaled to <body> so the dropbox's clip can't cut it off. */}
      {hover &&
        createPortal(
          <div className="att-tip" style={{ left: hover.x, top: hover.y }} role="tooltip">
            <span className="att-tip-app">{hover.app}</span>
            <span className="att-tip-val">{hover.title || '—'}</span>
          </div>,
          document.body
        )}
    </div>
  )
}

// The small × glyph shared by every remove control (favicon hover-overlay, window label, single chip).
function RemoveX(): JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden>
      <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// A 16px favicon with a globe-glyph fallback (some favIconUrls are chrome-internal and won't load cross-context).
function Favicon({ src }: { src?: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <span className="att-favicon att-favicon-fallback" aria-hidden>
        ◍
      </span>
    )
  }
  return <img className="att-favicon" src={src} alt="" aria-hidden draggable={false} onError={() => setFailed(true)} />
}

// A 16px macOS app icon (base64 PNG the BlitzComputerUse helper resolves per window via NSRunningApplication.icon).
// Falls back to the app's first letter when the icon is missing or fails to decode.
function AppIcon({ src, name }: { src?: string; name?: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <span className="att-favicon att-app-fallback" aria-hidden>
        {(name || '?').slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img className="att-favicon att-app-icon" src={`data:image/png;base64,${src}`} alt="" aria-hidden draggable={false} onError={() => setFailed(true)} />
  )
}

export default AttachPanel
