import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import './cinematic.css'

// ── Animation helpers ──────────────────────────────────────────────────────────────────────────────
const clamp  = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const lerp   = (a: number, b: number, t: number): number => a + (b - a) * t
const prog   = (t: number, s: number, e: number): number => clamp((t - s) / (e - s), 0, 1)
const easeO3 = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3)
const easeO5 = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 5)
const easeIO5 = (t: number): number => {
  t = clamp(t, 0, 1)
  return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2
}
const spring = (t: number): number => {
  t = clamp(t, 0, 1)
  return 1 - Math.exp(-t * 9) * Math.cos(t * Math.PI * 3.8)
}

// ── Timing (ms) ───────────────────────────────────────────────────────────────────────────────────
const T = {
  scrimIn:    [0,    900]  as const,
  barFadeIn:  [700, 1400]  as const,
  rise:       [1100, 4300] as const,
  spring:     [4300, 4700] as const,
  barFadeOut: [4100, 4500] as const,
  scrimOut:   [4700, 5800] as const, // scrim lifts to reveal the real GlanceBar + desktop
  done:       6000,
}

export function CinematicIntro({
  onSettle,
  onComplete,
}: {
  onSettle?: () => void
  onComplete?: () => void
}): JSX.Element {
  const rootRef    = useRef<HTMLDivElement>(null)
  const scrimRef   = useRef<HTMLDivElement>(null)
  const barRef     = useRef<HTMLDivElement>(null)
  const barFillRef = useRef<HTMLDivElement>(null)
  const barGlowRef = useRef<HTMLDivElement>(null)
  const rafRef     = useRef(0)
  const settledRef   = useRef(false)
  const completedRef = useRef(false)

  useEffect(() => {
    window.agentOS?.notch?.setInteractive(true)

    const root    = rootRef.current!
    const scrim   = scrimRef.current!
    const bar     = barRef.current!
    const barFill = barFillRef.current!
    const barGlow = barGlowRef.current!

    const H = window.innerHeight
    const barStart  = H - 80
    const barEnd    = 1
    const totalDist = barStart - barEnd

    // Reset to initial state
    scrim.style.opacity = '0'
    bar.style.opacity   = '0'
    bar.style.top       = barStart + 'px'
    bar.style.width     = '320px'
    bar.style.height    = '44px'
    bar.style.filter    = 'none'
    barGlow.style.opacity = '0'

    let prevTop = barStart
    const t0 = performance.now()

    function tick(now: number): void {
      const t = now - t0

      // ── SCRIM: fade in, hold, then lift to reveal the real GlanceBar below ──
      const scrimInV  = easeO3(prog(t, T.scrimIn[0],  T.scrimIn[1]))
      const scrimOutV = easeO3(prog(t, T.scrimOut[0], T.scrimOut[1]))
      scrim.style.opacity = (scrimInV * 0.96 * (1 - scrimOutV)).toFixed(3)

      // ── BAR fade in / fade out ──
      const fadeIn  = easeO3(prog(t, T.barFadeIn[0],  T.barFadeIn[1]))
      const fadeOut = easeO5(prog(t, T.barFadeOut[0], T.barFadeOut[1]))
      bar.style.opacity = clamp(fadeIn - fadeOut, 0, 1).toFixed(3)

      // ── RISE ──
      const riseRaw = prog(t, T.rise[0], T.rise[1])
      const riseP   = easeIO5(riseRaw)
      let barTop = lerp(barStart, barEnd, riseP)

      // Spring settle
      if (t >= T.spring[0]) {
        const sp = prog(t, T.spring[0], T.spring[1])
        barTop = barEnd + (1 - spring(sp)) * 6
      }

      // Morph bar → notch shape in the final 28% of screen travel
      const screenFrac = 1 - (barTop - barEnd) / totalDist
      const morphP = easeO3(clamp((screenFrac - 0.72) / 0.28, 0, 1))
      const barW = lerp(320, 128, morphP)
      const barH = lerp(44,  34,  morphP)

      bar.style.top    = barTop.toFixed(1) + 'px'
      bar.style.width  = barW.toFixed(1)   + 'px'
      bar.style.height = barH.toFixed(1)   + 'px'

      const tintA = lerp(0.72, 0.50, morphP)
      const tintR = Math.round(lerp(8,  30, morphP))
      const tintG = Math.round(lerp(10, 55, morphP))
      const tintB = Math.round(lerp(14, 80, morphP))
      barFill.style.background = `rgba(${tintR},${tintG},${tintB},${tintA.toFixed(2)})`

      // Motion blur proportional to velocity
      const velocity = Math.abs(barTop - prevTop)
      prevTop = barTop
      const blur = Math.min(velocity * 0.18, 3).toFixed(1)
      bar.style.filter = parseFloat(blur) > 0.3 ? `blur(${blur}px)` : 'none'

      // Sky-blue travel glow (fades as the bar morphs into the notch)
      const midGlow = Math.sin(Math.PI * riseRaw) * 0.55 * (1 - morphP)
      barGlow.style.opacity = midGlow.toFixed(3)
      barGlow.style.boxShadow = [
        `0 0 ${12 + velocity}px ${4 + velocity * 0.3}px rgba(56,189,248,0.25)`,
        `0 0 40px 8px rgba(56,189,248,0.10)`,
      ].join(',')

      // Fire onSettle once when the spring is done — parent drops is-open so bars slide out.
      if (!settledRef.current && t >= T.spring[1]) {
        settledRef.current = true
        onSettle?.()
      }
      // Fire onComplete once when the scrim is fully lifted — parent opens the island.
      if (!completedRef.current && t >= T.scrimOut[1]) {
        completedRef.current = true
        onComplete?.()
      }

      if (t < T.done) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        root.style.display = 'none'
      }
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return createPortal(
    <div id="cin-root" ref={rootRef}>
      <div id="cin-scrim" ref={scrimRef} />
      <div id="cin-bar" ref={barRef}>
        <div id="cin-bar-fill" ref={barFillRef} />
        <div id="cin-bar-glow" ref={barGlowRef} />
        <div id="cin-bar-rim" />
        <div id="cin-bar-sheen" />
      </div>
    </div>,
    document.body
  )
}
