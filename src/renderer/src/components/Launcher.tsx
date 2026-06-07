import { useEffect, useRef, useState } from 'react'

// The workspace launcher (server-mode only): list workspaces, switch between them, create a new
// one. A workspace = a folder; switching swaps the whole canvas (the backend re-hydrates over SSE).
// Mirrors ConnectPanel's overlay/panel pattern. The active row is non-clickable; switching is
// confirmed by App's onAction('switch'), which closes this and swaps the canvas.

interface WorkspaceEntry {
  name: string
  path: string
  nodeCount: number
  updatedAt: number
}

interface Props {
  onClose: () => void
}

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

export function Launcher({ onClose }: Props): JSX.Element {
  const [list, setList] = useState<WorkspaceEntry[] | null>(null)
  const [active, setActive] = useState<string>('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // the name being switched to, or 'create'
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.agentOS?.workspaces?.list().then((r) => {
      if (r) {
        setList(r.workspaces)
        setActive(r.active)
      }
    })
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    inputRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function open(name: string): Promise<void> {
    if (busy || name === active) return
    setError(null)
    setBusy(name)
    const r = await window.agentOS?.workspaces?.switch(name)
    // On success App's onAction('switch') closes this + swaps the canvas; only handle failure here.
    if (!r || !r.ok) {
      setError((r && r.error) || 'could not switch')
      setBusy(null)
    }
  }

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
    await open(r.name || name) // create-then-switch: one user action, two auditable endpoints
  }

  return (
    <div className="overlay" onPointerDown={onClose}>
      <div className="panel ws-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h3>Workspaces</h3>
          <button className="panel-x" onClick={onClose}>
            ×
          </button>
        </div>

        {list === null ? (
          <p className="panel-help">Loading workspaces…</p>
        ) : list.length === 0 ? (
          <p className="panel-help">No workspaces yet — create your first one below.</p>
        ) : (
          <div className="ws-list">
            {list.map((w) => {
              const isActive = w.name === active
              const isBusy = busy === w.name
              return (
                <button
                  key={w.name}
                  className={`ws-row${isActive ? ' ws-row-active' : ''}`}
                  disabled={isActive || !!busy}
                  onClick={() => open(w.name)}
                >
                  <span className={`ws-dot${isActive ? ' on' : ''}`} />
                  <span className="ws-name">{w.name}</span>
                  <span className="ws-meta">
                    {isBusy
                      ? 'switching…'
                      : isActive
                        ? 'current'
                        : `${w.nodeCount} window${w.nodeCount === 1 ? '' : 's'}${w.updatedAt ? ` · ${relTime(w.updatedAt)}` : ''}`}
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {error && <div className="panel-error">{error}</div>}

        <div className="ws-new">
          <input
            ref={inputRef}
            className="ws-input"
            placeholder="New workspace name"
            value={newName}
            maxLength={64}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
          />
          <button className="primary" disabled={!newName.trim() || !!busy} onClick={() => void create()}>
            {busy === 'create' ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
