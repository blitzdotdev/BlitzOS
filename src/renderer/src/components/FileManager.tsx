import { useEffect, useState } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'
import { fileUrl } from './FileWidget'

const FOLDER_ENTRY_MIME = 'application/x-blitz-folder-entry'

// The file manager for a normal folder (#44/#60). A BUILT-IN native component (component:'files') rendered
// inside a real movable/resizable window — NOT a srcdoc widget — because it represents ANY folder and there
// are many instances (one per opened folder). Double-clicking a dir tile spawns/focuses one of these. It
// lists via window.agentOS.listDir (Electron os:dir IPC / server /api/os/dir; jailed, 1000-capped), drills
// into subfolders + up + breadcrumb by re-pointing its own props.path, and opens a file onto the canvas.

interface Entry {
  name: string
  dir: boolean
  ext: string
  size: number
  entries?: number
  isImage: boolean
  path: string
}
interface AgentOSFiles {
  listDir?: (path: string) => Promise<{ entries: Entry[]; total: number; truncated: boolean } | null>
  openFolderEntry?: (path: string, x?: number, y?: number) => Promise<{ ok: boolean; id?: string; surface?: Surface; error?: string }>
}

function fmtBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function FileManager({ surface }: { surface: Surface }): JSX.Element {
  const cleanPath = (p: unknown): string => String(p ?? '').replace(/^[/\\]+|[/\\]+$/g, '').split('\\').join('/')
  const path = cleanPath(surface.props?.path)
  const rootPath = cleanPath(surface.props?.rootPath || path)
  const isWithinRoot = (p: string): boolean => !rootPath || p === rootPath || p.startsWith(`${rootPath}/`)
  const boundedPath = isWithinRoot(path) ? path : rootPath
  const updateSurfaceProps = useDesktop((s) => s.updateSurfaceProps)
  const updateSurface = useDesktop((s) => s.updateSurface)
  const createSurface = useDesktop((s) => s.createSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const [entries, setEntries] = useState<Entry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(false)
    const api = window.agentOS as AgentOSFiles | undefined
    const p = api?.listDir ? api.listDir(boundedPath) : fetch(`/api/os/dir?path=${encodeURIComponent(boundedPath)}`).then((r) => r.json())
    Promise.resolve(p)
      .then((d) => {
        if (!alive) return
        if (d && Array.isArray(d.entries)) {
          setEntries(d.entries)
          setTruncated(!!d.truncated)
          setTotal(Number(d.total) || d.entries.length)
        } else setError(true)
        setLoading(false)
      })
      .catch(() => {
        if (alive) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [boundedPath, refreshTick])

  useEffect(() => {
    const onMoved = (): void => setRefreshTick((n) => n + 1)
    window.addEventListener('blitz-folder-entry-moved', onMoved)
    return () => window.removeEventListener('blitz-folder-entry-moved', onMoved)
  }, [])

  const segs = boundedPath.split('/').filter(Boolean)
  const canGoUp = !!rootPath && boundedPath !== rootPath && boundedPath.startsWith(`${rootPath}/`)
  function go(p: string): void {
    const next = cleanPath(p)
    if (!isWithinRoot(next)) return
    updateSurfaceProps(surface.id, { path: next, rootPath })
    updateSurface(surface.id, { title: next.split('/').filter(Boolean).pop() || 'Files' })
  }
  function goUp(): void {
    const parent = boundedPath.split('/').slice(0, -1).join('/')
    go(parent && isWithinRoot(parent) ? parent : rootPath)
  }
  function onEntryDragStart(ev: React.DragEvent<HTMLDivElement>, e: Entry): void {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData(FOLDER_ENTRY_MIME, JSON.stringify({ paths: [e.path] }))
    ev.dataTransfer.setData('text/plain', e.name)
  }
  function open(e: Entry): void {
    if (e.dir) {
      go(e.path) // drill into the subfolder, in place
      return
    }
    const existing = useDesktop.getState().surfaces.find((s) => s.props?.path === e.path)
    if (existing) {
      focusSurface(existing.id)
      return
    }
    const cx = surface.x + surface.w + 140
    const cy = surface.y + 120
    const api = window.agentOS as AgentOSFiles | undefined
    const blitzOwned = ['md', 'weblink', 'html', 'jsx', 'tsx'].includes(String(e.ext || '').toLowerCase())
    const openGenericFile = (): void => {
      createSurface({ kind: 'native', component: 'file', title: e.name, w: 220, h: 210, props: { name: e.name, path: e.path, ext: e.ext, isImage: e.isImage, bytes: e.size } })
    }
    if (api?.openFolderEntry) {
      void api.openFolderEntry(e.path, cx, cy).then((r) => {
        if (r?.id) {
          window.setTimeout(() => {
            const adopted = useDesktop.getState().surfaces.some((s) => s.id === r.id)
            if (!adopted && r.surface) createSurface(r.surface)
            focusSurface(r.id!)
          }, 0)
        } else if (!blitzOwned) {
          openGenericFile()
        }
      }).catch(() => {
        if (!blitzOwned) openGenericFile()
      })
      return
    }
    if (!blitzOwned) openGenericFile()
  }

  return (
    <div
      className="fm"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes(FOLDER_ENTRY_MIME)) {
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={(e) => {
        if (Array.from(e.dataTransfer.types).includes(FOLDER_ENTRY_MIME)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      <div className="fm-head">
        {canGoUp && (
          <button className="fm-up" title="Parent folder" aria-label="Parent folder" onClick={goUp}>
            ‹
          </button>
        )}
        <span className="fm-path" title={boundedPath || 'Files'}>
          {segs.length ? segs.join(' / ') : 'Files'}
        </span>
        <span className="fm-count">{truncated ? `${entries.length} of ${total}` : `${entries.length} item${entries.length === 1 ? '' : 's'}`}</span>
      </div>
      <div className="fm-grid">
        {loading && <div className="fm-empty">Loading…</div>}
        {!loading && error && <div className="fm-empty">Could not read this folder.</div>}
        {!loading && !error && entries.length === 0 && <div className="fm-empty">Empty folder.</div>}
        {entries.map((e) => (
          <div key={e.path} className="fm-entry" title={e.name} draggable onDragStart={(ev) => onEntryDragStart(ev, e)} onDoubleClick={() => open(e)}>
            <div className="fm-icon">
              {e.dir ? (
                <div className="fm-folder" />
              ) : e.isImage && fileUrl(e.path) ? (
                <img src={`${fileUrl(e.path)}${fileUrl(e.path)!.includes('?') ? '&' : '?'}v=${e.size}`} alt={e.name} draggable={false} />
              ) : (
                <span className="fm-ext">{(e.ext || 'file').toUpperCase()}</span>
              )}
            </div>
            <div className="fm-name">{e.name}</div>
            <div className="fm-meta">{e.dir ? `${Number(e.entries || 0)} item${Number(e.entries || 0) === 1 ? '' : 's'}` : fmtBytes(e.size)}</div>
          </div>
        ))}
        {truncated && <div className="fm-empty">Showing the first {entries.length} of {total} items.</div>}
      </div>
    </div>
  )
}
