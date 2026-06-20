// AttachPanel — the attachment section, INJECTED INLINE below the message bar (not a separate view). A composer's
// attach "+" toggles it; the island grows to accommodate it (island.css .isl-attach-wrap). Two equal rounded dashed
// boxes — LEFT = the drop zone (drag a macOS window in: it glows on screen and you drop its icon here, wired to the
// real window picker), RIGHT = the connectors list (REAL): the user's browser windows + tabs (Chrome connector +
// Safari) and app windows. Clicking a row toggles it CONNECTED — giving the agent access (connectTab/connectWindow);
// click again disconnects (connectionDrop). The marked set is the live `connections.list()`, matched by `ref`.
import './attach.css'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

type Tab = { tabId: number | string; title?: string; url?: string; browser?: string; windowId?: number; active?: boolean; favIconUrl?: string }
type Win = { windowId: number; app?: string; title?: string; icon?: string }
type Conn = { connId: string; type?: string; ref?: number | string | null }
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
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  // Windows DROPPED into the dropbox: their real app icons live here (keyed by connId), hover one for its detail.
  const [dropped, setDropped] = useState<Record<string, AddedSource>>({})
  // the hovered icon → a fixed-position tooltip (portaled to <body> so the dropbox clip can't cut it off).
  const [hover, setHover] = useState<{ src: AddedSource; x: number; y: number } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const conn = bridge()
    if (!conn) return
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
    setTabs(Array.isArray(t.tabs) ? (t.tabs as Tab[]) : [])
    setWindows(Array.isArray(w.windows) ? (w.windows as Win[]) : [])
    setConnections(Array.isArray(c.connections) ? (c.connections as Conn[]) : [])
  }, [activeSessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

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

  async function toggleTab(t: Tab): Promise<void> {
    const conn = bridge()
    if (!conn) return
    setBusy('t' + t.tabId)
    const c = connForTab(t)
    if (c) await conn.disconnect(c.connId)
    else await conn.connectTab(t.tabId, activeSessionId)
    await refresh()
    setBusy(null)
  }
  async function toggleWin(w: Win): Promise<void> {
    const conn = bridge()
    if (!conn) return
    setBusy('w' + w.windowId)
    const c = connForWin(w)
    if (c) await conn.disconnect(c.connId)
    else await conn.connectWindow(w.windowId, activeSessionId)
    await refresh()
    setBusy(null)
  }

  async function install(): Promise<void> {
    const conn = bridge()
    if (!conn) return
    setBusy('install')
    const r = await conn.installExtension()
    if (r?.error) {
      setInstallNote(r.error + (r.extensionDir ? ` — or load unpacked: ${r.extensionDir}` : ''))
      setBusy(null)
      return
    }
    setInstallNote('Installing… waiting for Chrome (relaunch it if it stalls).')
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 2000))
      const t = await conn.listTabs()
      if (Array.isArray(t.tabs) && t.tabs.some((x) => x.browser === 'chrome')) {
        setInstallNote(null)
        setBusy(null)
        await refresh()
        return
      }
    }
    setBusy(null)
    setInstallNote('The connector didn’t connect. Relaunch Chrome and refresh.')
  }

  const groups = browserGroups(tabs)
  const hasChrome = tabs.some((t) => t.browser === 'chrome')
  const droppedList = Object.values(dropped)

  return (
    <div className="att">
      <div className="att-boxes">
        {/* LEFT: the real drop zone. Hover any macOS window (it glows + shows its icon) and drag the icon here. */}
        <div
          className={`att-drop${dragOver ? ' dragover' : ''}${droppedList.length ? ' has-added' : ''}${notice && !notice.ok ? ' failed' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="Drag a macOS window here"
        >
          {droppedList.length === 0 ? (
            <div className="att-drop-hint" data-notice={notice && !notice.ok ? 'err' : undefined}>
              <span className="att-drop-plus" aria-hidden>
                {notice && !notice.ok ? '!' : '+'}
              </span>
              <span>{notice && !notice.ok ? notice.text : dragOver ? 'Release to add' : 'Drag a macOS window here'}</span>
            </div>
          ) : (
            <div className="att-added-grid">
              {droppedList.map((s) => (
                <button
                  key={s.connId}
                  type="button"
                  className="att-added-chip"
                  aria-label={`${s.app} — ${s.title}`}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setHover({ src: s, x: r.left + r.width / 2, y: r.bottom + 8 })
                  }}
                  onMouseLeave={() => setHover(null)}
                >
                  {s.icon ? (
                    <img className="att-added-icon" src={`data:image/png;base64,${s.icon}`} alt={s.app} draggable={false} />
                  ) : (
                    <span className="att-added-icon att-added-fallback" aria-hidden>
                      {s.app.slice(0, 1)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT: the connectors list — browser windows (expand to tabs) + app windows. Click a row to connect it. */}
        <div className="att-apps" role="list">
          {groups.map((g) => {
            const isExp = expanded.has(g.id)
            const connCount = g.tabs.filter((t) => connForTab(t)).length
            return (
              <div key={g.id} className="att-app-group">
                <button
                  type="button"
                  className="att-app"
                  aria-expanded={isExp}
                  onClick={() =>
                    setExpanded((e) => {
                      const next = new Set(e)
                      next.has(g.id) ? next.delete(g.id) : next.add(g.id)
                      return next
                    })
                  }
                >
                  <span className="att-twisty" aria-hidden>
                    {isExp ? '▾' : '▸'}
                  </span>
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
                        >
                          <Favicon src={t.favIconUrl} />
                          <span className="att-tab-title">{t.title || t.url || String(t.tabId)}</span>
                          {connected && (
                            <span className="att-conn-check" aria-hidden>
                              ✓
                            </span>
                          )}
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
              >
                <AppIcon src={w.icon} name={w.app} />
                <span className="att-tab-title">{label}</span>
                {connected && (
                  <span className="att-conn-check" aria-hidden>
                    ✓
                  </span>
                )}
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
            <span className="att-tip-app">{hover.src.app}</span>
            <span className="att-tip-val">{hover.src.title || '—'}</span>
          </div>,
          document.body
        )}
    </div>
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
  return <img className="att-favicon" src={src} alt="" aria-hidden onError={() => setFailed(true)} />
}

// A 16px macOS app icon (base64 PNG, resolved from the window's pid in app-icons.ts). Falls back to the app's
// first letter when the icon is missing or fails to decode.
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
    <img className="att-favicon att-app-icon" src={`data:image/png;base64,${src}`} alt="" aria-hidden onError={() => setFailed(true)} />
  )
}

export default AttachPanel
