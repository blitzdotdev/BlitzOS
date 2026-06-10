import { useCallback, useEffect, useRef, useState } from 'react'

// Mission Control overview: every workspace as a screen-shaped tile (16:10) showing its last-seen
// primary-area snapshot. Responsive grid — quantized integer columns from container WIDTH (capped
// 2..5), fluid cell width, height locked 16:10, overflow scrolls vertically. (Researched from how
// Netflix sizes its rows + the CSS auto-fill/ResizeObserver playbook.)

interface WorkspaceEntry {
  name: string
  nodeCount: number
  updatedAt: number
  thumbTs: number
}

interface Props {
  onClose: () => void
  // App captures the CURRENT board's snapshot, then switches — so the board you leave gets a fresh tile.
  // Resolves {ok:true} on success (the overview is then unmounted by the broadcast), or {ok:false,error}
  // on failure (409 lock / 404 / 500) so we clear the busy state + show the error instead of hanging.
  onSwitch: (name: string) => Promise<{ ok: boolean; error?: string }>
}

const IDEAL = 260
const GAP = 20
const MIN_COLS = 2
const MAX_COLS = 5
const MAX_CONTENT = 1600
const TILE = 360 // max tile width — keeps a lone workspace a normal card, not a full-screen tile

function relTime(ms: number): string {
  if (!ms) return ''
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function Overview({ onClose, onSwitch }: Props): JSX.Element {
  const [list, setList] = useState<WorkspaceEntry[] | null>(null)
  const [active, setActive] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // the name being switched to, or 'create'
  const [failed, setFailed] = useState<Set<string>>(new Set()) // workspaces whose thumb img failed to load
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null) // workspace name pending delete confirmation
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    const r = await window.agentOS?.workspaces?.list()
    if (r && Array.isArray(r.workspaces)) {
      setList(r.workspaces)
      setActive(r.active)
    } else {
      setList([])
      setError((r as { error?: string })?.error || 'could not load workspaces')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refresh, onClose])

  // Quantized columns from container WIDTH, capped 2..5; clamp to item count so 1–2 boards don't
  // balloon. Only write --cols on change (avoids the ResizeObserver feedback loop).
  useEffect(() => {
    const grid = gridRef.current
    const scroller = scrollRef.current
    if (!grid || !scroller) return
    const apply = (W: number): void => {
      const cw = Math.min(W, MAX_CONTENT) // box.inlineSize is already content-box (padding excluded)
      let cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.round((cw + GAP) / (IDEAL + GAP))))
      cols = Math.min(cols, Math.max(1, list?.length ?? 1))
      if (grid.style.getPropertyValue('--cols') !== String(cols)) grid.style.setProperty('--cols', String(cols))
      // cap the grid's own width to the columns it actually uses, so 1–2 workspaces show normal cards
      // (centered) instead of one tile ballooning to fill the screen.
      const gw = `${cols * TILE + (cols - 1) * GAP}px`
      if (grid.style.getPropertyValue('--gridw') !== gw) grid.style.setProperty('--gridw', gw)
    }
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentBoxSize?.[0]
      apply(box ? box.inlineSize : entry.contentRect.width)
    })
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [list?.length])

  async function create(): Promise<void> {
    const name = newName.trim()
    if (!name || busy) return
    setError(null)
    setBusy('create')
    const r = await window.agentOS?.workspaces?.create(name)
    if (!r || !r.ok) {
      setError((r && r.error) || 'could not create')
      setBusy(null)
      return
    }
    setNewName('')
    setBusy(r.name || name)
    const sw = await onSwitch(r.name || name) // create-then-switch
    if (!sw.ok) {
      setError(sw.error || 'created it, but could not open it')
      setBusy(null)
    }
  }

  async function open(name: string): Promise<void> {
    if (busy) return
    if (name === active) {
      onClose()
      return
    }
    setError(null)
    setBusy(name)
    const r = await onSwitch(name)
    // a successful switch unmounts this overview (via the broadcast) before we resume; only a failure
    // returns here — clear busy + surface it so the UI never hangs on "opening…".
    if (!r.ok) {
      setError(r.error || 'could not open workspace')
      setBusy(null)
    }
  }

  // Delete a workspace + its folder (human-confirmed). The main process guards the active/last cases; we
  // only offer the X on non-active tiles when there's more than one, so this is always a safe, other-than-
  // current workspace. On success, re-list so the tile disappears.
  async function remove(name: string): Promise<void> {
    if (busy) return
    setError(null)
    setBusy(name)
    const r = await window.agentOS?.workspaces?.delete(name)
    if (!r || !r.ok) {
      setError((r && r.error) || 'could not delete workspace')
      setBusy(null)
      setConfirmDelete(null)
      return
    }
    setConfirmDelete(null)
    setBusy(null)
    await refresh()
  }

  const thumbUrl = window.agentOS?.workspaces?.thumbUrl

  return (
    <div className="ovr" onPointerDown={onClose}>
      <div className="ovr-scroll" ref={scrollRef} onPointerDown={(e) => e.stopPropagation()}>
        <div className="ovr-head">
          <h2>Workspaces</h2>
          <form
            className="ovr-new"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <input className="ws-input" placeholder="New workspace name" value={newName} maxLength={64} autoFocus onChange={(e) => setNewName(e.target.value)} />
            <button className="primary" type="submit" disabled={!newName.trim() || !!busy}>
              {busy === 'create' ? 'Creating…' : '+ New'}
            </button>
          </form>
          <button className="panel-x ovr-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <div className="panel-error ovr-error">{error}</div>}

        {list === null ? (
          <p className="panel-help">Loading workspaces…</p>
        ) : (
          <div className="ovr-grid" ref={gridRef}>
            {list.map((w) => {
              const isActive = w.name === active
              const isBusy = busy === w.name
              const src = w.thumbTs && thumbUrl ? thumbUrl(w.name, w.thumbTs) : null
              const showImg = !!src && !failed.has(w.name)
              const canDelete = !isActive && (list?.length ?? 0) > 1 // never the current one, never the last one
              const confirming = confirmDelete === w.name
              return (
                <div key={w.name} className="ovr-cell">
                  <button className={`ovr-tile${isActive ? ' on' : ''}`} disabled={!!busy} onClick={() => void open(w.name)} title={isActive ? `${w.name} (current)` : `Open ${w.name}`}>
                    <div className="ovr-thumb">
                      {showImg ? (
                        <img src={src as string} alt="" loading="lazy" onError={() => setFailed((f) => new Set(f).add(w.name))} />
                      ) : (
                        <div className="ovr-thumb-empty">no preview yet</div>
                      )}
                      {isBusy && !confirming && <div className="ovr-thumb-busy">opening…</div>}
                    </div>
                    <div className="ovr-meta">
                      <span className="ovr-dot" />
                      <span className="ovr-name">{w.name}</span>
                      <span className="ovr-sub">
                        {isActive ? 'current' : `${w.nodeCount} window${w.nodeCount === 1 ? '' : 's'}${w.updatedAt ? ` · ${relTime(w.updatedAt)}` : ''}`}
                      </span>
                    </div>
                  </button>
                  {canDelete && !confirmDelete && (
                    <button
                      className="ovr-del"
                      disabled={!!busy}
                      onClick={(e) => {
                        e.stopPropagation()
                        setError(null)
                        setConfirmDelete(w.name)
                      }}
                      title={`Delete ${w.name}`}
                      aria-label={`Delete ${w.name}`}
                    >
                      ×
                    </button>
                  )}
                  {confirming && (
                    <div className="ovr-confirm" onClick={(e) => e.stopPropagation()}>
                      <div className="ovr-confirm-title">Delete “{w.name}”?</div>
                      <div className="ovr-confirm-body">Permanently removes this workspace and its folder — every window, file, and chat in it. This can’t be undone.</div>
                      <div className="ovr-confirm-actions">
                        <button className="ovr-confirm-btn cancel" disabled={isBusy} onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </button>
                        <button className="ovr-confirm-btn danger" disabled={isBusy} onClick={() => void remove(w.name)}>
                          {isBusy ? 'Deleting…' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
