// GlanceBar — the at-rest island: two BLACK bars that EXTEND the notch sideways on the macOS menu-bar line, split
// down the middle by the physical notch (so it reads as the notch growing wider). Same pure-black fill + 1px
// obsidian rim as the island chassis. LEFT bar = a circled BlitzOS app icon + a live status summary; RIGHT bar =
// overlapping circle avatars, one per running PEER agent (Blitz '0' is the icon, not a circle). Always mounted; the
// `open` prop collapses the bars INTO the notch (slide + fade) when the island opens and expands them back OUT when
// it closes, so the island appears to grow from / shrink to this bar. Hover-to-open is driven by App's mousemove
// (the overlay forwards moves even while click-through), so the bars themselves are display-only.
import blitzIcon from '../assets/blitz-glance-icon.png'
import { agentGradient } from './agentVisuals'

export interface GlancePeek {
  working: number
  attn: number
  err: number
  total: number
  agents: Array<{ id: string; status: string }>
}

const MAX_AVATARS = 5

export function GlanceBar({
  peek,
  notchWidth,
  menuBarH,
  open
}: {
  peek: GlancePeek
  notchWidth: number
  menuBarH: number
  open: boolean
}): JSX.Element {
  // EXACTLY the physical notch height — the same Math.max(28, menuBarH) the notch handle uses, with NO extra px.
  // Any overshoot (the old +2) drops the bar's bottom edge below the menu-bar line, where it paints over the top
  // edge of other open-but-not-fullscreen windows (a visible black artifact). One value drives BOTH halves below.
  const h = Math.max(28, menuBarH)
  // Each bar's FILL extends to the notch CENTER (the two overlap there) so together they form ONE continuous black
  // bar that COVERS the notch — giving a continuous bottom rim with NO dead-zone gap at the notch's rounded corners.
  // The CONTENT is padded back out (sidePad) so the icon/stats + avatars still sit to the SIDES of the notch.
  const toCenter = 'calc(50% - 4px)'
  const sidePad = notchWidth / 2 + 16
  // Avatars (RIGHT) = EVERY agent that is actively working, waiting on approval, errored, or reconnecting —
  // INCLUDING the Blitz main agent '0'. Idle/done agents get NO icon. The left BlitzOS icon is the brand.
  const active = peek.agents.filter(
    (a) => a.status === 'working' || a.status === 'starting' || a.status === 'waiting' || a.status === 'error' || a.status === 'reconnecting'
  )
  const shown = active.slice(0, MAX_AVATARS)
  const extra = active.length - shown.length
  const hasSummary = peek.working > 0 || peek.attn > 0 || peek.err > 0
  return (
    <>
      {/* LEFT bar — circled BlitzOS icon (pulses while Blitz '0' works) + status summary. Grows left from the notch. */}
      <div className={`glance-half glance-left${open ? ' is-open' : ''}`} style={{ right: toCenter, height: h, paddingRight: sidePad }} aria-hidden>
        <span className="glance-logo">
          <img src={blitzIcon} alt="" draggable={false} />
        </span>
        {hasSummary && (
          <span className="glance-sum">
            {peek.err > 0 && <span className="gl-error">{peek.err} error</span>}
            {peek.err > 0 && peek.working > 0 && <span className="gl-sep"> · </span>}
            {peek.working > 0 && <span className="gl-working">{peek.working} working</span>}
            {(peek.err > 0 || peek.working > 0) && peek.attn > 0 && <span className="gl-sep"> · </span>}
            {peek.attn > 0 && <span className="gl-attn">{peek.attn} needs you</span>}
          </span>
        )}
      </div>
      {/* RIGHT bar — ALWAYS shown (mirrors the left, MINUS the icon): an empty black bar when nothing is active, else
          the active peers' avatars. */}
      <div className={`glance-half glance-right${open ? ' is-open' : ''}`} style={{ left: toCenter, height: h, paddingLeft: sidePad }} aria-hidden>
        {shown.length > 0 && (
          <div className="glance-avas">
            {shown.map((a) => (
              <span
                key={a.id}
                className={`glance-ava${a.status === 'error' ? ' error' : a.status === 'working' || a.status === 'starting' || a.status === 'reconnecting' ? ' working' : a.status === 'waiting' ? ' attn' : ''}`}
                style={{ background: agentGradient(a.id) }}
              />
            ))}
            {extra > 0 && <span className="glance-ava glance-ava-more">+{extra}</span>}
          </div>
        )}
      </div>
    </>
  )
}
