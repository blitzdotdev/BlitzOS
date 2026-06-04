import { Surface } from '../types'
import { useDesktop } from '../store'

/** A usable post-it: type in it, the text persists in the surface's props. */
export function NoteWidget({ surface }: { surface: Surface }): JSX.Element {
  const update = useDesktop((s) => s.updateSurfaceProps)
  const text = (surface.props?.text as string) ?? ''
  return (
    <textarea
      className="note-text"
      value={text}
      placeholder="type a note…"
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => update(surface.id, { text: e.target.value })}
    />
  )
}
