import { useState } from 'react'
import { Surface } from '../types'

// A real file in the workspace folder, shown as a canvas tile (#37): image preview for images,
// otherwise a typed glyph + name + size. Image bytes come over the jailed file route (server) or
// the blitz-file:// protocol (Electron). A folder (`dir`) is a collapsed tile with its entry count.

function fmtBytes(n: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function fileUrl(path: string): string | null {
  if (!path) return null
  const api = window.agentOS as { serverMode?: boolean } | undefined
  if (api?.serverMode) return `/api/os/file?path=${encodeURIComponent(path)}`
  return `blitz-file://w/${encodeURIComponent(path)}` // Electron protocol (registered in main)
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
  const src = p.isImage && !imgErr ? fileUrl(String(p.path || '')) : null
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

export function DirWidget({ surface }: { surface: Surface }): JSX.Element {
  const p = (surface.props ?? {}) as { name?: string; entries?: number }
  const name = String(p.name || surface.title || 'folder')
  const n = Number(p.entries || 0)
  return (
    <div className="dir-tile">
      <div className="dir-icon" />
      <div className="file-name" title={name}>
        {name}
      </div>
      <div className="file-meta">
        {n} item{n === 1 ? '' : 's'}
      </div>
    </div>
  )
}
