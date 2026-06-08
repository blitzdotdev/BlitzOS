import { useEffect, useState } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'
import { fileUrl } from './FileWidget'

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
  isImage: boolean
  path: string
}
interface AgentOSFiles {
  listDir?: (path: string) => Promise<{ entries: Entry[]; total: number; truncated: boolean } | null>
}

function fmtBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function FileManager({ surface }: { surface: Surface }): JSX.Element {
  const path = String((surface.props?.path as string) ?? '')
  const updateSurfaceProps = useDesktop((s) => s.updateSurfaceProps)
  const updateSurface = useDesktop((s) => s.updateSurface)
  const createSurface = useDesktop((s) => s.createSurface)
  const [entries, setEntries] = useState<Entry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(false)
    const api = window.agentOS as AgentOSFiles | undefined
    const p = api?.listDir ? api.listDir(path) : fetch(`/api/os/dir?path=${encodeURIComponent(path)}`).then((r) => r.json())
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
  }, [path])

  const segs = path.split('/').filter(Boolean)
  function go(p: string): void {
    updateSurfaceProps(surface.id, { path: p })
    updateSurface(surface.id, { title: p.split('/').filter(Boolean).pop() || 'Files' })
  }
  function open(e: Entry): void {
    if (e.dir) {
      go(e.path) // drill into the subfolder, in place
      return
    }
    // open the file onto the canvas as a file tile (transient for a subdir file — a viewing convenience)
    createSurface({ kind: 'native', component: 'file', title: e.name, w: 220, h: 210, props: { name: e.name, path: e.path, ext: e.ext, isImage: e.isImage, bytes: e.size } })
  }

  return (
    <div className="fm">
      <div className="fm-head">
        {segs.length > 0 && (
          <button className="fm-up" title="Up" onClick={() => go(segs.slice(0, -1).join('/'))}>
            ↑
          </button>
        )}
        <span className="fm-path" title={path || 'Files'}>
          {segs.length ? segs.join(' / ') : 'Files'}
        </span>
        <span className="fm-count">{truncated ? `${entries.length} of ${total}` : `${entries.length} item${entries.length === 1 ? '' : 's'}`}</span>
      </div>
      <div className="fm-grid">
        {loading && <div className="fm-empty">Loading…</div>}
        {!loading && error && <div className="fm-empty">Could not read this folder.</div>}
        {!loading && !error && entries.length === 0 && <div className="fm-empty">Empty folder.</div>}
        {entries.map((e) => (
          <div key={e.path} className="fm-entry" title={e.name} onDoubleClick={() => open(e)}>
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
            <div className="fm-meta">{e.dir ? 'Folder' : fmtBytes(e.size)}</div>
          </div>
        ))}
        {truncated && <div className="fm-empty">Showing the first {entries.length} of {total} items.</div>}
      </div>
    </div>
  )
}
