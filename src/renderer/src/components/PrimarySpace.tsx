import { useDesktop, primaryRect, stageRect } from '../store'

/** The workspace stages (each = an on-screen desktop region), framed in control mode's bird's-eye.
 *  Single stage → one frame labelled PRIMARY (byte-identical to before). Multiple stages (#45) → one
 *  frame per stage, tiled left→right, labelled AREA 1..n with the current one highlighted. */
export function PrimarySpace(): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const stageCount = useDesktop((s) => s.stageCount)
  const currentStage = useDesktop((s) => s.currentStage)
  if (stageCount <= 1) {
    const r = primaryRect(vp)
    return (
      <div className="primary-space" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
        <span className="primary-label">PRIMARY</span>
      </div>
    )
  }
  return (
    <>
      {Array.from({ length: stageCount }, (_, i) => {
        const r = stageRect(i, vp)
        return (
          <div
            key={i}
            className={`primary-space${i === currentStage ? ' is-current' : ''}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
          >
            <span className="primary-label">AREA {i + 1}</span>
          </div>
        )
      })}
    </>
  )
}
