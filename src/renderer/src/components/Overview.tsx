import { useCallback, useEffect, useRef, useState } from 'react'
import { IconCheck, IconClose, IconMoon, IconPlus, IconSettings, IconSun } from './Icons'

// Mission Control overview: up to six workspace previews in a 3x2 grid, plus an in-grid placeholder
// for creating the next workspace when there is room.

interface WorkspaceEntry {
  name: string
  nodeCount: number
  updatedAt: number
  thumbTs: number
}

interface Props {
  onClose: () => void
  theme: 'light' | 'dark'
  onThemeChange: (theme: 'light' | 'dark') => void
  // App captures the CURRENT board's snapshot, then switches — so the board you leave gets a fresh tile.
  // Resolves {ok:true} on success (the overview is then unmounted by the broadcast), or {ok:false,error}
  // on failure (409 lock / 404 / 500) so we clear the busy state + show the error instead of hanging.
  onSwitch: (name: string) => Promise<{ ok: boolean; error?: string }>
}

const MAX_PREVIEW_CELLS = 6

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

export function Overview({ onClose, onSwitch, theme, onThemeChange }: Props): JSX.Element {
  const [list, setList] = useState<WorkspaceEntry[] | null>(null)
  const [active, setActive] = useState('')
  const [newName, setNewName] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // the name being switched to, or 'create'
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [failed, setFailed] = useState<Set<string>>(new Set()) // workspaces whose thumb img failed to load
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null) // workspace name pending delete confirmation
  const createInputRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    if (!createOpen) return
    const t = window.setTimeout(() => createInputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [createOpen])

  const canShowCreateTile = (list?.length ?? MAX_PREVIEW_CELLS) < MAX_PREVIEW_CELLS
  const visibleWorkspaces = list?.slice(0, canShowCreateTile ? MAX_PREVIEW_CELLS - 1 : MAX_PREVIEW_CELLS) ?? []

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
    setCreateOpen(false)
    setBusy(r.name || name)
    const sw = await onSwitch(r.name || name) // create-then-switch
    if (!sw.ok) {
      setError(sw.error || 'created it, but could not open it')
      setBusy(null)
    }
  }

  function cancelCreate(): void {
    if (busy === 'create') return
    setNewName('')
    setCreateOpen(false)
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
      <div
        className="ovr-scroll"
        onPointerDown={(e) => {
          e.stopPropagation()
          setSettingsOpen(false)
        }}
      >
        <div className="ovr-head">
          <h2>Workspaces</h2>
          <span className="ovr-settings-wrap" onPointerDown={(e) => e.stopPropagation()}>
            <button
              className={`ovr-settings-btn${settingsOpen ? ' active' : ''}`}
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              aria-label="Settings"
              title="Settings"
            >
              <IconSettings size={19} />
            </button>
            {settingsOpen && (
              <div className="ovr-settings-popover" onPointerDown={(e) => e.stopPropagation()}>
                <div className="ovr-settings-title">Appearance</div>
                <button
                  className={`ovr-theme-option${theme === 'light' ? ' active' : ''}`}
                  type="button"
                  onClick={() => {
                    onThemeChange('light')
                    setSettingsOpen(false)
                  }}
                >
                  <IconSun size={16} />
                  Light
                </button>
                <button
                  className={`ovr-theme-option${theme === 'dark' ? ' active' : ''}`}
                  type="button"
                  onClick={() => {
                    onThemeChange('dark')
                    setSettingsOpen(false)
                  }}
                >
                  <IconMoon size={16} />
                  Dark
                </button>
              </div>
            )}
          </span>
        </div>

        {error && <div className="panel-error ovr-error">{error}</div>}

        <div className="ovr-content">
          {list === null ? (
            <p className="panel-help">Loading workspaces…</p>
          ) : (
            <div className="ovr-grid">
              {visibleWorkspaces.map((w) => {
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
              {canShowCreateTile && (
                <div className="ovr-cell ovr-create-cell" onPointerDown={(e) => e.stopPropagation()}>
                  {createOpen ? (
                    <form
                      className="ovr-create-form"
                      onSubmit={(e) => {
                        e.preventDefault()
                        void create()
                      }}
                    >
                      <div className="ovr-create-thumb">
                        <input ref={createInputRef} className="ovr-create-input" placeholder="Workspace name" value={newName} maxLength={64} onChange={(e) => setNewName(e.target.value)} />
                        <div className="ovr-create-actions">
                          <button className="ovr-create-action ok" type="submit" disabled={!newName.trim() || !!busy} aria-label="Create workspace" title="Create workspace">
                            <IconCheck size={18} />
                          </button>
                          <button className="ovr-create-action cancel" type="button" disabled={busy === 'create'} onClick={cancelCreate} aria-label="Cancel" title="Cancel">
                            <IconClose size={17} />
                          </button>
                        </div>
                      </div>
                      <div className="ovr-meta">
                        <span className="ovr-dot ovr-add-dot" />
                        <span className="ovr-name">New workspace</span>
                      </div>
                    </form>
                  ) : (
                    <button
                      className="ovr-add-tile"
                      onClick={() => {
                        setError(null)
                        setSettingsOpen(false)
                        setCreateOpen(true)
                      }}
                      disabled={!!busy}
                      aria-label="New workspace"
                      title="New workspace"
                    >
                      <div className="ovr-add-thumb">
                        <IconPlus size={26} />
                      </div>
                      <div className="ovr-meta">
                        <span className="ovr-dot ovr-add-dot" />
                        <span className="ovr-name">New workspace</span>
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
