import { useEffect, useRef, useState } from 'react'
import { Surface } from '../types'
import { useDesktop } from '../store'
import { SurfacePreview } from './SurfacePreview'
import { IconClose } from './Icons'

/**
 * Open iPhone-style folder: a full-screen frosted scrim + spring-expanded grid.
 *  - tap a member        → it opens on the desktop at its original spot; folder closes
 *  - drag a member out   → it drops onto the desktop where released (follows a ghost)
 *  - hover the top edge   → a liquid-glass × appears; click it → confirm → disband all
 *  - Esc                  → close the folder view (no ungroup)
 */
export function FolderOverlay({ folder }: { folder: Surface }): JSX.Element {
  const memberIds = (folder.props?.members as string[]) ?? []
  const members = useDesktop((s) => s.surfaces).filter((w) => memberIds.includes(w.id))
  const update = useDesktop((s) => s.updateSurfaceProps)
  const updateSurface = useDesktop((s) => s.updateSurface)
  const ungroupOne = useDesktop((s) => s.ungroupOne)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const focusSurface = useDesktop((s) => s.focusSurface)
  const close = (): void => update(folder.id, { open: false })

  const dragRef = useRef<{ id: string; sx: number; sy: number; moved: boolean } | null>(null)
  const [ghost, setGhost] = useState<{ id: string; x: number; y: number } | null>(null)
  const [nearTop, setNearTop] = useState(false)

  // Esc exits the folder view (without ungrouping).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // close is stable enough for this lifetime; folder.id is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.id])

  function disband(): void {
    // Confirm, then disband the whole folder: members return to their old spots.
    if (window.confirm('Ungroup this folder? The surfaces return to their original spots.')) {
      closeSurface(folder.id)
    }
  }

  function down(e: React.PointerEvent, id: string): void {
    e.stopPropagation()
    dragRef.current = { id, sx: e.clientX, sy: e.clientY, moved: false }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* ignore (synthetic events) */
    }
  }
  function move(e: React.PointerEvent): void {
    const d = dragRef.current
    if (!d) return
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) d.moved = true
    if (d.moved) setGhost({ id: d.id, x: e.clientX, y: e.clientY })
  }
  function up(e: React.PointerEvent, m: Surface): void {
    const d = dragRef.current
    dragRef.current = null
    setGhost(null)
    if (!d) return
    if (!d.moved) {
      // tap → open this surface on the desktop at its original spot, WITHOUT ungrouping it
      updateSurface(m.id, { peek: true })
      focusSurface(m.id)
      close()
      return
    }
    // drag-drop → place where released (screen → world), centered on the cursor
    const t = useDesktop.getState().transform
    const wx = (e.clientX - t.x) / t.scale
    const wy = (e.clientY - t.y) / t.scale
    ungroupOne(m.id, { x: Math.round(wx - m.w / 2), y: Math.round(wy - m.h / 2) })
    focusSurface(m.id)
    close()
  }

  const dragged = ghost ? members.find((m) => m.id === ghost.id) : null

  return (
    <div className="folder-overlay" onPointerDown={close}>
      <div
        className="folder-open"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerMove={(e) => setNearTop(e.clientY - e.currentTarget.getBoundingClientRect().top < 64)}
        onPointerLeave={() => setNearTop(false)}
      >
        <button className={`folder-open-x${nearTop ? ' show' : ''}`} title="Ungroup folder" onClick={disband}>
          <IconClose size={15} />
        </button>
        <div className="folder-open-grid">
          {members.map((m) => (
            <button
              key={m.id}
              className={`folder-open-item${ghost?.id === m.id ? ' dragging' : ''}`}
              title={m.title}
              onPointerDown={(e) => down(e, m.id)}
              onPointerMove={move}
              onPointerUp={(e) => up(e, m)}
            >
              <SurfacePreview surface={m} box={156} />
              <span className="folder-open-cap">{m.title}</span>
            </button>
          ))}
        </div>
      </div>
      {dragged && ghost && (
        <div className="folder-ghost" style={{ left: ghost.x, top: ghost.y }}>
          <SurfacePreview surface={dragged} box={140} />
        </div>
      )}
    </div>
  )
}
