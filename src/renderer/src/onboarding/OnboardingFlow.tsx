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
  // Pre-board permission steps run BEFORE the scan (plans/onboarding-case-file.md "frontload"):
  // every TCC grant lands before there is any board state to lose, and the FIRST scan already
  // benefits (the scan child inherits the app's FDA). 'steps' → 'boot' (scan + dissolve).
  const [phase, setPhase] = useState<'steps' | 'boot'>('steps')
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
    <div className={`onb${leaving ? ' out' : ''}`}>
      <div className="onb-wall" style={wallpaper ? { backgroundImage: `url("${wallpaper}")` } : undefined} />
      <div className="onb-aurora">
        <i className="a1" />
        <i className="a2" />
        <i className="a3" />
      </div>
      <div className="onb-veil" />
      <div className="onb-content">
        {phase === 'steps' ? <PreboardSteps onDone={() => setPhase('boot')} /> : <BootScreen onSeeding={beginLeave} />}
      </div>
    </div>
  )
}

type DragKind = 'fda' | 'accessibility' | 'screen'
type StepKey = DragKind | 'browser'

type PreboardState = {
  forced?: boolean
  steps: Record<string, 'granted' | 'denied' | 'skipped' | undefined>
  fda: boolean
  accessibility: boolean
  screen: boolean
  appName: string
  browser: { id: string; name: string } | null
  canDrag: boolean
  appIcon: string | null
}

// The three drag-list TCC permissions, in ask order: the personal layer first (the scan), then the
// computer-use pair. Each is granted by the Codex Computer Use flow — Settings opens to the pane and
// a floating drag-helper window (main) hosts the app-icon drag over the list. Copy is one warm breath.
const DRAG_STEPS: Array<{ key: DragKind; kicker: string; title: string; body: (appName: string) => string }> = [
  {
    key: 'fda',
    kicker: 'Before we begin',
    title: 'Unlock the personal layer',
    body: () =>
      'Blitz reads your Mac to build a private case file of how you work, all scanned and distilled locally. Full Disk Access adds the personal layer: your Messages cadence, Safari clusters, and app rhythm.'
  },
  {
    key: 'accessibility',
    kicker: 'So Blitz can act',
    title: 'Let Blitz use your apps',
    body: () =>
      'Accessibility lets Blitz read and drive app interfaces for you, the same access a screen reader uses, so it can do real work in the apps you already have.'
  },
  {
    key: 'screen',
    kicker: 'So Blitz can see',
    title: 'Let Blitz see the screen',
    body: () => 'Screen Recording lets Blitz see what is on screen so it knows where to click. Frames are used locally to act, never uploaded.'
  }
]

/** The Dia-style pre-board: one permission per screen, the why up front, one primary action, a
 *  quiet skip. The three drag-list grants (FDA, Accessibility, Screen Recording) use the Codex
 *  Computer Use flow — the primary button opens Settings to the pane AND raises a floating
 *  drag-helper window (main) that hosts the app-icon drag over the list; main polls and fires
 *  permission-granted, which celebrates + advances. Browser import asks for Automation consent
 *  (the osascript prompt) with live tab counts as the reward. Outcomes persist machine-level, so
 *  settled steps never re-ask; the board's unlock card stays the re-offer path for a skipped FDA. */
