import { Surface } from '../types'
import { useDesktop } from '../store'

/** A usable post-it: type in it, the text persists in the surface's props. */
export function NoteWidget({ surface }: { surface: Surface }): JSX.Element {
  const update = useDesktop((s) => s.updateSurfaceProps)
  const setEditingId = useDesktop((s) => s.setEditingId)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const text = (surface.props?.text as string) ?? ''
  return (
    <textarea
      className="note-text"
      data-surface-scroll="true"
      value={text}
      placeholder="type a note…"
      spellCheck={false}
      onPointerDown={(e) => {
        e.stopPropagation()
        focusSurface(surface.id)
      }}
      onFocus={() => setEditingId(surface.id)}
      onBlur={() => {
        if (useDesktop.getState().editingId === surface.id) setEditingId(null)
      }}
      onChange={(e) => update(surface.id, { text: e.target.value })}
    />
  )
}
