// The shared attachment-tray render — used by BOTH the live dropbox (AttachPanel, interactive) and the frozen
// in-chat snapshot (IslandPanel, read-only). One grouping + one component so the two can never drift. The grouping
// is a pure function; the component owns its own hover tooltip (portaled to <body>). Scroll is the parent's job.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { brandGlyph } from './browserIcons'
import './attach.css'

// One attached source (a tab carries a favicon; a window item just a title) and a group (one browser's tabs or one
// app's windows). These are the frozen snapshot's on-disk shape too — keep them serializable (no functions).
export type TrayItem = { connId: string; favicon?: string; title: string }
export type TrayGroup = { key: string; type: 'tab' | 'window'; label: string; appIcon?: string; items: TrayItem[] }

// The inputs the grouping reads (subsets of the connection / tab / window / pick-cache shapes).
type ConnLike = { connId: string; type?: string; ref?: number | string | null; title?: string; sourceId?: string }
type TabLike = { tabId: number | string; title?: string; url?: string; browser?: string; favIconUrl?: string }
type WinLike = { windowId: number; app?: string; title?: string; icon?: string }
type DroppedLike = Record<string, { app?: string; icon?: string; title?: string }>

// Build the grouped tray from the live lists, filtered to the staged sources. Tabs → one pill per browser (a favicon
// per tab); windows → grouped by app (a letter tile per window). A window group of one renders as a lone icon chip;
// everything else is a pill (decided in AttachTray). Pure — the live dropbox and the frozen snapshot share it.
export function buildTrayGroups(
  connections: ConnLike[],
  tabs: TabLike[],
  windows: WinLike[],
  dropped: DroppedLike,
  isStaged: (c: ConnLike) => boolean
): TrayGroup[] {
  const iconByApp = new Map<string, string>()
  for (const w of windows) if (w.app && w.icon) iconByApp.set(w.app, w.icon)
  const groupIcon = (b?: string): string | undefined => iconByApp.get(b === 'chrome' ? 'Google Chrome' : b === 'safari' ? 'Safari' : b || '')
  const tabByRef = new Map(tabs.map((t) => [String(t.tabId), t]))
  const winByRef = new Map(windows.map((w) => [String(w.windowId), w]))
  const tabG = new Map<string, TrayGroup>()
  const winG = new Map<string, TrayGroup>()
  for (const c of connections) {
    if (!isStaged(c)) continue
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
  return [...tabG.values(), ...winG.values()]
}

// The shared render. `readOnly` (the in-chat snapshot) drops every remove control + connect/drag handler but keeps the
// hover tooltip; the parent supplies scroll. Interactive mode (the live dropbox) passes onRemoveConn/onRemoveGroup.
export function AttachTray({
  groups,
  readOnly = false,
  onRemoveConn,
  onRemoveGroup
}: {
  groups: TrayGroup[]
  readOnly?: boolean
  onRemoveConn?: (connId: string) => void
  onRemoveGroup?: (g: TrayGroup) => void
}): JSX.Element {
  const [hover, setHover] = useState<{ app: string; title: string; x: number; y: number } | null>(null)
  const showTip = (el: HTMLElement, app: string, title: string): void => {
    const r = el.getBoundingClientRect()
    setHover({ app, title, x: r.left + r.width / 2, y: r.bottom + 8 })
  }
  // Tab groups are always a pill (even one tab → a Chrome pill); a window group is a pill at 2+, else a lone chip.
  const pillGroups = groups.filter((g) => g.type === 'tab' || g.items.length >= 2)
  const singleWindows = groups.filter((g) => g.type === 'window' && g.items.length === 1)
  return (
    <div className="att-added-stack">
      {pillGroups.map((g) => (
        <div className="att-pill" key={g.key}>
          {!readOnly && onRemoveGroup && (
            <button type="button" className="att-pill-remove" aria-label={`Remove all ${g.label}`} title={`Remove all ${g.label}`} onClick={() => onRemoveGroup(g)}>
              <RemoveX />
            </button>
          )}
          <span className="att-pill-app">
            <AppIcon src={g.appIcon} name={g.label} brand={g.type === 'tab' ? g.key.slice(2) : undefined} />
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
                  <span className="att-pill-letter" aria-hidden>
                    {String.fromCharCode(65 + (i % 26))}
                  </span>
                )}
                {!readOnly && onRemoveConn && (
                  <button type="button" className="att-added-remove" aria-label={`Remove ${it.title}`} title={`Remove ${it.title}`} onClick={() => onRemoveConn(it.connId)}>
                    <RemoveX />
                  </button>
                )}
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
                ) : brandGlyph(g.label) ? (
                  <span className="att-added-icon att-brand-icon" aria-hidden>
                    {brandGlyph(g.label)}
                  </span>
                ) : (
                  <span className="att-added-icon att-added-fallback" aria-hidden>
                    {g.label.slice(0, 1)}
                  </span>
                )}
                {!readOnly && onRemoveConn && (
                  <button type="button" className="att-added-remove" aria-label={`Remove ${g.label}`} title={`Remove ${g.label}`} onClick={() => onRemoveConn(it.connId)}>
                    <RemoveX />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
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

// The small × glyph shared by every remove control.
export function RemoveX(): JSX.Element {
  return (
    <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden>
      <path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

// A favicon with a globe-glyph fallback (some favIconUrls are chrome-internal and won't load cross-context).
export function Favicon({ src }: { src?: string }): JSX.Element {
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

// A macOS app icon (base64 PNG the helper resolves per window). When the helper icon is missing/broken, fall back to
// the browser BRAND glyph (Chrome/Safari are reliable even with no helper) and only then to the app's first letter.
// `brand` is the precise browser key when the caller has it; otherwise `name` (the app/group label) is matched.
export function AppIcon({ src, name, brand }: { src?: string; name?: string; brand?: string }): JSX.Element {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    const glyph = brandGlyph(brand || name)
    if (glyph)
      return (
        <span className="att-favicon att-brand-icon" aria-hidden>
          {glyph}
        </span>
      )
    return (
      <span className="att-favicon att-app-fallback" aria-hidden>
        {(name || '?').slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return <img className="att-favicon att-app-icon" src={`data:image/png;base64,${src}`} alt="" aria-hidden draggable={false} onError={() => setFailed(true)} />
}
