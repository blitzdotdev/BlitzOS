import { useDesktop, homeRect } from '../store'

// Below this camera scale the home-region frame fades in, so a user who has zoomed out on the
// infinite canvas (single-⇧ unfreeze) can see where the bounded "home" lattice sits. At rest
// (frozen, scale ~1) it stays hidden — the desktop reads clean.
const HOME_FRAME_SCALE_THRESHOLD = 0.92

/** The single bounded "home" region (plans/blitzos-single-canvas-navigation.md): a dashed frame at the
 *  computed home rect, revealed only when the camera is zoomed out on the infinite canvas. There are no
 *  stages/splay anymore — home is the one slot-lattice region; off-home is open canvas. */
export function PrimarySpace(): JSX.Element | null {
  const vp = useDesktop((s) => s.viewport)
  const scale = useDesktop((s) => s.transform.scale)
  if (scale >= HOME_FRAME_SCALE_THRESHOLD) return null
  const r = homeRect(vp)
  return (
    <div
      className="primary-space is-current"
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
    />
  )
}
