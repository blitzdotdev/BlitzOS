import { useDesktop, primaryRect } from './store'
import type { Surface } from './types'

// Capture a "screenshot" of the PRIMARY AREA — the on-screen desktop region (screen-sized + dynamic,
// see primaryRect) centered on the world origin — into a JPEG data URL. This is the last-seen snapshot shown in the Mission Control
// overview (macOS-style). Since users are mostly locked to the primary space, this rectangle IS the
// board. Web surfaces are drawn from their live streamed <canvas> (real pixels, same-origin via the
// data:-URL frame draw, so readable); notes / panels / srcdoc draw as titled cards (their content
// isn't compositable here). Returns null if there's nothing meaningful to capture.

// The thumbnail captures the PRIMARY AREA (the on-screen desktop region). The area is screen-sized
// (dynamic), so the exact rect + scale are computed per call from the live viewport.
const THUMB_W = 480

// Accent fill per kind for the card fallback (a hint of what the window is).
const KIND_BG: Record<string, string> = {
  note: '#3a3320',
  srcdoc: '#1e2b3a',
  chat: '#241f33',
  activity: '#1f2a24',
  web: '#0d1117',
  app: '#0d1117'
}

function cssEscape(s: string): string {
  const c = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS
  return c?.escape ? c.escape(s) : s.replace(/["\\]/g, '\\$&')
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function capturePrimaryThumb(): string | null {
  const st = useDesktop.getState()
  const surfaces = st.surfaces
  if (!surfaces.length) return null

  const rect = primaryRect(st.viewport)
  const THUMB_H = Math.round((THUMB_W * rect.h) / rect.w)
  const SCALE = THUMB_W / rect.w // world px → thumb px
  const ORIGIN_X = rect.x // primary rect left edge in world coords
  const ORIGIN_Y = rect.y // top edge

  const canvas = document.createElement('canvas')
  canvas.width = THUMB_W
  canvas.height = THUMB_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.fillStyle = '#0e1116'
  ctx.fillRect(0, 0, THUMB_W, THUMB_H)

  // back-to-front by EFFECTIVE z so the stacking matches the board: chat/activity panels are pinned
  // above everything (SurfaceFrame gives them a +2_000_000 z-band), so they must draw last here too.
  const PIN_BAND = 2_000_000
  const effZ = (s: Surface): number =>
    (s.role === 'chat' || s.role === 'activity' || (s.kind === 'native' && (s.component === 'chat' || s.component === 'activity')) ? PIN_BAND : 0) + (s.z || 0)
  // Match what the board actually shows: folder members (grouped, not peeked) and minimized windows
  // aren't rendered (App.tsx render gate + SurfaceFrame), so don't draw them into the snapshot either.
  const ordered = [...surfaces].filter((s) => !(s.groupId && !s.peek) && !s.minimized).sort((a, b) => effZ(a) - effZ(b))
  let drewAny = 0
  for (const s of ordered) {
    const x = (s.x - ORIGIN_X) * SCALE
    const y = (s.y - ORIGIN_Y) * SCALE
    const w = s.w * SCALE
    const h = s.h * SCALE
    if (x + w < 0 || y + h < 0 || x > THUMB_W || y > THUMB_H) continue // outside the primary rect
    drewAny++

    let drew = false
    if (s.kind === 'web') {
      const el = document.querySelector(`[data-sid="${cssEscape(s.id)}"] canvas`) as HTMLCanvasElement | null
      // a fresh <canvas> is 300x150 (HTML default) → no frame yet → fall back to a card
      if (el && !(el.width === 300 && el.height === 150)) {
        try {
          ctx.drawImage(el, x, y, w, h)
          drew = true
        } catch {
          /* not ready — card fallback */
        }
      }
    }
    if (!drew) {
      const kindKey = s.kind === 'native' ? String(s.component || 'native') : s.kind
      ctx.fillStyle = KIND_BG[kindKey] || '#161b22'
      roundRect(ctx, x, y, w, h, 4)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.stroke()
      if (h > 14 && w > 16) {
        ctx.save()
        roundRect(ctx, x, y, w, h, 4)
        ctx.clip()
        ctx.fillStyle = 'rgba(230,237,243,0.85)'
        ctx.font = '9px -apple-system,system-ui,sans-serif'
        ctx.fillText(String(s.title || s.kind), x + 5, y + 12)
        ctx.restore()
      }
    }
  }

  if (!drewAny) return null // every surface was off the primary rect — don't clobber a good thumb with a blank one
  try {
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return null // tainted (shouldn't happen — streamed frames are same-origin data URLs)
  }
}
