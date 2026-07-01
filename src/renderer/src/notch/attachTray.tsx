// The shared attachment-tray render — used by BOTH the live dropbox (AttachPanel, interactive) and the frozen
// in-chat snapshot (IslandPanel, read-only). One grouping + one component so the two can never drift. The grouping
// is a pure function; the component owns its own hover tooltip (portaled to <body>). Scroll is the parent's job.
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { brandGlyph } from './browserIcons'
import { openLightbox } from './lightboxStore'
import './attach.css'

// One attached source (a tab carries a favicon; a window item just a title; an attachment carries a path + optional thumbnail)
// and a group (one browser's tabs, one app's windows, or one image). These are the frozen snapshot's on-disk shape
// too — keep them serializable (no functions). `path`/`thumb` are present only on image items.
export type TrayItem = { connId: string; favicon?: string; title: string; path?: string; thumb?: string; kind?: 'image' | 'pdf' | 'file' }
export type TrayGroup = { key: string; type: 'tab' | 'window' | 'image'; label: string; appIcon?: string; items: TrayItem[] }

// The inputs the grouping reads (subsets of the connection / tab / window / pick-cache / image-store shapes).
type ConnLike = { connId: string; type?: string; ref?: number | string | null; title?: string; sourceId?: string }
type TabLike = { tabId: number | string; title?: string; url?: string; browser?: string; favIconUrl?: string }
type WinLike = { windowId: number; app?: string; title?: string; icon?: string }
type DroppedLike = Record<string, { app?: string; icon?: string; title?: string }>
type ImageLike = { id: string; path: string; name: string; thumb: string; kind?: 'image' | 'pdf' | 'file' }

// A connected tab carries its origin host as `sourceId` (e.g. "x.com"). When the tab isn't in the live `tabs` list
// (the user hasn't opted into listing tabs, or the tab was discarded/closed while its connection stays staged), we
// have no live favIconUrl, so derive the favicon from that host. The <Favicon> direct-load + main-fetch fallback
// then handle it. Returns undefined for non-web sourceIds (a window bundle id, "newtab", etc.) → globe.
function faviconFromSourceId(sourceId?: string): string | undefined {
  const s = (sourceId || '').trim()
  if (!s) return undefined
  if (s.includes('://')) {
    try {
      return new URL(s).origin + '/favicon.ico'
    } catch {
      return undefined
    }
  }
  if (s.includes('/') || s.includes(' ') || !s.includes('.')) return undefined // not a bare web host
  return `https://${s}/favicon.ico`
}

// Build the grouped tray from the live lists, filtered to the staged sources. Tabs → one pill per browser (a favicon
// per tab); windows → grouped by app (a letter tile per window). A window group of one renders as a lone icon chip;
// everything else is a pill (decided in AttachTray). Pure — the live dropbox and the frozen snapshot share it.
export function buildTrayGroups(
  connections: ConnLike[],
  tabs: TabLike[],
  windows: WinLike[],
  dropped: DroppedLike,
  isStaged: (c: ConnLike) => boolean,
  images: ImageLike[] = []
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
      g.items.push({ connId: c.connId, favicon: t?.favIconUrl || faviconFromSourceId(c.sourceId), title: t?.title || t?.url || c.title || c.sourceId || 'Tab' })
    }
  }
  // File attachments: one group per file (a single item) so each renders as its own removable chip. Images remain
  // click-to-expand; PDFs render as file chips. connId IS the staging key so existing unstage paths work.
  const imageGroups: TrayGroup[] = images.map((m) => ({
    key: (m.kind === 'image' || !m.kind ? 'image:' : 'file:') + m.id,
    type: 'image',
    label: m.name,
    items: [{ connId: (m.kind === 'image' || !m.kind ? 'image:' : 'file:') + m.id, title: m.name, path: m.path, thumb: m.thumb, kind: m.kind || 'image' }]
  }))
  return [...tabG.values(), ...winG.values(), ...imageGroups]
}

