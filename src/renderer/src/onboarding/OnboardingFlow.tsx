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
// The three TCC grants share ONE checklist screen ('tcc'). 'import' = the merged "bring your browser in"
// (Chrome sign-in + open tabs in one pick); 'browser' = the tabs-only fallback when import is skipped or
// there are no Chrome profiles to import.
type StepKey = 'tcc' | 'import' | 'browser'
type ImportProfile = { id: string; name: string; email: string | null }
type ImportSource = { id: string; name: string; profiles: ImportProfile[] }

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
  importSources?: ImportSource[]
}

// The three drag-list TCC permissions, in ask order, now shown TOGETHER on one checklist screen
// (each row: name, one-line why, live status). Each is granted by the Codex Computer Use flow — a
// row's action opens Settings to the pane AND raises the floating drag-helper window (main) that
// hosts the app-icon drag over the list. Main polls and fires permission-granted, which flips the row.
const DRAG_STEPS: Array<{ key: DragKind; name: string; why: string }> = [
  { key: 'fda', name: 'Full Disk Access', why: 'Builds your private case file from Messages cadence, Safari clusters, and app rhythm — all local.' },
  { key: 'accessibility', name: 'Accessibility', why: 'Lets Blitz read and drive your apps to do real work, the same access a screen reader uses.' },
  { key: 'screen', name: 'Screen Recording', why: 'Lets Blitz see the screen so it knows where to click. Frames are used locally, never uploaded.' }
]
const PERM_NAME: Record<DragKind, string> = { fda: 'Full Disk Access', accessibility: 'Accessibility', screen: 'Screen Recording' }

/** The pre-board: ONE TCC checklist screen (FDA, Accessibility, Screen Recording shown together with
 *  live per-row status), then sign-in and browser as their own steps. Each TCC row's action uses the
 *  Codex Computer Use flow — it opens Settings to the pane AND raises a floating drag-helper window
 *  (main) that hosts the app-icon drag over the list; main polls and fires permission-granted, which
 *  flips JUST that row to a check that stays (no auto-advance). Continue carries on whenever you are
 *  ready; an ungranted row stays pending and re-offers next launch. Browser import asks for Automation
 *  consent with live tab counts. Outcomes persist machine-level; the board's unlock card is the FDA
 *  re-offer path too. */
