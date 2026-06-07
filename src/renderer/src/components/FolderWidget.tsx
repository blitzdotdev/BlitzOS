import { useRef } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'
import { SurfacePreview } from './SurfacePreview'

interface Props {
  surface: Surface
  onDragDown: (e: React.PointerEvent) => void
  onDragMove: (e: React.PointerEvent) => void
  onDragUp: (e: React.PointerEvent) => void
}

/**
 * Closed iPhone-style folder tile: a glass rounded rect holding a 3x3 grid of
 * miniature LIVE previews. Tap opens it (props.open); drag moves the folder.
 */
export function FolderWidget({ surface, onDragDown, onDragMove, onDragUp }: Props): JSX.Element {
  const memberIds = (surface.props?.members as string[]) ?? []
  const members = useDesktop((s) => s.surfaces).filter((w) => memberIds.includes(w.id))
  const update = useDesktop((s) => s.updateSurfaceProps)
  const start = useRef({ x: 0, y: 0 })

  function down(e: React.PointerEvent): void {
    start.current = { x: e.clientX, y: e.clientY }
    onDragDown(e)
  }
  function up(e: React.PointerEvent): void {
    onDragUp(e)
    const moved = Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 5
    if (!moved) update(surface.id, { open: true }) // tap (not drag) opens
  }

  const slots = members.slice(0, 9)
  return (
    <div className="folder-tile" onPointerDown={down} onPointerMove={onDragMove} onPointerUp={up}>
      <div className="folder-grid">
        {slots.map((m) => (
          <SurfacePreview key={m.id} surface={m} box={52} />
        ))}
      </div>
      <div className="folder-label">
        {members.length} item{members.length === 1 ? '' : 's'}
      </div>
    </div>
  )
}
