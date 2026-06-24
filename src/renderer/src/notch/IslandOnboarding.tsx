import './island.css'
import { useEffect, useRef, useState } from 'react'
import { OnboardingVisual, OnboardingDoneHero, type IntroVisual } from './onboardingVisuals'
import { setOnboardingHoverLock } from './onboardingHoverLock'
import {
  useOnboardingProgress,
  getOnboardingProgress,
  setIntroIndex,
  setIntroDone,
  setPermissionsDone,
  setOnbStep,
  setPreboard,
  refreshPreboard,
  markPreboardGranted,
  resetOnboardingProgress,
  type DragKind,
  type StepKey,
  type PreboardState
} from './onboardingStore'

type IntroSlide = { eyebrow: string; title: string; copy: string; visual: IntroVisual; shortcut?: string }

const accelCaps = (accel: string): string[] =>
  accel.split('+').map((p) => {
    if (p === 'Command' || p === 'Cmd' || p === 'Meta' || p === 'Super') return '⌘'
    if (p === 'Control' || p === 'Ctrl') return '⌃'
    if (p === 'Alt' || p === 'Option') return '⌥'
    if (p === 'Shift') return '⇧'
    return p
  })

function ShortcutKeys({ accel }: { accel: string }): JSX.Element {
  const caps = accelCaps(accel)
  return (
    <span className="isl-shortcut-keys" aria-label={caps.join(' ')}>
      {caps.map((cap, i) => (
        <kbd key={i} className="isl-kbd">
          {cap}
        </kbd>
      ))}
    </span>
  )
}

const PERMISSIONS: Array<{ key: DragKind; name: string; why: string }> = [
  { key: 'fda', name: 'Full Disk Access', why: 'Lets Blitz build local context from your Mac.' },
  { key: 'accessibility', name: 'Accessibility', why: 'Lets Blitz read and operate apps when you ask.' },
  { key: 'screen', name: 'Screen Recording', why: 'Lets Blitz see enough of the screen to click accurately.' }
]
const CHECK_PATH = 'm5 12 4 4L19 6'
const ALERT_PATH = 'M12 8v5M12 16h.01'
const INTRO_SLIDES: IntroSlide[] = [
  {
    eyebrow: 'Welcome',
    title: 'Meet BlitzOS - your agents on dial',
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
    eyebrow: 'Requirements',
    title: 'Blitz runs on Claude Code',
    copy: 'Blitz uses Claude Code as its agent engine — make sure it’s installed to continue. Codex support is coming soon.',
    visual: 'requirement'
  },
  {
    eyebrow: 'Quick access',
    title: 'Open Blitz whenever you need it',
    copy: 'to show or hide the island anytime — or glide your cursor up to the notch to peek in, and away to tuck it back. You can rebind the shortcut in Settings.',
    shortcut: 'Alt+Space',
    visual: 'notch'
  },
]

const isGranted = (state: PreboardState, key: DragKind): boolean => !!state[key] || state.steps[key] === 'granted'
const permissionPending = (state: PreboardState): boolean => PERMISSIONS.some((permission) => !isGranted(state, permission.key))
// The Chrome "Allow JavaScript from Apple Events" step only applies to Google Chrome (the View ▸ Developer
// row + the bridge target are Chrome-specific). No Chrome detected → skip the step entirely.
const CHROME_BROWSER_ID = 'com.google.Chrome'
const wantsChromeJs = (state: PreboardState): boolean => state.browser?.id === CHROME_BROWSER_ID

// Forward-compatible bridge: the Chrome-JS IPC lives in main (onboarding.ts) and its preload bindings in
// src/preload/index.ts; access them through an optional-typed cast so this stays robust even if a build lacks
// them (no-ops rather than failing to compile). NOT a hack — the methods are genuinely optional.
type OnboardingChromeJsApi = {
  openChromeJsStep?: (force?: boolean) => Promise<{ ok: boolean }>
  closeChromeJsStep?: (immediate?: boolean) => Promise<{ ok: boolean }>
  onChromeJsGranted?: (cb: () => void) => () => void
  onChromeJsWaitingProfile?: (cb: () => void) => () => void
  onChromeJsReady?: (cb: () => void) => () => void
}
const chromeJsApi = (api: NonNullable<typeof window.agentOS>['onboarding'] | undefined): OnboardingChromeJsApi | undefined =>
  api as (OnboardingChromeJsApi & typeof api) | undefined

