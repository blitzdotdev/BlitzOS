import './island.css'
import { useEffect, useRef, useState } from 'react'
import { OnboardingVisual, OnboardingDoneHero, type IntroVisual } from './onboardingVisuals'

type DragKind = 'fda' | 'accessibility' | 'screen'
type StepKey = 'permissions' | 'chromejs' | 'import' | 'browser' | 'done'
type Outcome = 'granted' | 'denied' | 'skipped'
type ImportProfile = { id: string; name: string; email: string | null }
type ImportSource = { id: string; name: string; profiles: ImportProfile[] }
type BrowserResult = { status: 'granted' | 'denied' | 'unavailable'; windows?: number; tabs?: number; browser?: string }
type SigninResult = { ok: boolean; reason?: string; account?: string | null; imported?: number; signedIn?: boolean }
type IntroSlide = { eyebrow: string; title: string; copy: string; visual: IntroVisual }

type PreboardState = {
  forced?: boolean
  steps: Record<string, Outcome | undefined>
  fda: boolean
  accessibility: boolean
  screen: boolean
  appName: string
  browser: { id: string; name: string } | null
  canDrag: boolean
  appIcon: string | null
}

const PERMISSIONS: Array<{ key: DragKind; name: string; why: string }> = [
  { key: 'fda', name: 'Full Disk Access', why: 'Lets Blitz build local context from your Mac.' },
  { key: 'accessibility', name: 'Accessibility', why: 'Lets Blitz read and operate apps when you ask.' },
  { key: 'screen', name: 'Screen Recording', why: 'Lets Blitz see enough of the screen to click accurately.' }
]
const CHECK_PATH = 'm5 12 4 4L19 6'
const INTRO_SLIDES: IntroSlide[] = [
  {
    eyebrow: 'Welcome',
    title: 'Meet Blitz — your agents, on tap',
    copy: 'A quiet island at the top of your screen. Hover in to see what every agent is doing — working, done, or waiting on you.',
    visual: 'home'
  },
  {
    eyebrow: 'A team, not a tool',
    title: 'Run a roster of agents at once',
    copy: 'Each agent gets its own tab and its own conversation. Hand off work and switch between them like chats.',
    visual: 'tabs'
  },
  {
    eyebrow: 'Your real apps',
    title: 'Put your browser and apps in reach',
    copy: 'Connect a tab or a window, then just ask. Blitz works where you already are and reports back.',
    visual: 'connect'
  },
  {
    eyebrow: 'Big jobs, in view',
    title: 'Watch the work unfold',
    copy: 'Blitz breaks large tasks into a workflow you can open as a board — every step moving from to-do to done.',
    visual: 'workflow'
  },
  {
    eyebrow: 'You stay in control',
    title: 'A few permissions make it useful',
    copy: 'Next, Blitz asks for the Mac access it needs. You can skip anything and change it later.',
    visual: 'final'
  }
]

const hasProfiles = (sources: ImportSource[]): boolean => sources.some((source) => source.profiles.length > 0)
const isGranted = (state: PreboardState, key: DragKind): boolean => !!state[key] || state.steps[key] === 'granted'
const permissionPending = (state: PreboardState): boolean => PERMISSIONS.some((permission) => !isGranted(state, permission.key))
// The Chrome "Allow JavaScript from Apple Events" step only applies to Google Chrome (the View ▸ Developer
// row + the bridge target are Chrome-specific). No Chrome detected → skip the step entirely.
const CHROME_BROWSER_ID = 'com.google.Chrome'
const wantsChromeJs = (state: PreboardState): boolean => state.browser?.id === CHROME_BROWSER_ID

// Forward-compatible bridge: the Chrome-JS IPC lives in main (onboarding.ts) but its preload bindings are
// added separately (src/preload/index.ts). Access them through an optional-typed cast so this compiles +
// no-ops until those bindings land, then works once they do. NOT a hack — the methods are optional.
type OnboardingChromeJsApi = {
  openChromeJsStep?: () => Promise<{ ok: boolean }>
  closeChromeJsStep?: () => Promise<{ ok: boolean }>
  onChromeJsGranted?: (cb: () => void) => () => void
}
const chromeJsApi = (api: NonNullable<typeof window.agentOS>['onboarding'] | undefined): OnboardingChromeJsApi | undefined =>
  api as (OnboardingChromeJsApi & typeof api) | undefined

