import { useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'

// A real file in the workspace folder, shown as a canvas tile (#37): image preview for images,
// otherwise a typed glyph + name + size. Image bytes come over the jailed file route (server) or
// the blitz-file:// protocol (Electron). A folder (`dir`) is a collapsed tile with its entry count.

function fmtBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function fileUrl(path: string): string | null {
  if (!path) return null
  const api = window.agentOS as { serverMode?: boolean } | undefined
  if (api?.serverMode) return `/api/os/file?path=${encodeURIComponent(path)}`
  // Electron: served by the registered blitz-file:// protocol (jailed to the active workspace — see
  // index.ts + osReadWorkspaceFile). If it ever fails, the tile falls back to the typed glyph via onError.
  return `blitz-file://w/${encodeURIComponent(path)}`
}

function cleanFolderPath(path: unknown): string {
  return String(path ?? '').replace(/^[/\\]+|[/\\]+$/g, '').split('\\').join('/')
}

// A short, uppercase label per file type for the glyph (the design system avoids emoji as chrome).
const TYPE_LABEL: Record<string, string> = {
  pdf: 'PDF', zip: 'ZIP', gz: 'GZ', tar: 'TAR', rar: 'RAR',
  doc: 'DOC', docx: 'DOC', xls: 'XLS', xlsx: 'XLS', ppt: 'PPT', pptx: 'PPT',
  mp4: 'VIDEO', mov: 'VIDEO', webm: 'VIDEO', mp3: 'AUDIO', wav: 'AUDIO',
  js: 'JS', ts: 'TS', tsx: 'TSX', py: 'PY', go: 'GO', rs: 'RS',
  json: 'JSON', csv: 'CSV', txt: 'TXT', md: 'MD'
}

export function FileWidget({ surface }: { surface: Surface }): JSX.Element {
  const p = (surface.props ?? {}) as { name?: string; ext?: string; isImage?: boolean; bytes?: number; path?: string }
  const [imgErr, setImgErr] = useState(false)
  const name = String(p.name || surface.title || 'file')
  const ext = String(p.ext || '')
  const path = String(p.path || '')
  const bytes = Number(p.bytes || 0)
  useEffect(() => setImgErr(false), [path, bytes]) // a changed file (new byte count) should retry the preview
  const baseUrl = p.isImage ? fileUrl(path) : null
  // cache-buster keyed on size so an edited-in-place image (same name) refreshes instead of showing stale bytes
  const src = baseUrl && !imgErr ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}v=${bytes}` : null
  return (
    <div className="file-tile">
      <div className="file-icon">
        {src ? (
          <img className="file-thumb" src={src} alt={name} draggable={false} onError={() => setImgErr(true)} />
        ) : (
          <span className="file-ext">{TYPE_LABEL[ext.toLowerCase()] || ext.toUpperCase() || 'FILE'}</span>
        )}
      </div>
      <div className="file-name" title={name}>
        {name}
      </div>
      <div className="file-meta">{[ext.toUpperCase(), fmtBytes(Number(p.bytes || 0))].filter(Boolean).join(' · ')}</div>
    </div>
  )
}

interface DirWidgetProps {
  surface: Surface
  renaming?: boolean
  onRenameDone?: () => void
  onOpenMenu?: (x: number, y: number) => void
  onDragDown?: (e: React.PointerEvent) => void
  onDragMove?: (e: React.PointerEvent) => void
  onDragUp?: (e: React.PointerEvent) => void
}

export function DirWidget({ surface, renaming = false, onRenameDone, onOpenMenu, onDragDown, onDragMove, onDragUp }: DirWidgetProps): JSX.Element {
  const p = (surface.props ?? {}) as { name?: string; entries?: number; path?: string }
  const createSurface = useDesktop((s) => s.createSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const setSelection = useDesktop((s) => s.setSelection)
  const updateSurface = useDesktop((s) => s.updateSurface)
  const updateSurfaceProps = useDesktop((s) => s.updateSurfaceProps)
  const name = String(p.name || surface.title || 'folder')
  const path = String(p.path || p.name || '')
  const n = Number(p.entries || 0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const start = useRef({ x: 0, y: 0 })
  const finalizing = useRef(false)

  useEffect(() => setDraft(name), [name])
  useEffect(() => {
    if (renaming) {
      setEditing(true)
      setDraft(name)
    }
  }, [renaming, name])
  useEffect(() => {
    if (!editing) return
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [editing])

  function patchOpenFileManagers(oldPath: string, nextPath: string): void {
    const oldPrefix = `${oldPath}/`
    const nextPrefix = `${nextPath}/`
    for (const s of useDesktop.getState().surfaces) {
      if (!(s.kind === 'native' && s.component === 'files')) continue
      const cur = String(s.props?.path || '')
      const curRoot = String(s.props?.rootPath || '')
      const path = cur === oldPath ? nextPath : cur.startsWith(oldPrefix) ? nextPrefix + cur.slice(oldPrefix.length) : cur
      const rootPath = curRoot === oldPath ? nextPath : curRoot.startsWith(oldPrefix) ? nextPrefix + curRoot.slice(oldPrefix.length) : curRoot
      if (path !== cur || rootPath !== curRoot) {
        updateSurfaceProps(s.id, { path, rootPath })
        updateSurface(s.id, { title: path.split('/').filter(Boolean).pop() || 'Files' })
      }
    }
  }

  function releaseFinalizing(): void {
    window.setTimeout(() => {
      finalizing.current = false
    }, 0)
  }

  async function commitRename(): Promise<void> {
    if (finalizing.current) return
    finalizing.current = true
    const next = draft.trim()
    try {
      if (!next || next === name) return
      const oldPath = path
      const res = await window.agentOS?.renameFolder?.(oldPath, next)
      if (res?.ok && res.path) {
        const nextName = res.path.split('/').filter(Boolean).pop() || next
        updateSurface(surface.id, { title: nextName, props: { path: res.path, name: nextName } })
        patchOpenFileManagers(oldPath, res.path)
        setDraft(nextName)
      } else {
        setDraft(name)
      }
    } catch {
      setDraft(name)
    } finally {
      setEditing(false)
      onRenameDone?.()
      releaseFinalizing()
    }
  }

  function cancelRename(): void {
    if (finalizing.current) return
    finalizing.current = true
    setDraft(name)
    setEditing(false)
    onRenameDone?.()
    releaseFinalizing()
  }

  function down(e: React.PointerEvent): void {
    if (e.button === 0) {
      const st = useDesktop.getState()
      if (!(st.selection.length > 1 && st.selection.includes(surface.id))) setSelection([surface.id])
    }
    start.current = { x: e.clientX, y: e.clientY }
    onDragDown?.(e)
  }

  function up(e: React.PointerEvent): void {
    onDragUp?.(e)
    const moved = Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 5
    if (!moved) focusSurface(surface.id)
  }

  // Open a movable file-manager WINDOW for this folder (one instance per folder; focus an already-open one).
  function open(): void {
    if (!path) return
    const existing = useDesktop.getState().surfaces.find((s) => {
      if (!(s.kind === 'native' && s.component === 'files')) return false
      return cleanFolderPath(s.props?.rootPath || s.props?.path) === path
    })
    if (existing) {
      updateSurface(existing.id, { minimized: false })
      focusSurface(existing.id)
    } else {
      createSurface({ kind: 'native', component: 'files', title: name, w: 560, h: 440, props: { path, rootPath: path } })
    }
  }
  return (
    <div
      className="dir-tile"
      title="Double-click to open"
      onDoubleClick={() => {
        if (!editing) open()
      }}
      onPointerDown={(e) => {
        if (editing) return
        if (e.button !== 0) {
          e.stopPropagation()
          return
        }
        down(e)
      }}
      onPointerMove={onDragMove}
      onPointerUp={(e) => {
        if (editing) return
        if (e.button !== 0) return
        up(e)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        focusSurface(surface.id)
        setSelection([surface.id])
        onOpenMenu?.(e.clientX, e.clientY)
      }}
    >
      <div className="dir-icon" />
      {editing ? (
        <input
          ref={inputRef}
          className="file-name dir-rename"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitRename()}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commitRename()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelRename()
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="file-name dir-name-button"
          title={name}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
        >
          {name}
        </button>
      )}
      <div className="file-meta">
        {n} item{n === 1 ? '' : 's'}
      </div>
    </div>
  )
}