function nextStep(state: PreboardState, permissionsDone: boolean): StepKey {
  if (!permissionsDone && permissionPending(state)) return 'permissions'
  // Chrome JS bridge sits immediately after the Mac permissions (it depends on the Automation/AX grants).
  if (wantsChromeJs(state) && !state.steps.chromejs) return 'chromejs'
  return 'done'
}

export function IslandOnboarding({
  menuBarH,
  onComplete,
  onHoldOpen
}: {
  menuBarH: number
  onComplete: () => void
  onHoldOpen?: () => void
}): JSX.Element {
  const api = window.agentOS?.onboarding
  const top = Math.max(28, menuBarH) + 8
  // Progress lives in a module store so a hide+reopen (which remounts this component) resumes where the user was,
  // instead of snapping back to the first intro slide. Transient UI (drag/connect/error) is fine as local state.
  const { introIndex, introDone, permissionsDone, step, preboard: state } = useOnboardingProgress()
  const [activeKind, setActiveKind] = useState<DragKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  // When Chrome is quit, main launches it (profile picker appears) and fires chromejs-waiting-profile.
  // We show a "click your profile" prompt until chromejs-ready fires (Chrome has a window, helper is showing).
  const [chromeJsWaiting, setChromeJsWaiting] = useState(false)
  // Flips true the moment main detects the toggle — the card shows a "connected" signal and a Next button
  // (we DON'T auto-advance, so the user sees the positive confirmation and continues on their own).
  const [chromeJsGranted, setChromeJsGranted] = useState(false)
  // Claude Code (the agent engine) install check for the Requirements slide. null = still checking.
  const [claude, setClaude] = useState<{ installed: boolean; path: string | null } | null>(null)
  const [claudeRechecking, setClaudeRechecking] = useState(false)
  // The browser step auto-advances after a short delay; hold the timer so a manual nav (skip) or unmount cancels it.
  const advanceTimer = useRef<number | null>(null)
  const clearAdvance = (): void => {
    if (advanceTimer.current != null) {
      clearTimeout(advanceTimer.current)
      advanceTimer.current = null
    }
  }

  // The gate defaults to the LIVE store value (default params evaluate per call), NOT the render-closure
  // `permissionsDone` — so an event listener registered with [] deps (e.g. onChromeJsGranted) can never recompute the
  // step from a stale first-render gate and bounce the user back to a step they already passed.
  const goNext = (nextState: PreboardState, permsDone = getOnboardingProgress().permissionsDone): void => {
    clearAdvance()
    setActiveKind(null)
    setError(null)
    setOnbStep(nextStep(nextState, permsDone))
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
      setOnbStep('done')
      return
    }
    // Refresh the real grant/browser state on every open (idempotent) and recompute the setup step from it +
    // the (restored) permissions-gate flag — so reopening lands on the right step with live grant checkmarks.
    api
      .preboardState()
      .then((nextState) => {
        if (!alive) return
        const ps = nextState as PreboardState
        refreshPreboard(ps)
        // Recompute the step from the MERGED state (refreshPreboard never downgrades a granted permission), not the
        // raw fetch, so a lagging live grant check can't bounce the user to an earlier step when the island reopens.
        const merged = getOnboardingProgress().preboard ?? ps
        setOnbStep(nextStep(merged, getOnboardingProgress().permissionsDone))
      })
      .catch(() => {
        if (!alive) return
        setError('Setup is unavailable right now.')
        setOnbStep('done')
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
      markPreboardGranted(kind)
    })
  }, [])

  // Each intro slide / setup step resizes the chassis (e.g. the text-only slides drop the 200px visual stage); ask
  // App to hold the island open across the resize so a step change never closes it out from under the cursor. A
  // genuine hover-away still dismisses it once the hold lapses (normal hover behaviour is preserved).
  const holdOpenRef = useRef(onHoldOpen)
  holdOpenRef.current = onHoldOpen
  useEffect(() => {
    holdOpenRef.current?.()
  }, [introIndex, step])

  useEffect(() => {
    window.agentOS?.activity?.track('onboarding.step_viewed', {
      step: introDone ? step : 'intro',
      count: introDone ? undefined : introIndex + 1,
      total: introDone ? undefined : INTRO_SLIDES.length,
      source: 'renderer'
    })
  }, [introDone, introIndex, step])

  // Probe Claude Code on open (cached, cheap) for the Requirements slide.
  useEffect(() => {
    if (!api?.claudeStatus) {
      setClaude({ installed: false, path: null })
      return
    }
    api
      .claudeStatus()
      .then((s) => {
        if (s) setClaude(s)
      })
      .catch(() => setClaude({ installed: false, path: null }))
  }, [])

  // ---- Chrome "Allow JavaScript from Apple Events" step (Chrome-only; sits right after the Mac permissions) ----
  // Open View ▸ Developer + float the helper at the row; main's probe pushes chromejs-granted once the user ticks it.
  const openChromeJs = (force = false): void => {
    setError(null)
    const request = chromeJsApi(api)?.openChromeJsStep?.(force)
    if (!request) {
      // Bindings absent (or non-macOS): let the user move past rather than trapping them here.
      setError('Could not open the Chrome helper. You can enable this later in Chrome ▸ View ▸ Developer.')
      return
    }
    request
      .then((result) => {
        if (!result?.ok) setError('Could not open the Chrome helper.')
      })
      .catch(() => setError('Could not open the Chrome helper.'))
  }
  const skipChromeJs = (): void => {
    if (!state) return
    void chromeJsApi(api)?.closeChromeJsStep?.(true) // user skip → tear down immediately
    void api?.preboardMark?.('chromejs', 'skipped')
    const next: PreboardState = { ...state, steps: { ...state.steps, chromejs: 'skipped' } }
    setPreboard(next)
    goNext(next)
  }
  // User clicks Next on the "connected" card → advance off the freshest (granted) state.
  const continueFromChromeJs = (): void => {
    const cur = getOnboardingProgress().preboard ?? state
    if (!cur) return
    goNext(cur)
  }
  // Main pushes chromejs-granted the moment its file-watch sees the toggle land. We DON'T auto-advance: mark
  // it granted in the store and flip the card to a "connected" signal so the user gets clear positive feedback,
  // then they click Next. The island is hover-locked open through this step, so this is always visible.
  useEffect(() => {
    const onGranted = chromeJsApi(api)?.onChromeJsGranted
    if (!onGranted) return undefined
    return onGranted(() => {
      void api?.preboardMark?.('chromejs', 'granted')
      const cur = getOnboardingProgress().preboard
      if (cur) setPreboard({ ...cur, steps: { ...cur.steps, chromejs: 'granted' } })
      setChromeJsWaiting(false)
      setChromeJsGranted(true)
    })
  }, [])
  // Chrome was quit — profile picker is showing. Tell the user to click a profile.
  useEffect(() => {
    const onWaiting = chromeJsApi(api)?.onChromeJsWaitingProfile
    if (!onWaiting) return undefined
    return onWaiting(() => setChromeJsWaiting(true))
  }, [])
  // Profile was chosen and Chrome has a window — helper window is now showing at View > Developer.
  useEffect(() => {
    const onReady = chromeJsApi(api)?.onChromeJsReady
    if (!onReady) return undefined
    return onReady(() => setChromeJsWaiting(false))
  }, [])
  // Auto-open the Chrome helper on entry to the chromejs step (one row, so open it for them); close it on leave.
  useEffect(() => {
    if (step !== 'chromejs') {
      setChromeJsWaiting(false)
      setChromeJsGranted(false)
      return undefined
    }
    openChromeJs()
    return () => {
      setChromeJsWaiting(false)
      void chromeJsApi(api)?.closeChromeJsStep?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // The TCC permission step (3 reqs) locks the island's hover open/close: the user drags the BlitzOS icon out to
  // System Settings, so only ⌥Space should toggle it (App's hover handler reads this lock). Cleared on leave/unmount.
  useEffect(() => {
    // Lock ONLY on the actual 3-reqs card: the store defaults step to 'permissions' during the intro carousel too,
    // so gate on introDone or the whole intro would wrongly lock hover.
    // Lock the island open for BOTH steps where the user must act OUTSIDE it: the permission drag AND the
    // Chrome menu step (cursor goes up to the menu bar). Without this the island retracts on hover-away,
    // unmounts NotchHost, and the cleanup tears down the open Chrome menu (the disappearing-menu bug).
    setOnboardingHoverLock(introDone && (step === 'permissions' || step === 'chromejs'))
    return () => setOnboardingHoverLock(false)
  }, [introDone, step])

  const recheckClaude = (): void => {
    if (!api?.claudeStatus || claudeRechecking) return
    setClaudeRechecking(true)
    api
      .claudeStatus(true) // bust the cache — the user may have just installed it
      .then((s) => {
        if (s) setClaude(s)
      })
      .catch(() => {})
      .finally(() => setClaudeRechecking(false))
  }
  const downloadClaude = (): void => {
    void window.agentOS?.openExternalUrl?.('https://claude.com/claude-code')
  }

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
    if (!state || permissionPending(state)) return
    setPermissionsDone(true)
    void api?.closePermissionDrag?.()
    goNext(state, true)
  }

  const grantedCount = state ? PERMISSIONS.filter((permission) => isGranted(state, permission.key)).length : 0
  const introSlide = INTRO_SLIDES[introIndex] ?? INTRO_SLIDES[0]
  const finishIntro = (): void => {
    setIntroDone(true)
    if (state) setOnbStep(nextStep(state, permissionsDone))
  }
  const finishOnboarding = (): void => {
    window.agentOS?.activity?.track('onboarding.completed', { source: 'renderer' })
    resetOnboardingProgress()
    onComplete()
  }

  return (
    <div className="nh-island isl-onboarding" style={{ paddingTop: top }}>
      {!introDone && (
        <div className={`isl-onb-intro isl-onb-slide visual-${introSlide.visual}`}>
          <div className="isl-onb-slide-body">
            {introSlide.visual !== 'final' && introSlide.visual !== 'requirement' && (
              <OnboardingVisual key={introIndex} kind={introSlide.visual} />
            )}
          <div className="isl-onb-head intro">
            <span className="isl-onb-kicker">{introSlide.eyebrow}</span>
            <h1 className="isl-onb-title">{introSlide.title}</h1>
            <p className="isl-onb-copy">
              {introSlide.shortcut ? (
                <>
                  Press <ShortcutKeys accel={introSlide.shortcut} /> {introSlide.copy}
                </>
              ) : (
                introSlide.copy
              )}
            </p>
          </div>
          {introSlide.visual === 'requirement' && (
            <div className="isl-onb-req">
              <div className={`isl-onb-req-row${claude == null ? '' : claude.installed ? ' ok' : ' warn'}`}>
                <span className="isl-onb-req-icon" aria-hidden>
                  {claude == null ? (
                    <span className="isl-onb-req-spin" />
                  ) : (
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d={claude.installed ? CHECK_PATH : ALERT_PATH} />
                    </svg>
                  )}
                </span>
                <span className="isl-onb-req-copy">
                  <span className="isl-onb-req-name">Claude Code</span>
                  <span className="isl-onb-req-note">
                    {claude == null ? 'Checking…' : claude.installed ? 'Installed and ready' : 'Not found — install it to run agents'}
                  </span>
                </span>
                {claude == null ? null : claude.installed ? (
                  <span className="isl-onb-req-status ok">Ready</span>
                ) : (
                  <span className="isl-onb-req-actions">
                    <button type="button" className="isl-onb-secondary" onClick={downloadClaude}>
                      Download
                    </button>
                    <button type="button" className="isl-onb-quiet" onClick={recheckClaude} disabled={claudeRechecking}>
                      {claudeRechecking ? 'Checking…' : 'Re-check'}
                    </button>
                  </span>
                )}
              </div>
              <div className="isl-onb-req-row soon">
                <span className="isl-onb-req-icon" aria-hidden>
                  <svg viewBox="0 0 24 24" focusable="false">
                    <circle cx="12" cy="12" r="8" />
                    <path d="M12 8v4l2.5 1.5" />
                  </svg>
                </span>
                <span className="isl-onb-req-copy">
                  <span className="isl-onb-req-name">Codex</span>
                  <span className="isl-onb-req-note">Coming soon</span>
                </span>
                <span className="isl-onb-req-status soon">Soon</span>
              </div>
            </div>
          )}
          </div>
          <div className="isl-onb-slide-foot">
          <div className="isl-onb-progress" aria-label={`Intro slide ${introIndex + 1} of ${INTRO_SLIDES.length}`}>
            {INTRO_SLIDES.map((_slide, index) => (
              <button
                key={index}
                type="button"
                className={index === introIndex ? 'on' : ''}
                aria-label={`Go to slide ${index + 1}`}
                onClick={() => setIntroIndex(index)}
              />
            ))}
          </div>
          <div className="isl-onb-actions">
            {introIndex > 0 && (
              <button type="button" className="isl-onb-quiet" onClick={() => setIntroIndex(Math.max(0, introIndex - 1))}>
                Back
              </button>
            )}
            <button
              type="button"
              className="isl-onb-primary"
              onClick={() => {
                if (introIndex >= INTRO_SLIDES.length - 1) finishIntro()
                else setIntroIndex(Math.min(INTRO_SLIDES.length - 1, introIndex + 1))
              }}
            >
              {introIndex >= INTRO_SLIDES.length - 1 ? 'Start setup' : 'Next'}
            </button>
          </div>
          </div>
        </div>
      )}
      {introDone && step !== 'done' && (
        <div className="isl-onb-slide isl-onb-setup">
          <div className="isl-onb-slide-body">
            <div className="isl-onb-head intro">
              <span className="isl-onb-kicker">Setup</span>
              <h1 className="isl-onb-title">Set up Blitz</h1>
              <p className="isl-onb-copy">Blitz needs all three to work. Grant each one to continue.</p>
            </div>
            {error && <div className="isl-onb-error">{error}</div>}
            {step === 'permissions' && state && (
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
                <button
                  key={permission.key}
                  type="button"
                  className={`isl-onb-row${granted ? ' granted' : ''}${active ? ' active' : ''}`}
                  onClick={granted ? undefined : () => openPermission(permission.key)}
                  disabled={granted}
                >
                  <span className="isl-onb-row-copy">
                    <span className="isl-onb-row-title">{permission.name}</span>
                    <span className="isl-onb-row-note">{permission.why}</span>
                  </span>
                  {granted ? (
                    <span className="isl-onb-row-tag" aria-hidden>
                      <svg viewBox="0 0 24 24" width="10" height="10" focusable="false"><path d={CHECK_PATH} /></svg>
                      Granted
                    </span>
                  ) : (
                    <span className="isl-onb-row-cta">{active ? 'Reopen' : 'Enable'}</span>
                  )}
                </button>
              )
            })}
          </div>
          {activeKind && (
            <div className="isl-onb-hint">Settings is open. Drag the BlitzOS icon into the permission list, then flip it on.</div>
          )}
          <div className="isl-onb-actions">
            <button type="button" className="isl-onb-primary" onClick={continuePermissions} disabled={!state || permissionPending(state)}>
              Continue
            </button>
          </div>
        </div>
      )}
            {step === 'chromejs' && state && (
        <div className="isl-onb-card">
          <div className="isl-onb-card-head">
            <span>{chromeJsGranted ? 'Chrome connected' : 'Let Blitz drive Chrome'}</span>
            <span>{state.browser?.name || 'Chrome'}</span>
          </div>
          {chromeJsGranted ? (
            <p className="isl-onb-connected">
              <span className="isl-onb-connected-dot" aria-hidden="true" />
              Connected. Blitz can now read and act in your Chrome tabs.
            </p>
          ) : chromeJsWaiting ? (
            <p className="isl-onb-profile-cta">
              Click your Chrome profile in the window that just opened.
            </p>
          ) : (
            <p className="isl-onb-profile-cta">
              Tick &ldquo;Allow JavaScript from Apple Events&rdquo; in the Chrome menu.
            </p>
          )}
          <div className="isl-onb-actions">
            {chromeJsGranted ? (
              <button type="button" className="isl-onb-primary" onClick={continueFromChromeJs}>
                Next
              </button>
            ) : (
              <>
                {!chromeJsWaiting && (
                  <button type="button" className="isl-onb-secondary" onClick={() => openChromeJs(true)}>
                    Reopen menu
                  </button>
                )}
                <button type="button" className="isl-onb-quiet" onClick={skipChromeJs}>
                  Not now
                </button>
              </>
            )}
          </div>
        </div>
            )}
          </div>
        </div>
      )}
      {introDone && step === 'done' && (
        <div className="isl-onb-intro isl-onb-slide visual-done">
          <div className="isl-onb-slide-body">
            <OnboardingDoneHero />
            <div className="isl-onb-head intro">
              <span className="isl-onb-kicker">All set</span>
              <h1 className="isl-onb-title">Blitz is ready</h1>
              <p className="isl-onb-copy">Your agents are standing by. You can change setup anytime from Settings.</p>
            </div>
          </div>
          <div className="isl-onb-slide-foot">
            <div className="isl-onb-actions">
              <button type="button" className="isl-onb-primary" onClick={finishOnboarding}>
                Open Blitz
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default IslandOnboarding
