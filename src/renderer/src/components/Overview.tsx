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
  onSwitch: (name: string) => void
}

const IDEAL = 260
const GAP = 20
const MIN_COLS = 2
const MAX_COLS = 5
const MAX_CONTENT = 1600

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
      const cw = Math.min(W, MAX_CONTENT) - 2 * GAP
      let cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.round((cw + GAP) / (IDEAL + GAP))))
      cols = Math.min(cols, Math.max(1, list?.length ?? 1))
      if (grid.style.getPropertyValue('--cols') !== String(cols)) grid.style.setProperty('--cols', String(cols))
    }
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentBoxSize?.[0]
      apply(box ? box.inlineSize : entry.contentRect.width)
    })
    ro.observe(scroller)
    return () => ro.disconnect()
  }, [list])

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
    onSwitch(r.name || name) // create-then-switch; App closes the overview on the switch broadcast
  }

  function open(name: string): void {
    if (busy) return
    if (name === active) {
      onClose()
      return
    }
    setBusy(name)
    onSwitch(name)
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
              return (
                <button key={w.name} className={`ovr-tile${isActive ? ' on' : ''}`} disabled={!!busy} onClick={() => open(w.name)} title={isActive ? `${w.name} (current)` : `Open ${w.name}`}>
                  <div className="ovr-thumb">
                    {src ? (
                      <img src={src} alt="" loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                    ) : (
                      <div className="ovr-thumb-empty">no preview yet</div>
                    )}
                    {isBusy && <div className="ovr-thumb-busy">opening…</div>}
                  </div>
                  <div className="ovr-meta">
                    <span className="ovr-dot" />
                    <span className="ovr-name">{w.name}</span>
                    <span className="ovr-sub">
                      {isActive ? 'current' : `${w.nodeCount} window${w.nodeCount === 1 ? '' : 's'}${w.updatedAt ? ` · ${relTime(w.updatedAt)}` : ''}`}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