function PreboardSteps({ onDone }: { onDone: () => void }): JSX.Element | null {
  const api = window.agentOS?.onboarding
  const [st, setSt] = useState<PreboardState | null>(null)
  const [step, setStep] = useState<StepKey | null>(null)
  const [granted, setGranted] = useState(false) // current drag-step just granted (celebrate)
  const [opened, setOpened] = useState(false) // current drag-step's helper is up
  const [browserResult, setBrowserResult] = useState<{ status: string; windows?: number; tabs?: number } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const stepRef = useRef<StepKey | null>(null)
  stepRef.current = step

  const granteds = (s: PreboardState): Record<DragKind, boolean> => ({ fda: s.fda, accessibility: s.accessibility, screen: s.screen })
  const queue = (s: PreboardState): StepKey[] => {
    const g = granteds(s)
    const q: StepKey[] = []
    for (const d of DRAG_STEPS) if (!g[d.key] && !s.steps[d.key]) q.push(d.key)
    if (s.browser && !s.steps.browser) q.push('browser')
    return q
  }

  useEffect(() => {
    let alive = true
    if (!api?.preboardState) {
      doneRef.current() // browser preview / old main — straight to the boot
      return
    }
    void api.preboardState().then((s) => {
      if (!alive) return
      setSt(s)
      const q = queue(s)
      if (!q.length) doneRef.current()
      else setStep(q[0])
    })
    return () => {
      alive = false
      void api.closePermissionDrag?.()
    }
  }, [])

  // Main's poll detected a drag-list grant (and closed the helper) — if it's the step we're on,
  // celebrate and advance. (Forced dev mode never fires this; the tester advances via Not now.)
  useEffect(() => {
    if (!api?.onPermissionGranted) return
    return api.onPermissionGranted(({ kind }) => {
      if (stepRef.current !== kind) return
      setGranted(true)
      void api.preboardMark?.(kind, 'granted')
      window.setTimeout(() => advance(kind, true), 1100)
    })
  }, [])

  const goNext = (next: PreboardState): void => {
    setGranted(false)
    setOpened(false)
    setBrowserResult(null)
    const q = queue(next)
    if (!q.length) doneRef.current()
    else setStep(q[0])
  }

  const advance = (from: StepKey, didGrant: boolean): void => {
    void api?.closePermissionDrag?.()
    setSt((cur) => {
      if (!cur) return cur
      const g = didGrant && from !== 'browser' ? { [from]: true } : {}
      const next: PreboardState = { ...cur, ...g, steps: { ...cur.steps, [from]: cur.steps[from] ?? (didGrant ? 'granted' : 'skipped') } }
      goNext(next)
      return next
    })
  }

  const skip = (which: StepKey): void => {
    void api?.preboardMark?.(which, 'skipped')
    void api?.closePermissionDrag?.()
    setSt((cur) => {
      if (!cur) return cur
      const next: PreboardState = { ...cur, steps: { ...cur.steps, [which]: 'skipped' } }
      goNext(next)
      return next
    })
  }

  const openDrag = (kind: DragKind): void => {
    setOpened(true)
    void api?.openPermissionDrag?.(kind)
  }

  const connectBrowser = (): void => {
    if (!api?.requestAutomation || connecting) return
    setConnecting(true)
    void api.requestAutomation().then((r) => {
      setConnecting(false)
      setBrowserResult(r)
      void api.preboardMark?.('browser', r.status === 'granted' ? 'granted' : r.status === 'denied' ? 'denied' : 'skipped')
      window.setTimeout(() => advance('browser', false), r.status === 'granted' ? 1400 : 900)
    })
  }

  if (!st || !step) return null
  const dots = queue({ ...st, steps: {} })
  const dotIndex = dots.indexOf(step)
  const drag = DRAG_STEPS.find((d) => d.key === step)

  return (
    <div className="preboard">
      {drag && (
        <div className="pre-step">
          <div className="pre-kicker">{drag.kicker}</div>
          <h1 className="pre-title">{drag.title}</h1>
          <p className="pre-body">{drag.body(st.appName)}</p>
          {(opened || granted) && (
            <div className={`pre-drop${granted ? ' granted' : ''}`}>
              <div className="pre-drop-copy">
                {granted ? (
                  <strong>Granted. Thank you.</strong>
                ) : (
                  <>
                    Settings is open. Drag <strong>{st.appName}</strong> from the panel at the bottom into the list, then flip it on. I&apos;ll
                    notice the moment it lands.
                  </>
                )}
              </div>
            </div>
          )}
          <div className="pre-actions">
            <button className="pre-primary" onClick={() => openDrag(drag.key)} disabled={granted}>
              {opened ? 'Reopen System Settings' : 'Open System Settings'}
            </button>
            <button className="pre-skip" onClick={() => skip(drag.key)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {step === 'browser' && (
        <div className="pre-step">
          <div className="pre-kicker">One more thing</div>
          <h1 className="pre-title">Bring your browser in</h1>
          <p className="pre-body">
            Most of a day lives in the browser. One permission lets Blitz see your open {st.browser?.name} tabs, so it can pick up what you are
            working on and bring it onto the desk.
          </p>
          {browserResult?.status === 'granted' && (
            <div className="pre-drop granted">
              <div className="pre-drop-copy">
                <strong>
                  Connected. {browserResult.windows ?? 0} window{(browserResult.windows ?? 0) === 1 ? '' : 's'} · {browserResult.tabs ?? 0} tab
                  {(browserResult.tabs ?? 0) === 1 ? '' : 's'} in reach.
                </strong>
              </div>
            </div>
          )}
          {browserResult && browserResult.status !== 'granted' && (
            <div className="pre-drop">
              <div className="pre-drop-copy">No problem. You can connect it later from the board.</div>
            </div>
          )}
          <div className="pre-actions">
            <button className="pre-primary" onClick={connectBrowser} disabled={connecting || browserResult?.status === 'granted'}>
              {connecting ? 'Waiting for macOS…' : `Connect ${st.browser?.name ?? 'browser'}`}
            </button>
            <button className="pre-skip" onClick={() => skip('browser')}>
              Not now
            </button>
          </div>
        </div>
      )}
      <div className="pre-dots">
        {dots.map((d, i) => (
          <i key={d} className={i === dotIndex ? 'on' : ''} />
        ))}
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
