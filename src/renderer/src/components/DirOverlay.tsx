import { useEffect, useState } from 'react'
import { useDesktop } from '../store'

// Browse a real subfolder's contents (#44): opened by double-clicking a `dir` tile. Lists the
// folder's entries (image thumbs / typed glyphs), drills into subfolders, closes on backdrop click.
// Plain folders stay collapsed on the canvas (so a cloned repo is one tile, not thousands of nodes);
// this overlay is how you look inside.

interface Entry {
  name: string
  dir: boolean
  ext: string
  size: number
  isImage: boolean
  path: string
}

function fmtBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function DirOverlay({ path }: { path: string }): JSX.Element {
  const setOpenDirPath = useDesktop((s) => s.setOpenDirPath)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(false)
    fetch(`/api/os/dir?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return
        if (Array.isArray(d.entries)) setEntries(d.entries)
        else setError(true)
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
  const name = segs[segs.length - 1] || 'folder'

  return (
    <div className="dir-overlay" onPointerDown={() => setOpenDirPath(null)}>
      <div className="dir-overlay-card" onPointerDown={(e) => e.stopPropagation()}>
        <div className="dir-overlay-head">
          {segs.length > 1 && (
            <button className="btn ghost" title="Up" onClick={() => setOpenDirPath(segs.slice(0, -1).join('/'))}>
              ↑
            </button>
          )}
          <span className="dir-overlay-title">{name}</span>
          <span className="dir-overlay-count">
            {entries.length} item{entries.length === 1 ? '' : 's'}
          </span>
          <button className="btn ghost" onClick={() => setOpenDirPath(null)}>
            Close
          </button>
        </div>
        <div className="dir-overlay-grid">
          {loading && <div className="dir-overlay-empty">Loading…</div>}
          {!loading && error && <div className="dir-overlay-empty">Could not read this folder.</div>}
          {!loading && !error && entries.length === 0 && <div className="dir-overlay-empty">Empty folder.</div>}
          {entries.map((e) => (
            <div
              key={e.path}
              className="dir-entry"
              title={e.name}
              onDoubleClick={() => {
                if (e.dir) setOpenDirPath(e.path)
              }}
            >
              <div className="dir-entry-icon">
                {e.dir ? (
                  <div className="dir-entry-folder" />
                ) : e.isImage ? (
                  <img src={`/api/os/file?path=${encodeURIComponent(e.path)}&v=${e.size}`} alt={e.name} draggable={false} />
                ) : (
                  <span className="dir-entry-ext">{(e.ext || 'file').toUpperCase()}</span>
                )}
              </div>
              <div className="dir-entry-name">{e.name}</div>
              <div className="dir-entry-meta">{e.dir ? 'Folder' : fmtBytes(e.size)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
