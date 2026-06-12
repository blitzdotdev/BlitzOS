import { useDesktop, primaryRect, areaRect } from '../store'

type PrimarySpaceProps = {
  showAddArea?: boolean
}

type AreaChromeOverlayProps = {
  showAddArea?: boolean
  onEnterArea?: (area: number) => void
  onAddArea?: () => void
}

/** The workspace areas (each = an on-screen desktop region), framed in control mode or normal zoom-out.
 *  Single area → one frame. Multiple areas (#45) → one frame per area, tiled left→right. */
export function PrimarySpace({ showAddArea = false }: PrimarySpaceProps): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const areaCount = useDesktop((s) => s.areaCount)
  const currentArea = useDesktop((s) => s.currentArea)

  const renderArea = (i: number): JSX.Element => {
    const r = i === 0 ? primaryRect(vp) : areaRect(i, vp)
    return (
      <div
        key={i}
        className={`primary-space${i === currentArea ? ' is-current' : ''}`}
        style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      />
    )
  }

  const renderAddArea = (): JSX.Element | null => {
    if (!showAddArea) return null
    const r = areaRect(areaCount, vp)
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
      {Array.from({ length: areaCount }, (_, i) => renderArea(i))}
      {renderAddArea()}
    </>
  )
}

export function AreaChromeOverlay({ showAddArea = false, onEnterArea, onAddArea }: AreaChromeOverlayProps): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const areaCount = useDesktop((s) => s.areaCount)
  const currentArea = useDesktop((s) => s.currentArea)
  const transform = useDesktop((s) => s.transform)

  const screenRect = (area: number): { left: number; top: number; width: number; height: number } => {
    const r = area === 0 ? primaryRect(vp) : areaRect(area, vp)
    return {
      left: transform.x + r.x * transform.scale,
      top: transform.y + r.y * transform.scale,
      width: r.w * transform.scale,
      height: r.h * transform.scale
    }
  }
  const addRect = showAddArea ? screenRect(areaCount) : null

  return (
    <div className="area-chrome-overlay">
      {Array.from({ length: areaCount }, (_, i) => {
        const r = screenRect(i)
        return (
          <button
            key={i}
            className={`area-chrome-label${i === currentArea ? ' is-current' : ''}`}
            type="button"
            style={{ left: r.left + 24, top: r.top - 10 }}
            onClick={() => onEnterArea?.(i)}
          >
            Area {i + 1}
          </button>
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
          Create new area
        </button>
      )}
    </div>
  )
}
