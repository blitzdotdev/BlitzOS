import { useEffect, useState } from 'react'
import { useDesktop } from '../store'
import { fileUrl } from './FileWidget'

// The file manager for a NORMAL folder (#44): opened by double-clicking a `dir` tile. A normal folder
// holds FILES (it can hold thousands — it stays ONE collapsed tile on the canvas, never splayed; this
// overlay is how you look inside). Lists entries (image thumbs / typed glyphs), drills into subfolders.
// Works in BOTH modes via window.agentOS.listDir (Electron os:dir IPC / server /api/os/dir) — same
// jailed, 1000-capped listing. (A `.board` folder is the OTHER kind — its windows/widgets splay onto
// the canvas instead of opening here.)

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

export function DirOverlay({ path }: { path: string }): JSX.Element {
  const setOpenDirPath = useDesktop((s) => s.setOpenDirPath)
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
    // ONE listing path for both modes: Electron resolves os:dir over IPC; the server shim fetches
    // /api/os/dir. (No raw fetch here — that only worked in server mode and broke the Electron app.)
    const p = api?.listDir
      ? api.listDir(path)
      : fetch(`/api/os/dir?path=${encodeURIComponent(path)}`).then((r) => r.json())
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
            {truncated ? `${entries.length} of ${total}` : `${entries.length} item${entries.length === 1 ? '' : 's'}`}
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
                ) : e.isImage && fileUrl(e.path) ? (
                  <img src={`${fileUrl(e.path)}${fileUrl(e.path)!.includes('?') ? '&' : '?'}v=${e.size}`} alt={e.name} draggable={false} />
                ) : (
                  <span className="dir-entry-ext">{(e.ext || 'file').toUpperCase()}</span>
                )}
              </div>
              <div className="dir-entry-name">{e.name}</div>
              <div className="dir-entry-meta">{e.dir ? 'Folder' : fmtBytes(e.size)}</div>
            </div>
          ))}
          {truncated && <div className="dir-overlay-empty">Showing the first {entries.length} of {total} items.</div>}
        </div>
      </div>
    </div>
  )
}