function PreboardSteps({ onDone }: { onDone: () => void }): JSX.Element | null {
  const api = window.agentOS?.onboarding
  const [st, setSt] = useState<PreboardState | null>(null)
  const [step, setStep] = useState<StepKey | null>(null)
  const [activeKind, setActiveKind] = useState<DragKind | null>(null) // which TCC row's drag helper is up
  const [browserResult, setBrowserResult] = useState<{ status: string; windows?: number; tabs?: number } | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [picked, setPicked] = useState<{ src: string; id: string; email: string | null } | null>(null) // signin account picker
  const [importing, setImporting] = useState(false)
  const [signinResult, setSigninResult] = useState<{ ok: boolean; account?: string | null; imported?: number; reason?: string } | null>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  // Session-only: once Continue is pressed on the TCC checklist, do not re-offer it THIS run even if a
  // row is still ungranted. Per-row grants persist; this governs only within-session screen order
  // (the re-offer default — an ungranted row returns on the NEXT launch).
  const tccDoneRef = useRef(false)

  const granteds = (s: PreboardState): Record<DragKind, boolean> => ({ fda: s.fda, accessibility: s.accessibility, screen: s.screen })
  // A TCC row is settled only when granted; there is no per-row skip, so un-granted rows re-offer.
  const tccPending = (s: PreboardState): boolean => DRAG_STEPS.some((d) => !granteds(s)[d.key] && s.steps[d.key] !== 'granted')
  const hasProfiles = (s: PreboardState): boolean => !!s.importSources?.some((x) => x.profiles.length)
  const queue = (s: PreboardState): StepKey[] => {
    const q: StepKey[] = []
    if (!tccDoneRef.current && tccPending(s)) q.push('tcc') // the three grants share ONE checklist screen
    // ONE merged "bring your browser in": picking a Chrome profile imports its sign-in AND auto-pulls the
    // open tabs. Only when it is skipped (or there are no profiles) do we ask for the tabs on their own.
    if (hasProfiles(s) && !s.steps.import) q.push('import')
    if (s.browser && !s.steps.browser && (s.steps.import === 'skipped' || !hasProfiles(s))) q.push('browser')
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

  // Main's poll detected a TCC grant (and closed the helper). Flip ONLY that row and let the counter
  // tick — no auto-advance, so the human watches the check land and stays in control of Continue.
  useEffect(() => {
    if (!api?.onPermissionGranted) return
    return api.onPermissionGranted(({ kind }) => {
      void api.preboardMark?.(kind, 'granted')
      setActiveKind((cur) => (cur === kind ? null : cur))
      setSt((cur) => (cur ? { ...cur, [kind]: true, steps: { ...cur.steps, [kind]: 'granted' } } : cur))
    })
  }, [])

  const goNext = (next: PreboardState): void => {
    setActiveKind(null)
    setBrowserResult(null)
    setPicked(null)
    setImporting(false)
    setSigninResult(null)
    const q = queue(next)
    if (!q.length) doneRef.current()
    else setStep(q[0])
  }

  // import/browser only — the TCC rows live on the checklist and never advance the screen individually.
  const advance = (from: 'import' | 'browser', didGrant: boolean): void => {
    void api?.closePermissionDrag?.()
    setSt((cur) => {
      if (!cur) return cur
      const next: PreboardState = { ...cur, steps: { ...cur.steps, [from]: cur.steps[from] ?? (didGrant ? 'granted' : 'skipped') } }
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
    setActiveKind(kind)
    void api?.openPermissionDrag?.(kind)
  }

  // Leave un-granted rows PENDING (they re-offer next launch); just move past the checklist this run.
  const continueTcc = (): void => {
    tccDoneRef.current = true
    void api?.closePermissionDrag?.()
    if (st) goNext(st)
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

  // The merged "bring your browser in": import the picked Chrome profile's Google sign-in (Keychain
  // prompt) AND, since the user chose to bring Chrome in, auto-request Automation to pull the open tabs.
  // Both outcomes are marked so the standalone tabs step is skipped; advance after a beat to show feedback.
  const runImport = (): void => {
    if (!api?.importSignin || !picked || importing) return
    setImporting(true)
    void api.importSignin(picked.src, picked.id).then(async (r) => {
      setSigninResult(r)
      let auto: { status: string; windows?: number; tabs?: number } | undefined
      try {
        auto = api.requestAutomation ? await api.requestAutomation() : undefined
      } catch {
        auto = undefined
      }
      if (auto) setBrowserResult(auto)
      setImporting(false)
      const browserOutcome = auto?.status === 'granted' ? 'granted' : auto?.status === 'denied' ? 'denied' : 'skipped'
      void api.preboardMark?.('import', r.ok ? 'granted' : 'skipped')
      void api.preboardMark?.('browser', browserOutcome)
      window.setTimeout(() => {
        setSt((cur) => {
          if (!cur) return cur
          const next: PreboardState = { ...cur, steps: { ...cur.steps, import: r.ok ? 'granted' : 'skipped', browser: browserOutcome } }
          goNext(next)
          return next
        })
      }, r.ok ? 1700 : 1000)
    })
  }

  if (!st || !step) return null
  // Screen dots — the checklist (while any TCC is ungranted) + the merged import + the tabs fallback.
  const dots: StepKey[] = []
  if (DRAG_STEPS.some((d) => !granteds(st)[d.key])) dots.push('tcc')
  if (hasProfiles(st)) dots.push('import')
  if (st.browser && (!hasProfiles(st) || st.steps.import === 'skipped')) dots.push('browser')
  const dotIndex = dots.indexOf(step)
  const g = granteds(st)
  const grantedCount = DRAG_STEPS.filter((d) => g[d.key] || st.steps[d.key] === 'granted').length

  return (
    <div className="preboard">
      {step === 'tcc' && (
        <div className="pre-step pre-tcc">
          <div className="pre-kicker">Before we begin</div>
          <h1 className="pre-title">Set up Blitz</h1>
          <p className="pre-body">Three permissions, all local. Grant any, skip any — you can change these later from the board.</p>
          <div className="pre-checklist">
            {DRAG_STEPS.map((d) => {
              const isGranted = g[d.key] || st.steps[d.key] === 'granted'
              const isActive = activeKind === d.key && !isGranted
              return (
                <div key={d.key} className={`pre-row${isGranted ? ' granted' : ''}${isActive ? ' active' : ''}`}>
                  <span className="pre-row-icon" aria-hidden>
                    {isGranted ? (
                      <svg viewBox="0 0 16 16" width="15" height="15">
                        <path d="M3.5 8.4l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : null}
                  </span>
                  <span className="pre-row-text">
                    <span className="pre-row-name">{d.name}</span>
                    <span className="pre-row-why">{d.why}</span>
                  </span>
                  <span className="pre-row-action">
                    {isGranted ? (
                      <span className="pre-row-status">Granted</span>
                    ) : (
                      <button className="pre-row-btn" onClick={() => openDrag(d.key)}>
                        {isActive ? 'Reopen' : 'Enable'}
                      </button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
          {activeKind && !g[activeKind] && (
            <div className="pre-drop">
              <div className="pre-drop-copy">
                Settings is open. Drag <strong>{st.appName}</strong> into the {PERM_NAME[activeKind]} list, then flip it on. I&apos;ll notice the
                moment it lands.
              </div>
            </div>
          )}
          <div className="pre-actions">
            <button className="pre-primary" onClick={continueTcc}>
              Continue
            </button>
          </div>
          <div className="pre-count">
            {grantedCount} of {DRAG_STEPS.length} granted
          </div>
        </div>
      )}
      {step === 'import' && (() => {
        const accounts = (st.importSources || []).flatMap((s) => s.profiles.map((p) => ({ src: s.id, id: p.id, name: p.name, email: p.email })))
        return (
          <div className="pre-step">
            <div className="pre-kicker">Bring it in</div>
            <h1 className="pre-title">Bring your browser in</h1>
            <p className="pre-body">
              Pick a Chrome profile. Blitz brings its Google sign-in here, so Gmail and Docs are open and every &quot;Sign in with Google&quot; is
              one tap, and it carries in your open tabs so it can pick up what you are working on. Your password never leaves Chrome.
            </p>
            {!signinResult && (
              <div className="pre-accounts">
                {accounts.map((a) => (
                  <button
                    key={a.src + a.id}
                    className={`pre-account${picked && picked.src === a.src && picked.id === a.id ? ' on' : ''}`}
                    onClick={() => setPicked({ src: a.src, id: a.id, email: a.email })}
                  >
                    <span className="pre-account-name">{a.email || a.name}</span>
                    {a.email && a.name !== a.email ? <span className="pre-account-sub">{a.name}</span> : null}
                  </button>
                ))}
              </div>
            )}
            {signinResult?.ok && (
              <div className="pre-drop granted">
                <div className="pre-drop-copy">
                  <strong>
                    Signed in as {signinResult.account || 'your Google account'}.
                    {browserResult?.status === 'granted'
                      ? ` ${browserResult.tabs ?? 0} tab${(browserResult.tabs ?? 0) === 1 ? '' : 's'} brought in.`
                      : ' Gmail, Docs, and Google sign-in are ready.'}
                  </strong>
                </div>
              </div>
            )}
            {signinResult && !signinResult.ok && (
              <div className="pre-drop">
                <div className="pre-drop-copy">
                  {signinResult.reason === 'denied'
                    ? 'No problem. Keychain access was declined. You can do this later from the board.'
                    : 'Could not import that sign-in. You can try again later from the board.'}
                </div>
              </div>
            )}
            <div className="pre-actions">
              <button className="pre-primary" onClick={runImport} disabled={!picked || importing || !!signinResult?.ok}>
                {importing ? 'Bringing it in…' : 'Bring it in'}
              </button>
              <button className="pre-skip" onClick={() => skip('import')}>
                Not now
              </button>
            </div>
          </div>
        )
      })()}
      {step === 'browser' && (
        <div className="pre-step">
          <div className="pre-kicker">One more thing</div>
          <h1 className="pre-title">Bring your open tabs in</h1>
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
