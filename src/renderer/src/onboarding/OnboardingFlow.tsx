import { useEffect, useRef, useState } from 'react'

/**
 * Full-screen onboarding opener (P1, plans/onboarding-case-file.md): a warm, breathing boot
 * over an aurora-washed frost of the user's wallpaper, driven by the REAL scan running in main
 * (onboarding director). Progress, stage lines and the signal counter stream from
 * `onboarding:progress`; when the board starts seeding, the overlay DISSOLVES into the canvas
 * so the human watches the Case File assemble. No interview here: the managed agent backend (P2)
 * owns every question.
 */
export function OnboardingFlow({ onComplete }: { onComplete: () => void }): JSX.Element {
  const wallpaper = useWallpaper()
  const [leaving, setLeaving] = useState(false)
  const mounted = useRef(performance.now())
  const leavingRef = useRef(false)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  // Begin the dissolve, but never flash: the opener stays up ≥1.8s even when the board is cached.
  const beginLeave = (): void => {
    if (leavingRef.current) return
    leavingRef.current = true
    const wait = Math.max(0, 1800 - (performance.now() - mounted.current))
    window.setTimeout(() => {
      setLeaving(true)
      window.setTimeout(() => onCompleteRef.current(), 1150) // matches the .onb.out transition
    }, wait)
  }

  return (
    <div className={`onb${leaving ? ' out' : ''}`} data-theme="light">
      <div className="onb-wall" style={wallpaper ? { backgroundImage: `url("${wallpaper}")` } : undefined} />
      <div className="onb-aurora">
        <i className="a1" />
        <i className="a2" />
        <i className="a3" />
      </div>
      <div className="onb-veil" />
      <div className="onb-content">
        <BootScreen onSeeding={beginLeave} />
      </div>
    </div>
  )
}

/** Best-effort frosted wallpaper from main; null → the CSS light gradient shows through. */
function useWallpaper(): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.agentOS
      ?.getWallpaper?.()
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return url
}

interface ProgressEvent {
  phase?: string
  id?: string
  label?: string
  i?: number
  n?: number
  signals?: number
  fda?: boolean
  cached?: boolean
  error?: string
}

// The boot: "Blitz" breathes while the REAL scan streams stages. The bar eases toward a target
// set by each progress event (never jumps, never stalls visually); the signal counter ticks up
// as sources land. With no director (preview/server mode), a timed fallback keeps the flow alive.
function BootScreen({ onSeeding }: { onSeeding: () => void }): JSX.Element {
  const [shown, setShown] = useState(0) // eased 0..1
  const [stage, setStage] = useState('Waking up')
  const [signals, setSignals] = useState(0)
  const target = useRef(0.04)
  const seeded = useRef(false)
  const onSeedingRef = useRef(onSeeding)
  onSeedingRef.current = onSeeding

  // Ease the bar toward the latest target each frame (run once; targets live in a ref).
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      setShown((s) => s + (target.current - s) * 0.055)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const seedOnce = (): void => {
      if (!seeded.current) {
        seeded.current = true
        onSeedingRef.current()
      }
    }
    const api = window.agentOS?.onboarding
    if (!api) {
      // No director (e.g. browser preview): keep the old timed boot so the flow still completes.
      target.current = 1
      const t = window.setTimeout(seedOnce, 2600)
      return () => window.clearTimeout(t)
    }
    const off = api.onProgress((raw) => {
      const p = raw as ProgressEvent
      switch (p.phase) {
        case 'begin':
          target.current = 0.07
          setStage(p.fda ? 'Reading your Mac (full access)' : 'Reading your Mac')
          break
        case 'source':
          if (p.i && p.n) target.current = 0.07 + 0.75 * ((p.i - 1) / p.n)
          if (p.label) setStage(`Reading ${p.label}…`)
          break
        case 'source-done':
          if (p.i && p.n) target.current = 0.07 + 0.75 * (p.i / p.n)
          if (p.signals) setSignals((s) => s + (p.signals || 0))
          break
        case 'analyze':
          target.current = 0.88
          setStage('Connecting the dots…')
          break
        case 'seeding':
          target.current = 0.96
          setStage('Laying out your case file…')
          seedOnce() // dissolve WHILE the board assembles behind the overlay
          break
        case 'board-ready':
          target.current = 1
          if (p.cached) setStage('Welcome back')
          seedOnce()
          break
        case 'deepened':
          break // post-onboarding FDA rescan — the overlay is long gone
        case 'error':
          target.current = 1
          setStage('Starting fresh…')
          seedOnce() // degrade to the plain desktop, never block the human
          break
      }
    })
    void api.start()
    return off
  }, [])

  return (
    <div className="boot">
      <div className="boot-mark">Blitz</div>
      <div className="boot-bar">
        <div className="boot-bar-fill" style={{ width: `${Math.min(100, Math.round(shown * 100))}%` }} />
      </div>
      <div className="boot-stage">{stage}</div>
      <div className={`boot-signals${signals > 0 ? ' on' : ''}`}>{signals.toLocaleString()} signals found</div>
    </div>
  )
}
