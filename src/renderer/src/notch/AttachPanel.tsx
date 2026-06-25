// AttachPanel — the attachment section, INJECTED INLINE below the message bar (not a separate view). A composer's
// attach "+" toggles it; the island grows to accommodate it (island.css .isl-attach-wrap). Two equal rounded dashed
// boxes — LEFT = the drop zone (drag a macOS window in: it glows on screen and you drop its icon here, wired to the
// real window picker), RIGHT = the connectors list (REAL): the user's browser windows + tabs (Chrome connector +
// Safari) and app windows. Clicking a row toggles it CONNECTED — giving the agent access (connectTab/connectWindow);
// click again disconnects (connectionDrop). The marked set is the live `connections.list()`, matched by `ref`.
import './attach.css'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useStagedSet, stageSources, unstageSources } from './stagingStore'
import { buildTrayGroups, AttachTray, Favicon, AppIcon, type TrayGroup } from './attachTray'
import { publishLiveTray } from './sentTrayStore'

type Tab = { tabId: number | string; title?: string; url?: string; browser?: string; windowId?: number; active?: boolean; favIconUrl?: string; discarded?: boolean }
type Win = { windowId: number; app?: string; title?: string; icon?: string }
type Conn = { connId: string; type?: string; ref?: number | string | null; title?: string; sourceId?: string; origin?: string }
type ConnBridge = {
  listTabs(): Promise<{ tabs?: Tab[]; error?: string }>
  listWindows(): Promise<{ windows?: Win[]; error?: string }>
  list(agentId?: string): Promise<{ connections?: Conn[]; error?: string }>
  connectTab(id: number | string, agentId?: string): Promise<{ error?: string }>
  connectWindow(id: number, agentId?: string): Promise<{ error?: string }>
  disconnect(connId: string): Promise<{ error?: string }>
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

  // The dropbox is a STAGING tray, not a mirror of every live connection: it shows only sources the USER staged
  // (dropped in, or connected from the right list) for their NEXT message, keyed per chat. The tray lives in a
  // module-level external store (stagingStore) so it SURVIVES the island close+reopen — AttachPanel remounts per
  // open, but the store doesn't, so there is nothing to seed or wipe. On SEND it clears (NotchHost.onSend →
  // clearStaged) while the connection stays alive for the agent; the agent's OWN connections (e.g. a reconnect)
  // never enter the tray. A staged key is `tab:<id>` / `window:<id>` / `conn:<id>`.
  const stagedSet = useStagedSet(activeSessionId)
  const markStaged = (...keys: string[]): void => stageSources(activeSessionId, ...keys)
  const isStaged = (c: Conn): boolean =>
    !!stagedSet && (stagedSet.has('conn:' + c.connId) || stagedSet.has((c.type === 'window' ? 'window:' : 'tab:') + String(c.ref)))

  // Latest-wins: listTabs/listWindows hit the extension/helper with variable latency, so an OLDER refresh can
  // resolve AFTER a newer one. Without this guard a stale snapshot (captured before a just-dropped connection
  // existed) clobbers the fresh one → the prune effect then culls the new icon. Stamp each run; apply only the latest.
  const refreshSeq = useRef(0)
  // connSeq tracks refreshConnections() calls so refresh()'s stale connection snapshot can't clobber a newer
  // result. Safari's listTabs osascript is slower than connectTab, so refresh() can finish AFTER
  // refreshConnections() has already applied the new connection — without this guard it overwrites and deselects.
  const connSeq = useRef(0)
  // Apply a BACKEND connection list but PRESERVE optimistic `pending:` placeholders until the backend actually
  // reports the real connection for that source (matched by type+ref). A drop's placeholder (and thus its dropbox
  // icon) therefore survives every refresh until it is reconciled, so no refresh can blank an in-flight drop.
  const applyBackendConns = (backend: Conn[]): void =>
    setConnections((prev) => {
      const stillPending = prev.filter(
        (c) => String(c.connId).startsWith('pending:') && !backend.some((b) => b.type === c.type && String(b.ref) === String(c.ref))
      )
      return stillPending.length ? [...backend, ...stillPending] : backend
    })
  const refresh = useCallback(async (): Promise<void> => {
    const conn = bridge()
    if (!conn) return
    const seq = ++refreshSeq.current
    const connSeqAtStart = connSeq.current
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
    // Only apply connections if no refreshConnections() ran while we were fetching — that call has newer data.
    if (connSeq.current === connSeqAtStart) {
      applyBackendConns(Array.isArray(c.connections) ? (c.connections as Conn[]) : [])
    }
  }, [activeSessionId])

  // Light reconcile after a toggle: re-fetch ONLY the connection set (cheap), NOT tabs/windows — those re-pull
  // every window's app icon (hundreds of KB) and don't change when you connect/disconnect.
  const refreshConnections = useCallback(async (): Promise<void> => {
    const conn = bridge()
    if (!conn || typeof conn.list !== 'function') return
    const seq = ++connSeq.current
    const c = (await conn.list(activeSessionId).then((x) => x || {}).catch(() => ({}))) as { connections?: Conn[] }
    if (seq !== connSeq.current) return // a newer refreshConnections superseded this one
    applyBackendConns(Array.isArray(c.connections) ? c.connections : [])
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
      else if (m.kind === 'dropped') {
        // OPTIMISTIC: show the dropped app's icon in the dropbox INSTANTLY, before main resolves the tab + connects
        // (a Chrome bounds-match takes a beat). Mirrors the window-list connect's pending pattern; the `connected`
        // event below swaps in the real connId (and refresh() drops this placeholder).
        setDragOver(false)
        const wid = Number(m.windowId)
        if (!Number.isFinite(wid)) return
        markStaged('window:' + wid)
        setConnections((prev) => (prev.some((c) => c.type === 'window' && String(c.ref) === String(wid)) ? prev : [...prev, { connId: 'pending:w' + wid, type: 'window', ref: wid }]))
        setDropped((prev) => ({ ...prev, ['pending:w' + wid]: { connId: 'pending:w' + wid, app: String(m.app || 'Window'), icon: typeof m.icon === 'string' && m.icon ? m.icon : undefined, title: String(m.title || '') } }))
      }
      else if (m.kind === 'connected') {
        setDragOver(false)
        const wid = Number(m.windowId)
        const pendingId = Number.isFinite(wid) ? 'pending:w' + wid : ''
        if (!m.ok) {
          // Failed connect: drop the optimistic placeholder (connection + icon), then surface the reason.
          if (pendingId) {
            setConnections((prev) => prev.filter((c) => c.connId !== pendingId))
            setDropped((prev) => {
              if (!prev[pendingId]) return prev
              const n = { ...prev }
              delete n[pendingId]
              return n
            })
          }
          setNotice({ ok: false, text: String(m.error || `Couldn't add ${String(m.app || 'window')}`) })
          return
        }
        const connId = String(m.connId || '')
        if (!connId) return
        markStaged('conn:' + connId) // a macOS-window drop = the user staging it
        const src: AddedSource = {
          connId,
          app: String(m.app || 'Window'),
          icon: typeof m.icon === 'string' && m.icon ? m.icon : undefined,
          title: String(m.title || '')
        }
        // ATOMIC swap: replace the optimistic placeholder with the REAL connId IN PLACE, and re-key its icon in the
        // SAME commit. There is never a render where `dropped` holds an id that `connections` lacks, so the prune
        // effect cannot wipe the icon. refreshConnections() (cheap) then loads the accurate conn; the heavy refresh()
        // is deliberately NOT used here (it blanked the dropbox to the empty hint for its whole duration).
        setConnections((prev) => {
          if (pendingId && prev.some((c) => c.connId === pendingId)) return prev.map((c) => (c.connId === pendingId ? { ...c, connId } : c))
          if (prev.some((c) => c.connId === connId)) return prev
          return [...prev, { connId, type: 'window', ref: Number.isFinite(wid) ? wid : connId }]
        })
        setDropped((prev) => {
          const n = { ...prev }
          if (pendingId && n[pendingId]) delete n[pendingId]
          n[connId] = { ...prev[connId], ...src }
          return n
        })
        void refreshConnections() // accurate conn list; preserve-pending keeps any other in-flight drops
      } else if (m.kind === 'error') setNotice({ ok: false, text: String(m.error || 'window picker unavailable') })
    })
    return () => {
      try {
        off?.()
      } catch {
        /* best-effort */
      }
    }
  }, [refreshConnections])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), notice.ok ? 2800 : 4500) // errors linger so the reason is readable
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
    if (!existing) markStaged('tab:' + t.tabId) // user staged it for the next message
    setConnections((prev) =>
      existing ? prev.filter((c) => c.connId !== existing.connId) : [...prev, { connId: 'pending:t' + t.tabId, type: 'tab', ref: t.tabId }]
    )
    void (existing ? conn.disconnect(existing.connId) : conn.connectTab(t.tabId, activeSessionId)).catch(() => {}).then(() => refreshConnections())
  }
  function toggleWin(w: Win): void {
    const conn = bridge()
    if (!conn) return
    const existing = connForWin(w)
    if (!existing) markStaged('window:' + w.windowId) // user staged it for the next message
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
    const gone = connections.find((x) => x.connId === connId)
    unstageSources(activeSessionId, 'conn:' + connId, ...(gone ? [(gone.type === 'window' ? 'window:' : 'tab:') + String(gone.ref)] : []))
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
  function removeGroup(g: TrayGroup): void {
    const ids = new Set(g.items.map((it) => it.connId))
    const keys: string[] = []
    for (const it of g.items) {
      keys.push('conn:' + it.connId)
      const gone = connections.find((x) => x.connId === it.connId)
      if (gone) keys.push((gone.type === 'window' ? 'window:' : 'tab:') + String(gone.ref))
    }
    unstageSources(activeSessionId, ...keys)
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

  // Chrome is driven extension-free via Apple Events, so “Connect Chrome” installs nothing — it just shows the
  // ONE-TIME toggle Chrome needs (View ▸ Developer ▸ Allow JavaScript from Apple Events) before its tabs surface here.
  function install(): void {
    setInstallNote('To connect Chrome, turn on Chrome ▸ View ▸ Developer ▸ “Allow JavaScript from Apple Events” once, then open a tab. Its tabs then appear here automatically.')
  }

  const groups = browserGroups(tabs)
  const hasChrome = tabs.some((t) => t.browser === 'chrome')
  // The browser app icon for a group row (chevron → icon → name): reuse the helper's real app-window icon for the
  // matching browser (Chrome/Safari is also an open macOS app), falling back to a letter tile.
  const iconByApp = new Map<string, string>()
  for (const w of windows) if (w.app && w.icon) iconByApp.set(w.app, w.icon)
  const groupIcon = (b?: string): string | undefined => iconByApp.get(b === 'chrome' ? 'Google Chrome' : b === 'safari' ? 'Safari' : b || '')
  // Browsers are shown ABOVE as tab GROUPS, so hide their app-window rows from the helper's window list — otherwise
  // the same open Chrome/Safari window ALSO appears as a flat "window" row (the duplicate the user sees). Only hide a
  // browser whose tabs we actually surfaced (JS bridge on); if its tabs aren't available, keep the window row as a fallback.
  const browserAppsShown = new Set<string>()
  for (const g of groups) {
    const b = g.tabs[0]?.browser
    if (b === 'chrome') browserAppsShown.add('Google Chrome')
    else if (b === 'safari') browserAppsShown.add('Safari')
  }
  const appWindows = windows.filter((w) => !browserAppsShown.has(w.app || ''))
  // The dropbox tray (LEFT box) = the staged sources, grouped — built by the SHARED buildTrayGroups so the live
  // dropbox and the frozen in-chat snapshot can never drift. Memoized so the published live copy + the AttachTray
  // only churn when the staged set / lists actually change.
  const trayGroups = useMemo(
    () => buildTrayGroups(connections, tabs, windows, dropped, isStaged),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connections, tabs, windows, dropped, stagedSet]
  )
  const hasAttached = trayGroups.length > 0
  // Publish this chat's live tray so a SEND can freeze an exact copy (sentTrayStore.getLiveTray → IslandPanel).
  useEffect(() => {
    publishLiveTray(activeSessionId, trayGroups)
  }, [activeSessionId, trayGroups])

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
            <AttachTray groups={trayGroups} onRemoveConn={removeConn} onRemoveGroup={removeGroup} />
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
                  <AppIcon src={groupIcon(g.tabs[0]?.browser)} name={g.label} brand={g.tabs[0]?.browser} />
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
                          className={`att-tab${connected ? ' connected' : ''}${t.discarded ? ' discarded' : ''}`}
                          disabled={busy === 't' + t.tabId}
                          aria-pressed={connected}
                          onClick={() => void toggleTab(t)}
                          draggable
                          onDragStart={(e) => onDragStartItem(e, { kind: 'tab', tabId: t.tabId })}
                        >
                          <Favicon src={t.favIconUrl} />
                          <span className="att-tab-title">
                            {t.discarded
                              ? <span className="att-tab-discarded">Tab {Number(t.tabId?.toString().split(':')[2] ?? 0)} — not loaded</span>
                              : (t.title || t.url || String(t.tabId))}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* app windows (from the computer-use helper) — single connectables, no children. */}
          {appWindows.map((w, i) => {
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
    </div>
  )
}

export default AttachPanel