// The shared render. `readOnly` (the in-chat snapshot) drops every remove control + connect/drag handler but keeps the
// hover tooltip; the parent supplies scroll. Interactive mode (the live dropbox) passes onRemoveConn/onRemoveGroup.
export function AttachTray({
  groups,
  readOnly = false,
  disableImagePreview = false,
  onRemoveConn,
  onRemoveGroup
}: {
  groups: TrayGroup[]
  readOnly?: boolean
  disableImagePreview?: boolean
  onRemoveConn?: (connId: string) => void
  onRemoveGroup?: (g: TrayGroup) => void
}): JSX.Element {
  const [hover, setHover] = useState<{ app: string; title: string; x: number; y: number } | null>(null)
  const showTip = (el: HTMLElement, app: string, title: string): void => {
    const r = el.getBoundingClientRect()
    setHover({ app, title, x: r.left + r.width / 2, y: r.bottom + 8 })
  }
  // Tab groups are always a pill (even one tab → a Chrome pill); a window group is a pill at 2+, else a lone chip.
  const pillGroups = groups.filter((g) => g.type === 'tab' || (g.type === 'window' && g.items.length >= 2))
  const singleWindows = groups.filter((g) => g.type === 'window' && g.items.length === 1)
  const imageGroups = groups.filter((g) => g.type === 'image')
  const lightboxImages = imageGroups
    .map((g) => g.items[0])
    .filter((it): it is TrayItem & { path: string } => !!it?.path && (it.kind === 'image' || !it.kind))
    .map((it) => ({ path: it.path, name: it.title, thumb: it.thumb || '' }))
  return (
    <div className={`att-added-stack${readOnly ? ' read-only' : ''}`}>
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
      {imageGroups.length > 0 && (
        <div className="att-images">
          {imageGroups.map((g) => {
            const it = g.items[0]
            return (
              <div
                className="att-image-chip"
                key={g.key}
                onMouseEnter={(e) => showTip(e.currentTarget, it.kind === 'image' || !it.kind ? 'Image' : 'File', it.title)}
                onMouseLeave={() => setHover(null)}
              >
                {it.kind === 'image' || !it.kind ? (
                  <button
                    type="button"
                    className={`att-image-open${disableImagePreview ? ' no-preview' : ''}`}
                    title={`Open ${it.title}`}
                    aria-label={`Open ${it.title}`}
                    aria-disabled={disableImagePreview || undefined}
                    tabIndex={disableImagePreview ? -1 : undefined}
                    onClick={() => {
                      if (disableImagePreview || !it.path) return
                      openLightbox({ path: it.path, name: it.title, thumb: it.thumb || '' }, lightboxImages)
                    }}
                  >
                    {it.thumb ? <img className="att-image-thumb" src={it.thumb} alt={it.title} draggable={false} /> : <span className="att-image-thumb att-image-fallback" aria-hidden>IMG</span>}
                  </button>
                ) : (
                  <div className="att-image-open att-file-open" aria-hidden>
                    <span className="att-file-corner" />
                    <span className="att-file-kind">{it.kind === 'pdf' ? 'PDF' : 'FILE'}</span>
                  </div>
                )}
                {!readOnly && onRemoveConn && (
                  <button type="button" className="att-added-remove" aria-label={`Remove ${it.title}`} title={`Remove ${it.title}`} onClick={() => onRemoveConn(it.connId)}>
                    <RemoveX />
                  </button>
                )}
                <span className="att-image-name" title={it.title}>{it.title}</span>
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

// Resolve a failed favicon via the main process (a neutral fetch dodges sites that serve an HTML wall to the
// renderer's browser-flavored <img> request). Best-effort; null = keep the globe.
function resolveFaviconRemote(url: string): Promise<string | null> {
  const api = (window as unknown as { agentOS?: { connections?: { resolveFavicon?: (u: string) => Promise<string | null> } } }).agentOS?.connections
  if (!api?.resolveFavicon) return Promise.resolve(null)
  return api.resolveFavicon(url).catch(() => null)
}

// Per-src state, so a row reused for another tab (or a tab that navigates) never flashes a stale icon or globe:
// the render reads state ONLY when it belongs to the current src. `resolving` = direct load failed and the main
// fetch is in flight (show the globe meanwhile); `done` = a main-fetched data: URL; `failed` = give up.
type FaviconState = { src: string; phase: 'resolving' | 'done' | 'failed'; dataUrl?: string }

// A favicon with a globe-glyph fallback. Fast path: load `<origin>/favicon.ico` directly. If that <img> errors
// (a site serving an HTML wall, a 404, a cross-context chrome-internal URL), fall back ONCE to a main-process
// fetch that returns the real bytes as a data: URL. Working favicons (x.com, github) never trigger the fallback.
export function Favicon({ src }: { src?: string }): JSX.Element {
  const [st, setSt] = useState<FaviconState | null>(null)
  const seqRef = useRef(0) // a newer attempt invalidates an older in-flight resolve (stale-response guard)
  const cur = st && st.src === src ? st : null // ignore state left over from a previous src

  const globe = (
    <span className="att-favicon att-favicon-fallback" aria-hidden>
      ◍
    </span>
  )
  if (!src || cur?.phase === 'failed' || cur?.phase === 'resolving') return globe
  if (cur?.phase === 'done' && cur.dataUrl) {
    // The main-resolved data URL is validated bytes, so it should never error; if it somehow does, give up to the globe.
    return <img className="att-favicon" src={cur.dataUrl} alt="" aria-hidden draggable={false} onError={() => setSt({ src, phase: 'failed' })} />
  }
  // Fast path: the site's own favicon, loaded directly. On error, kick the one-shot neutral main fetch.
  return (
    <img
      className="att-favicon"
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => {
        setSt({ src, phase: 'resolving' })
        const forSrc = src
        const mySeq = ++seqRef.current
        void resolveFaviconRemote(src).then((dataUrl) => {
          if (mySeq !== seqRef.current) return // a newer src/attempt superseded this one — drop the stale result
          setSt({ src: forSrc, phase: dataUrl ? 'done' : 'failed', dataUrl: dataUrl || undefined })
        })
      }}
    />
  )
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
