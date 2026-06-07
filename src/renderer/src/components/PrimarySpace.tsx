import { useDesktop, primaryRect } from '../store'

/** The primary workspace area (= the on-screen desktop region), framed in control mode's bird's-eye. */
export function PrimarySpace(): JSX.Element {
  const vp = useDesktop((s) => s.viewport)
  const r = primaryRect(vp)
  return (
    <div className="primary-space" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
      <span className="primary-label">PRIMARY</span>
    </div>
  )
}