function nextStep(state: PreboardState, sources: ImportSource[], permissionsDone: boolean): StepKey {
  if (!permissionsDone && permissionPending(state)) return 'permissions'
  // Chrome JS bridge sits immediately after the Mac permissions (it depends on the Automation/AX grants).
  if (wantsChromeJs(state) && !state.steps.chromejs) return 'chromejs'
  if (hasProfiles(sources) && !state.steps.import) return 'import'
  if (state.browser && !state.steps.browser && (state.steps.import === 'skipped' || !hasProfiles(sources))) return 'browser'
  return 'done'
}

export function IslandOnboarding({ menuBarH, onComplete }: { menuBarH: number; onComplete: () => void }): JSX.Element {
  const api = window.agentOS?.onboarding
  const top = Math.max(28, menuBarH) + 8
  const [state, setState] = useState<PreboardState | null>(null)
  const [sources, setSources] = useState<ImportSource[]>([])
  const [introIndex, setIntroIndex] = useState(0)
  const [introDone, setIntroDone] = useState(false)
  const [step, setStep] = useState<StepKey>('permissions')
  const [activeKind, setActiveKind] = useState<DragKind | null>(null)
  const [picked, setPicked] = useState<{ src: string; id: string; email: string | null } | null>(null)
  const [importing, setImporting] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [signinResult, setSigninResult] = useState<SigninResult | null>(null)
  const [browserResult, setBrowserResult] = useState<BrowserResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const permissionsDoneRef = useRef(false)
  // The import/browser steps auto-advance after a short delay; hold the timer so a manual nav (skip) or
  // unmount cancels it — otherwise a late goNext re-advances/overwrites the user's choice on dead state.
  const advanceTimer = useRef<number | null>(null)
  const clearAdvance = (): void => {
    if (advanceTimer.current != null) {
      clearTimeout(advanceTimer.current)
      advanceTimer.current = null
    }
  }

  const goNext = (nextState: PreboardState, nextSources = sources): void => {
    clearAdvance()
    setActiveKind(null)
    setPicked(null)
    setImporting(false)
    setConnecting(false)
    setSigninResult(null)
    setBrowserResult(null)
    setError(null)
    setStep(nextStep(nextState, nextSources, permissionsDoneRef.current))
  }

  const scheduleAdvance = (next: PreboardState, delayMs: number): void => {
    clearAdvance()
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null
      goNext(next)
    }, delayMs)
  }

  useEffect(() => {
    let alive = true
    if (!api?.preboardState) {
      setStep('done')
      return
    }
    Promise.all([api.preboardState(), api.listImportProfiles?.() ?? Promise.resolve([])])
      .then(([nextState, nextSources]) => {
        if (!alive) return
        const cleanSources = Array.isArray(nextSources) ? (nextSources as ImportSource[]) : []
        setState(nextState as PreboardState)
        setSources(cleanSources)
        setStep(nextStep(nextState as PreboardState, cleanSources, permissionsDoneRef.current))
      })
      .catch(() => {
        if (!alive) return
        setError('Setup is unavailable right now.')
        setStep('done')
      })
    return () => {
      alive = false
      clearAdvance()
      void api.closePermissionDrag?.()
      void chromeJsApi(api)?.closeChromeJsStep?.()
    }
  }, [])

  useEffect(() => {
    if (!api?.onPermissionGranted) return undefined
    return api.onPermissionGranted(({ kind }) => {
      void api.preboardMark?.(kind, 'granted')
      setActiveKind((cur) => (cur === kind ? null : cur))
      setState((cur) => (cur ? { ...cur, [kind]: true, steps: { ...cur.steps, [kind]: 'granted' } } : cur))
    })
  }, [])

  // Main pushes chromejs-granted the moment its probe sees Chrome's Apple-Events JS turn on. Mark it
  // done + advance (the next step is computed from the updated state by goNext on the latest snapshot).
  useEffect(() => {
    const onGranted = chromeJsApi(api)?.onChromeJsGranted
    if (!onGranted) return undefined
    return onGranted(() => {
      void api?.preboardMark?.('chromejs', 'granted')
      setState((cur) => {
        const next = cur ? { ...cur, steps: { ...cur.steps, chromejs: 'granted' as const } } : cur
        if (next) goNext(next)
        return next
      })
    })
  }, [])

  // Auto-open the Chrome helper when the flow reaches the chromejs step (parity with the drag steps,
  // which the user triggers per-row — here there is one row, so we open it on entry). Closes on leave.
  useEffect(() => {
    if (step !== 'chromejs') return undefined
    openChromeJs()
    return () => {
      void chromeJsApi(api)?.closeChromeJsStep?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  const openPermission = (kind: DragKind): void => {
    setActiveKind(kind)
    setError(null)
    const request = api?.openPermissionDrag?.(kind)
    if (!request) {
      setError('Could not open the permission helper.')
      return
    }
    request
      .then((result) => {
        if (!result?.ok) setError('Could not open the permission helper.')
      })
      .catch(() => setError('Could not open the permission helper.'))
  }

  const continuePermissions = (): void => {
    permissionsDoneRef.current = true
    void api?.closePermissionDrag?.()
    if (state) goNext(state)
  }

  const skipStep = (key: 'chromejs' | 'import' | 'browser'): void => {
    if (!state) return
    if (key === 'chromejs') void chromeJsApi(api)?.closeChromeJsStep?.()
    void api?.preboardMark?.(key, 'skipped')
    const next = { ...state, steps: { ...state.steps, [key]: 'skipped' as const } }
    setState(next)
    goNext(next)
  }

  // The Chrome JS step: open View ▸ Developer + float the helper at the row, then wait for main's
  // chromejs-granted push (probe-backed) to mark it done and advance. Idempotent per render.
  const openChromeJs = (): void => {
    setError(null)
    const request = chromeJsApi(api)?.openChromeJsStep?.()
    if (!request) {
      // Bindings not present yet (or non-macOS): let the user move past rather than trapping them here.
      setError('Could not open the Chrome helper. You can enable this later in Chrome ▸ View ▸ Developer.')
      return
    }
    request.then((result) => {
      if (!result?.ok) setError('Could not open the Chrome helper.')
    }).catch(() => setError('Could not open the Chrome helper.'))
  }

  const runImport = (): void => {
    if (!api?.importSignin || !picked || importing || !state) return
    setImporting(true)
    setError(null)
    api
      .importSignin(picked.src, picked.id)
      .then(async (result) => {
        setSigninResult(result)
        let browser: BrowserResult | undefined
        try {
          browser = api.requestAutomation ? await api.requestAutomation() : undefined
        } catch {
          browser = undefined
        }
        if (browser) setBrowserResult(browser)
        const importOutcome: Outcome = result.ok ? 'granted' : 'skipped'
        const browserOutcome: Outcome = browser?.status === 'granted' ? 'granted' : browser?.status === 'denied' ? 'denied' : 'skipped'
        void api.preboardMark?.('import', importOutcome)
        void api.preboardMark?.('browser', browserOutcome)
        const next = { ...state, steps: { ...state.steps, import: importOutcome, browser: browserOutcome } }
        setState(next)
        scheduleAdvance(next, result.ok ? 1200 : 800)
      })
      .catch(() => {
        setImporting(false)
        setError('Could not import that profile.')
      })
  }

  const connectBrowser = (): void => {
    if (!api?.requestAutomation || connecting || !state) return
    setConnecting(true)
    setError(null)
    api
      .requestAutomation()
      .then((result) => {
        setBrowserResult(result)
        const outcome: Outcome = result.status === 'granted' ? 'granted' : result.status === 'denied' ? 'denied' : 'skipped'
        void api.preboardMark?.('browser', outcome)
        const next = { ...state, steps: { ...state.steps, browser: outcome } }
        setState(next)
        scheduleAdvance(next, result.status === 'granted' ? 1100 : 800)
      })
      .catch(() => {
        setConnecting(false)
        setError('Could not connect your browser.')
      })
  }

  const accounts = sources.flatMap((source) => source.profiles.map((profile) => ({ src: source.id, id: profile.id, name: profile.name, email: profile.email })))
  const grantedCount = state ? PERMISSIONS.filter((permission) => isGranted(state, permission.key)).length : 0
  const introSlide = INTRO_SLIDES[introIndex] ?? INTRO_SLIDES[0]
  const finishIntro = (): void => {
    setIntroDone(true)
    if (state) setStep(nextStep(state, sources, permissionsDoneRef.current))
  }

  return (
    <div className="nh-island isl-onboarding" style={{ paddingTop: top }}>
      {!introDone && (
        <div className={`isl-onb-intro visual-${introSlide.visual}`}>
          {introSlide.visual !== 'final' && <OnboardingVisual key={introIndex} kind={introSlide.visual} />}
          <div className="isl-onb-head intro">
            <span className="isl-onb-kicker">{introSlide.eyebrow}</span>
            <h1 className="isl-onb-title">{introSlide.title}</h1>
            <p className="isl-onb-copy">{introSlide.copy}</p>
          </div>
          <div className="isl-onb-progress" aria-label={`Intro slide ${introIndex + 1} of ${INTRO_SLIDES.length}`}>
            {INTRO_SLIDES.map((slide, index) => (
              <button
                key={slide.visual}
                type="button"
                className={index === introIndex ? 'on' : ''}
                aria-label={`Go to slide ${index + 1}`}
                onClick={() => setIntroIndex(index)}
              />
            ))}
          </div>
          <div className="isl-onb-actions">
            {introIndex > 0 && (
              <button type="button" className="isl-onb-quiet" onClick={() => setIntroIndex((index) => Math.max(0, index - 1))}>
                Back
              </button>
            )}
            <button
              type="button"
              className="isl-onb-primary"
              onClick={() => {
                if (introIndex >= INTRO_SLIDES.length - 1) finishIntro()
                else setIntroIndex((index) => Math.min(INTRO_SLIDES.length - 1, index + 1))
              }}
            >
              {introIndex >= INTRO_SLIDES.length - 1 ? 'Start setup' : 'Next'}
            </button>
          </div>
        </div>
      )}
      {introDone && step !== 'done' && (
        <div className="isl-onb-head">
          <span className="isl-onb-kicker">Setup</span>
          <h1 className="isl-onb-title">Set up Blitz</h1>
          <p className="isl-onb-copy">A few Mac permissions make Blitz useful. You can skip anything and change it later.</p>
        </div>
      )}
      {error && <div className="isl-onb-error">{error}</div>}
      {introDone && step === 'permissions' && state && (
        <div className="isl-onb-card">
          <div className="isl-onb-card-head">
            <span>Mac access</span>
            <span>
              {grantedCount} of {PERMISSIONS.length} granted
            </span>
          </div>
          <div className="isl-onb-perms">
            {PERMISSIONS.map((permission) => {
              const granted = isGranted(state, permission.key)
              const active = activeKind === permission.key && !granted
              return (
                <div key={permission.key} className={`isl-onb-row${granted ? ' granted' : ''}${active ? ' active' : ''}`}>
                  <span className="isl-onb-check" aria-hidden>
                    {granted ? (
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d={CHECK_PATH} />
                      </svg>
                    ) : null}
                  </span>
                  <span className="isl-onb-row-copy">
                    <span className="isl-onb-row-title">{permission.name}</span>
                    <span className="isl-onb-row-note">{permission.why}</span>
                  </span>
                  {granted ? (
                    <span className="isl-onb-row-status">Granted</span>
                  ) : (
                    <button type="button" className="isl-onb-secondary" onClick={() => openPermission(permission.key)}>
                      {active ? 'Reopen' : 'Enable'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {activeKind && (
            <div className="isl-onb-hint">Settings is open. Drag the BlitzOS icon into the permission list, then flip it on.</div>
          )}
          <div className="isl-onb-actions">
            <button type="button" className="isl-onb-primary" onClick={continuePermissions}>
              Continue
            </button>
          </div>
        </div>
      )}
      {introDone && step === 'chromejs' && state && (
        <div className="isl-onb-card">
          <div className="isl-onb-card-head">
            <span>Let Blitz drive Chrome</span>
            <span>{state.browser?.name || 'Chrome'}</span>
          </div>
          <p className="isl-onb-inline-copy">
            Blitz works your Chrome without an extension. Turn on one Chrome setting so it can read and act in your tabs.
          </p>
          <div className="isl-onb-hint">
            Chrome is open at View, Developer. Tick &ldquo;Allow JavaScript from Apple Events&rdquo; and Blitz continues on its own.
          </div>
          <div className="isl-onb-actions">
            <button type="button" className="isl-onb-secondary" onClick={openChromeJs}>
              Reopen menu
            </button>
            <button type="button" className="isl-onb-quiet" onClick={() => skipStep('chromejs')}>
              Not now
            </button>
          </div>
        </div>
      )}
      {introDone && step === 'import' && (
        <div className="isl-onb-card">
          <div className="isl-onb-card-head">
            <span>Bring your browser in</span>
            <span>{accounts.length} profile{accounts.length === 1 ? '' : 's'}</span>
          </div>
          <p className="isl-onb-inline-copy">Pick a Chrome profile to bring Google sign-in and open tabs into reach.</p>
          {!signinResult && (
            <div className="isl-onb-accounts">
              {accounts.map((account) => (
                <button
                  key={`${account.src}:${account.id}`}
                  type="button"
                  className={`isl-onb-account${picked?.src === account.src && picked.id === account.id ? ' on' : ''}`}
                  onClick={() => setPicked({ src: account.src, id: account.id, email: account.email })}
                >
                  <span>{account.email || account.name}</span>
                  {account.email && account.name !== account.email ? <small>{account.name}</small> : null}
                </button>
              ))}
            </div>
          )}
          {signinResult?.ok && <div className="isl-onb-hint good">Signed in as {signinResult.account || 'your Google account'}.</div>}
          {signinResult && !signinResult.ok && <div className="isl-onb-hint">Could not import that sign-in. You can do this later.</div>}
          {browserResult?.status === 'granted' && (
            <div className="isl-onb-hint good">
              {browserResult.tabs ?? 0} tab{(browserResult.tabs ?? 0) === 1 ? '' : 's'} brought in.
            </div>
          )}
          <div className="isl-onb-actions">
            <button type="button" className="isl-onb-primary" disabled={!picked || importing || !!signinResult?.ok} onClick={runImport}>
              {importing ? 'Bringing it in...' : 'Bring it in'}
            </button>
            <button type="button" className="isl-onb-quiet" onClick={() => skipStep('import')}>
              Not now
            </button>
          </div>
        </div>
      )}
      {introDone && step === 'browser' && state && (
        <div className="isl-onb-card">
          <div className="isl-onb-card-head">
            <span>Open tabs</span>
            <span>{state.browser?.name || 'Browser'}</span>
          </div>
          <p className="isl-onb-inline-copy">Blitz can use your open tabs as setup context for what you are already doing.</p>
          {browserResult?.status === 'granted' && (
            <div className="isl-onb-hint good">
              Connected. {browserResult.windows ?? 0} window{(browserResult.windows ?? 0) === 1 ? '' : 's'}, {browserResult.tabs ?? 0} tab
              {(browserResult.tabs ?? 0) === 1 ? '' : 's'}.
            </div>
          )}
          {browserResult && browserResult.status !== 'granted' && <div className="isl-onb-hint">No problem. You can connect it later.</div>}
          <div className="isl-onb-actions">
            <button type="button" className="isl-onb-primary" disabled={connecting || browserResult?.status === 'granted'} onClick={connectBrowser}>
              {connecting ? 'Waiting for macOS...' : `Connect ${state.browser?.name || 'browser'}`}
            </button>
            <button type="button" className="isl-onb-quiet" onClick={() => skipStep('browser')}>
              Not now
            </button>
          </div>
        </div>
      )}
      {introDone && step === 'done' && (
        <div className="isl-onb-intro visual-done">
          <OnboardingDoneHero />
          <div className="isl-onb-head intro">
            <span className="isl-onb-kicker">All set</span>
            <h1 className="isl-onb-title">Blitz is ready</h1>
            <p className="isl-onb-copy">Your agents are standing by. You can change setup anytime from Settings.</p>
          </div>
          <div className="isl-onb-actions">
            <button type="button" className="isl-onb-primary" onClick={onComplete}>
              Open Blitz
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default IslandOnboarding
