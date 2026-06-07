import { useDesktop, primaryRect, areaRect } from '../store'

/** The workspace areas (each = an on-screen desktop region), framed in control mode's bird's-eye.
 *  Single area → one frame labelled PRIMARY (byte-identical to before). Multiple areas (#45) → one
 *  frame per area, tiled left→right, labelled AREA 1..n with the current one highlighted. */
export function PrimarySpace(): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const areaCount = useDesktop((s) => s.areaCount)
  const currentArea = useDesktop((s) => s.currentArea)
  if (areaCount <= 1) {
    const r = primaryRect(vp)
    return (
      <div className="primary-space" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
        <span className="primary-label">PRIMARY</span>
      </div>
    )
  }
  return (
    <>
      {Array.from({ length: areaCount }, (_, i) => {
        const r = areaRect(i, vp)
        return (
          <div
            key={i}
            className={`primary-space${i === currentArea ? ' is-current' : ''}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
          >
            <span className="primary-label">AREA {i + 1}</span>
          </div>
        )
      })}
    </>
  )
}
