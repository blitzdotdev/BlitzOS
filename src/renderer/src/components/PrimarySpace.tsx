import type { CSSProperties } from 'react'
import { Surface } from '../types'
import { useDesktop, primaryRect, stageRect } from '../store'
import { holesPath, type HolesClip } from './SurfaceFrame'

// Sandwich compositor: the stage frame's translucent tint sits BELOW every window, so a browser's
// page hole must be cut out of it (a translucent DOM layer over a hole would wash the live page).
// Scenery is below ALL windows, so every visible web surface punches it. World coords, camera-free.
function sceneryClip(r: { x: number; y: number; w: number; h: number }, surfaces: Surface[]): HolesClip {
  const holes: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  for (const w of surfaces) {
    if (w.kind !== 'web' || w.minimized || (w.groupId && !w.peek)) continue
    const x1 = w.x - r.x
    const y1 = w.y - r.y
    const x2 = x1 + w.w
    const y2 = y1 + w.h
    if (x2 <= 0 || y2 <= 0 || x1 >= r.w || y1 >= r.h) continue
    holes.push({ x1, y1, x2, y2 })
  }
  return holesPath(r.w, r.h, holes, 14)
}

/** The workspace stages (each = an on-screen desktop region), framed in control mode's bird's-eye.
 *  Single stage → one frame labelled PRIMARY (byte-identical to before). Multiple stages (#45) → one
 *  frame per stage, tiled left→right, labelled AREA 1..n with the current one highlighted. */
export function PrimarySpace(): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const stageCount = useDesktop((s) => s.stageCount)
  const currentStage = useDesktop((s) => s.currentStage)
  const surfaces = useDesktop((s) => s.surfaces)
  const clipStyle = (clip: HolesClip): CSSProperties =>
    clip === 'HIDE' ? { visibility: 'hidden' } : clip ? { clipPath: clip } : {}
  if (stageCount <= 1) {
    const r = primaryRect(vp)
    const clip = sceneryClip(r, surfaces)
    return (
      <div className="primary-space" style={{ left: r.x, top: r.y, width: r.w, height: r.h, ...clipStyle(clip) }}>
        <span className="primary-label">PRIMARY</span>
      </div>
    )
  }
  return (
    <>
      {Array.from({ length: stageCount }, (_, i) => {
        const r = stageRect(i, vp)
        const clip = sceneryClip(r, surfaces)
        return (
          <div
            key={i}
            className={`primary-space${i === currentStage ? ' is-current' : ''}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h, ...clipStyle(clip) }}
          >
            <span className="primary-label">AREA {i + 1}</span>
          </div>
        )
      })}
    </>
  )
}
