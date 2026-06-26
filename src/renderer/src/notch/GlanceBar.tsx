// GlanceBar — the at-rest island: two BLACK bars that EXTEND the notch sideways on the macOS menu-bar line, split
// down the middle by the physical notch (so it reads as the notch growing wider). Same pure-black fill + 1px
// obsidian rim as the island chassis. LEFT bar = just the circled BlitzOS app icon; RIGHT bar =
// overlapping circle avatars, one per running PEER agent (Blitz '0' is the icon, not a circle). Always mounted; the
// `open` prop collapses the bars INTO the notch (slide + fade) when the island opens and expands them back OUT when
// it closes, so the island appears to grow from / shrink to this bar. Hover-to-open is driven by App's mousemove
// (the overlay forwards moves even while click-through), so the bars themselves are display-only.
import { agentGradient } from './agentVisuals'
import { useDoneAgents } from './doneStore'

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
  // Avatars (RIGHT) = EVERY agent that is actively working, waiting on approval, errored, or reconnecting (INCLUDING
  // the Blitz main agent '0'), PLUS any agent that just finished and hasn't been viewed yet — it sits settled wearing
  // a quiet green DONE pip until the user opens the island and views it (the mark clears in NotchHost). A settled
  // agent with no unseen done still gets NO icon. The left BlitzOS icon is the brand.
  const doneIds = useDoneAgents()
  const isActive = (s: string): boolean =>
    s === 'working' || s === 'starting' || s === 'waiting' || s === 'error' || s === 'reconnecting'
  // RAW host vocabulary (notch/types.ts): a finished/settled agent reports 'watching' (turn ended, post-debounce) or
  // 'idle' (no live terminal). Either one shows an avatar ONLY when it carries an unseen DONE mark.
  const isFinished = (s: string): boolean => s === 'watching' || s === 'idle'
  const shownAgents = peek.agents.filter((a) => isActive(a.status) || (isFinished(a.status) && doneIds.has(a.id)))
  const shown = shownAgents.slice(0, MAX_AVATARS)
  const extra = shownAgents.length - shown.length
  return (
    <>
      {/* RIGHT bar — agent avatars only. */}
      <div className={`glance-half glance-right${open ? ' is-open' : ''}`} style={{ left: toCenter, height: h, paddingLeft: sidePad }} aria-hidden>
        {shown.length > 0 && (
          <div className="glance-avas">
            {shown.map((a, i) => {
              const cls =
                a.status === 'error'
                  ? ' error'
                  : a.status === 'working' || a.status === 'starting' || a.status === 'reconnecting'
                    ? ' working'
                    : a.status === 'waiting'
                      ? ' attn'
                      : isFinished(a.status) && doneIds.has(a.id)
                        ? ' done'
                        : ''
              // Left-over-right z-stack: the LEFTMOST avatar sits highest, each one tucks UNDER its left neighbor
              // (so a top-right DONE pip is never clipped by the avatar to its right).
              return <span key={a.id} className={`glance-ava${cls}`} style={{ background: agentGradient(a.id), zIndex: shown.length - i }} />
            })}
            {/* the overflow counter caps the right end, kept on top so its "+N" stays legible. */}
            {extra > 0 && <span className="glance-ava glance-ava-more" style={{ zIndex: shown.length + 1 }}>+{extra}</span>}
          </div>
        )}
      </div>
    </>
  )
}
