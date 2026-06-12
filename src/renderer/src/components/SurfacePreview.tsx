import { Surface } from '../types'
import { NoteWidget } from './NoteWidget'
import { ChatPanel } from './ChatPanel'
import { ActivityPanel } from './ActivityPanel'
import { paperFor } from '../paper'

/**
 * A scaled, non-interactive LIVE preview of a surface — the miniature inside an
 * iPhone-style folder. Every kind renders live:
 *   - native  → re-render the component from props
 *   - srcdoc  → re-mount the same html
 *   - app     → re-mount the same url (iframe)
 *   - web     → lightweight label; the live browser itself is a main-owned WebContentsView
 *               that cannot be duplicated inside this React preview.
 */
export function SurfacePreview({ surface, box }: { surface: Surface; box: number }): JSX.Element {
  const scale = Math.min(box / surface.w, box / surface.h)
  return (
    <div className="preview" style={{ width: box, height: box }}>
      <div className="preview-scale" style={{ width: surface.w, height: surface.h, transform: `scale(${scale})` }}>
        <PreviewBody surface={surface} />
      </div>
    </div>
  )
}

function PreviewBody({ surface }: { surface: Surface }): JSX.Element {
  const fill = { width: '100%', height: '100%', border: 'none', pointerEvents: 'none' } as const
  if (surface.kind === 'web') {
    let host = surface.url || surface.title
    try {
      host = new URL(surface.url || '').hostname || host
    } catch {
      /* keep host */
    }
    return (
      <div className="preview-web">
        <div className="preview-web-icon">⌁</div>
        <div className="preview-web-title">{surface.title || 'Web'}</div>
        <div className="preview-web-url">{host}</div>
      </div>
    )
  }
  if (surface.kind === 'app')
    return <iframe title={surface.title} src={surface.url} sandbox="allow-scripts allow-same-origin" style={{ ...fill, display: 'block', background: '#fff' }} />
  // System widgets (chat / customized note) preview their REAL content via the native renderer (which
  // reads props directly) — a bare srcdoc preview would have no bridge/kit injected and render blank.
  if (surface.role === 'chat') return <ChatPanel surface={surface} />
  if (surface.role === 'note') {
    const p = paperFor(surface.props?.color)
    return (
      <div style={{ width: '100%', height: '100%', background: p.bg, color: p.ink }}>
        <NoteWidget surface={surface} />
      </div>
    )
  }
  if (surface.kind === 'srcdoc')
    return <iframe title={surface.title} sandbox="allow-scripts" srcDoc={surface.html ?? ''} style={{ ...fill, display: 'block', background: 'var(--surface)' }} />
  if (surface.component === 'note') {
    const p = paperFor(surface.props?.color)
    return (
      <div style={{ width: '100%', height: '100%', background: p.bg, color: p.ink }}>
        <NoteWidget surface={surface} />
      </div>
    )
  }
  if (surface.component === 'chat') return <ChatPanel surface={surface} />
  if (surface.component === 'activity') return <ActivityPanel surface={surface} />
  return <div className="native-fallback">{surface.component}</div>
}
