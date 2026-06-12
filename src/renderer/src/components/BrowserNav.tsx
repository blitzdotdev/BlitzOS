import { useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop, webTabsOf } from '../store'

// The browser navbar of a web surface: back/forward/reload-stop, the address bar, the bookmark star
// and the bookmarks dropdown. Patterns ported from the reference browsers (.repos/min, .repos/
// browser-base): nav state is PUSHED per tab from main (never polled); the address input holds a
// per-tab DRAFT that a navigation event may only clobber while the input is NOT focused.

/** min urlParser.parse, the safe subset: explicit http(s)/about pass through, anything with a dot or
 *  localhost gets https://, everything else becomes a search. javascript:/data:/file: from the
 *  address bar are deliberately not navigable (same scheme-filter doctrine as .weblink's safeUrl). */
export function normalizeAddress(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t) || /^about:/i.test(t)) return t
  if (!/\s/.test(t) && (t.includes('.') || /^localhost(:\d+)?(\/|$)/i.test(t))) return 'https://' + t
  return 'https://www.google.com/search?q=' + encodeURIComponent(t)
}

export function BrowserNav({
  surface,
  bmOpen,
  setBmOpen
}: {
  surface: Surface
  bmOpen: boolean
  setBmOpen: (on: boolean) => void
}): JSX.Element {
  const updateSurface = useDesktop((s) => s.updateSurface)
  const bookmarks = useDesktop((s) => s.bookmarks)
  const toggleBookmark = useDesktop((s) => s.toggleBookmark)
  const tabs = webTabsOf(surface)
  const tab = tabs[Math.min(Math.max(surface.activeTab || 0, 0), tabs.length - 1)]
  // a fresh tab's about:blank reads as "no address yet" — empty bar + placeholder, like a browser
  const liveUrl = tab.url === 'about:blank' ? '' : (tab.url ?? '')
  // null = not editing → the input mirrors the live url. A string = the user's draft for THIS tab.
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Switching tabs drops the previous tab's draft; a fresh empty tab takes the keyboard.
  useEffect(() => {
    setDraft(null)
    if (!tab.url) inputRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id])

  // The clobber guard (wexond store/tabs.ts:148): when the page navigates UNDER the bar (link click,
  // redirect), resync the input — but never while the user is mid-edit in it.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(null)
  }, [liveUrl])

  const navigate = (url: string): void => {
    // One path for every navigation source: surface.url folds into the active tab's url (store),
    // and the frame's navigate effect drives the main-owned view from the tab url.
    updateSurface(surface.id, { url })
  }

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const url = normalizeAddress(draft ?? liveUrl)
    if (!url) return
    setDraft(null)
    inputRef.current?.blur()
    navigate(url)
  }

  const act = (action: 'back' | 'forward' | 'reload' | 'stop'): void => {
    window.agentOS?.webContentsViewNavAction?.(surface.id, action)
  }

  const starred = !!liveUrl && bookmarks.some((b) => b.url === liveUrl)
  const stop = (e: React.PointerEvent): void => e.stopPropagation()

  return (
    <div className="browser-nav" onPointerDown={stop}>
      <button className="bnav-btn" title="Back" disabled={!tab.canGoBack} onClick={() => act('back')}>
        ‹
      </button>
      <button className="bnav-btn" title="Forward" disabled={!tab.canGoForward} onClick={() => act('forward')}>
        ›
      </button>
      <button
        className="bnav-btn"
        title={tab.loading ? 'Stop' : 'Reload'}
        disabled={!liveUrl}
        onClick={() => act(tab.loading ? 'stop' : 'reload')}
      >
        {tab.loading ? '✕' : '↻'}
      </button>
      <form className="bnav-addr" onSubmit={submit}>
        <input
          ref={inputRef}
          value={draft ?? liveUrl}
          spellCheck={false}
          placeholder="Search or enter address"
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(null)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      </form>
      <button
        className={`bnav-btn bnav-star${starred ? ' on' : ''}`}
        title={starred ? 'Remove bookmark' : 'Bookmark this page'}
        disabled={!liveUrl}
        onClick={() => toggleBookmark(liveUrl, tab.title || surface.title)}
      >
        {starred ? '★' : '☆'}
      </button>
      <button className={`bnav-btn${bmOpen ? ' active' : ''}`} title="Bookmarks" onClick={() => setBmOpen(!bmOpen)}>
        ☰
      </button>
      {bmOpen && (
        <div className="bm-panel">
          {bookmarks.length === 0 && <div className="bm-empty">No bookmarks yet — ★ a page to keep it here.</div>}
          {bookmarks.map((b) => (
            <div
              key={b.id}
              className="bm-row"
              title={b.url}
              onClick={() => {
                setBmOpen(false)
                navigate(b.url)
              }}
            >
              <span className="bm-title">{b.title || b.url}</span>
              <button
                className="bm-remove"
                title="Remove bookmark"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleBookmark(b.url, b.title)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
