import type { CSSProperties } from 'react'
import { Surface } from '../types'
import { useDesktop, primaryRect, stageRect } from '../store'
import { holesPath, type HolesClip } from './SurfaceFrame'

type PrimarySpaceProps = {
  showAddArea?: boolean
}

type AreaChromeOverlayProps = {
  showAddArea?: boolean
  onEnterStage?: (stage: number) => void
  onAddArea?: () => void
}

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

const clipStyle = (clip: HolesClip): CSSProperties =>
  clip === 'HIDE' ? { visibility: 'hidden' } : clip ? { clipPath: clip } : {}

/** The workspace stages, framed in control mode or normal zoom-out. */
export function PrimarySpace({ showAddArea = false }: PrimarySpaceProps): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const stageCount = useDesktop((s) => s.stageCount)
  const currentStage = useDesktop((s) => s.currentStage)
  const surfaces = useDesktop((s) => s.surfaces)

  const renderStage = (i: number): JSX.Element => {
    const r = i === 0 ? primaryRect(vp) : stageRect(i, vp)
    const clip = sceneryClip(r, surfaces)
    return (
      <div
        key={i}
        className={`primary-space${i === currentStage ? ' is-current' : ''}`}
        style={{ left: r.x, top: r.y, width: r.w, height: r.h, ...clipStyle(clip) }}
      />
    )
  }

  const renderAddArea = (): JSX.Element | null => {
    if (!showAddArea) return null
    const r = stageRect(stageCount, vp)
    return (
      <div
        key="add-area"
        className="primary-space primary-space-add"
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      />
    )
  }

  return (
    <>
      {Array.from({ length: stageCount }, (_, i) => renderStage(i))}
      {renderAddArea()}
    </>
  )
}

export function AreaChromeOverlay({ showAddArea = false, onEnterStage, onAddArea }: AreaChromeOverlayProps): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const stageCount = useDesktop((s) => s.stageCount)
  const currentStage = useDesktop((s) => s.currentStage)
  const transform = useDesktop((s) => s.transform)

  const screenRect = (stage: number): { left: number; top: number; width: number; height: number } => {
    const r = stage === 0 ? primaryRect(vp) : stageRect(stage, vp)
    return {
      left: transform.x + r.x * transform.scale,
      top: transform.y + r.y * transform.scale,
      width: r.w * transform.scale,
      height: r.h * transform.scale
    }
  }
  const addRect = showAddArea ? screenRect(stageCount) : null

  return (
    <div className="area-chrome-overlay">
      {Array.from({ length: stageCount }, (_, i) => {
        const r = screenRect(i)
        return (
          <div key={i} className="area-chrome-stage">
            <button
              className="area-chrome-hit"
              type="button"
              aria-label={`Open Stage ${i + 1}`}
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
              onClick={() => onEnterStage?.(i)}
            />
            <button
              className={`area-chrome-label${i === currentStage ? ' is-current' : ''}`}
              type="button"
              style={{ left: r.left + 24, top: r.top - 10 }}
              onClick={() => onEnterStage?.(i)}
            >
              Stage {i + 1}
            </button>
          </div>
        )
      })}
      {addRect && (
        <button
          className="area-chrome-create"
          type="button"
          style={{
            left: addRect.left + addRect.width / 2,
            top: addRect.top + addRect.height / 2
          }}
          onClick={() => onAddArea?.()}
        >
          Create new stage
        </button>
      )}
    </div>
  )
}
