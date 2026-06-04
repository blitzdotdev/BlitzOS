import { PRIMARY_W, PRIMARY_H } from '../types'

/** The "home" rectangle centered on the world origin. */
export function PrimarySpace(): JSX.Element {
  return (
    <div
      className="primary-space"
      style={{
        left: -PRIMARY_W / 2,
        top: -PRIMARY_H / 2,
        width: PRIMARY_W,
        height: PRIMARY_H
      }}
    >
      <span className="primary-label">PRIMARY</span>
    </div>
  )
}
