import { useState } from 'react'
import { SURFACE_LAUNCHER_ITEMS, type SurfaceLauncherKind } from './SurfaceLauncherButton'

type AnimationSourceRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

interface Props {
  center: { x: number; y: number } | null
  onCreateSurface: (kind: SurfaceLauncherKind, source?: AnimationSourceRect | null) => void
  onClose: () => void
}

const MENU_SIZE = 286
const ITEM_RADIUS = 105 // icon anchor = the centroid radius of a 60° annular sector of the ring
const MENU_MARGIN = 17
const HOLE_RADIUS = 67 // must match the ::before clip-path ring in styles.css

// Pizza-slice hit areas: every item button covers the full menu square, clipped to its annular
// sector — hover/click land anywhere on the slice (clip-path participates in hit testing), and the
// hover fill paints the WHOLE slice, not a puck around the icon.
const SLICE_DEG = 360 / SURFACE_LAUNCHER_ITEMS.length
function arcPoint(angleDeg: number, r: number): string {
  const a = (angleDeg * Math.PI) / 180
  return `${(MENU_SIZE / 2 + Math.cos(a) * r).toFixed(2)} ${(MENU_SIZE / 2 + Math.sin(a) * r).toFixed(2)}`
}
function slicePath(index: number): string {
  const a0 = -90 + index * SLICE_DEG - SLICE_DEG / 2
  const a1 = a0 + SLICE_DEG
  const R = MENU_SIZE / 2
  const large = SLICE_DEG > 180 ? 1 : 0
  return `M ${arcPoint(a0, R)} A ${R} ${R} 0 ${large} 1 ${arcPoint(a1, R)} L ${arcPoint(a1, HOLE_RADIUS)} A ${HOLE_RADIUS} ${HOLE_RADIUS} 0 ${large} 0 ${arcPoint(a0, HOLE_RADIUS)} Z`
}

// Displacement map for the glass torus (fed to feDisplacementMap via backdrop-filter: url()).
// Deflection follows the tube's surface slope: zero at the crest (ring centerline), steep at both
// rims, directed radially — so the backdrop genuinely refracts like thick round glass. R encodes
// dx, G encodes dy, 128 = neutral. The hole and the outside stay neutral (flat thin pane).
let displacementUrl: string | null = null
function refractionMapUrl(): string {
  if (displacementUrl) return displacementUrl
  const dpr = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)))
  const size = MENU_SIZE * dpr
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(size, size)
  const c = size / 2
  const inner = HOLE_RADIUS * dpr
  const outer = (MENU_SIZE / 2) * dpr
  const tubeCenter = (inner + outer) / 2
  const tubeHalf = (outer - inner) / 2
  const data = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dx = x + 0.5 - c
      const dy = y + 0.5 - c
      const r = Math.hypot(dx, dy)
      let vx = 0
      let vy = 0
      if (r >= inner && r <= outer && r > 0.001) {
        const t = Math.max(-0.985, Math.min(0.985, (r - tubeCenter) / tubeHalf))
        const slope = t / Math.sqrt(1 - t * t) // d/dr of the semicircular tube profile
        const mag = Math.max(-3, Math.min(3, slope)) / 3
        vx = (dx / r) * mag
        vy = (dy / r) * mag
      }
      data[i] = Math.round(128 + 127 * vx)
      data[i + 1] = Math.round(128 + 127 * vy)
      data[i + 2] = 128
      data[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  displacementUrl = canvas.toDataURL()
  return displacementUrl
}

function menuOrigin(center: { x: number; y: number }): { left: number; top: number } {
  return {
    left: Math.max(MENU_MARGIN, Math.min(window.innerWidth - MENU_SIZE - MENU_MARGIN, Math.round(center.x - MENU_SIZE / 2))),
    top: Math.max(MENU_MARGIN + 32, Math.min(window.innerHeight - MENU_SIZE - MENU_MARGIN, Math.round(center.y - MENU_SIZE / 2)))
  }
}

export function RadialSurfaceMenu({ center, onCreateSurface, onClose }: Props): JSX.Element | null {
  const [hovered, setHovered] = useState<string | null>(null)
  if (!center) return null

  const origin = menuOrigin(center)
  const source = {
    left: origin.left + MENU_SIZE / 2 - 18,
    top: origin.top + MENU_SIZE / 2 - 18,
    width: 36,
    height: 36
  }

  return (
    <div className="radial-launcher-layer">
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
        <filter
          id="radial-glass-refraction"
          x="0"
          y="0"
          width={MENU_SIZE}
          height={MENU_SIZE}
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feImage href={refractionMapUrl()} x="0" y="0" width={MENU_SIZE} height={MENU_SIZE} preserveAspectRatio="none" result="map" />
          <feDisplacementMap in="SourceGraphic" in2="map" scale="34" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div className="radial-launcher" style={{ left: origin.left, top: origin.top }}>
        <div className="radial-launcher-center">
          <span>{hovered ?? 'Create'}</span>
        </div>
        {SURFACE_LAUNCHER_ITEMS.map((item, index) => {
          const angle = -90 + index * SLICE_DEG
          const rad = (angle * Math.PI) / 180
          const x = MENU_SIZE / 2 + Math.cos(rad) * ITEM_RADIUS
          const y = MENU_SIZE / 2 + Math.sin(rad) * ITEM_RADIUS
          return (
            <button
              key={item.kind}
              className="radial-launcher-item"
              type="button"
              style={{ clipPath: `path('${slicePath(index)}')` }}
              onPointerEnter={() => setHovered(item.label)}
              onPointerLeave={() => setHovered(null)}
              onClick={() => {
                onCreateSurface(item.kind, source)
                onClose()
              }}
              aria-label={item.label}
              title={item.label}
            >
              <span className="radial-launcher-item-icon" style={{ left: x, top: y }}>
                {item.icon}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
