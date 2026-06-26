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

type IntroSlide = { title: string; copy: string; visual: IntroVisual; shortcut?: string }

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

type AutoTarget = 'systemevents' | 'browser'
type PermRow = { key: string; name: string; why: string; auto?: AutoTarget }
const PERMISSIONS: PermRow[] = [
  { key: 'accessibility', name: 'Accessibility', why: 'Lets BlitzOS Automation read and operate apps when you ask.' },
  { key: 'screen', name: 'Screen Recording', why: 'Lets BlitzOS Automation see enough of the screen to click accurately.' }
]
// The gate enforces the two drag grants (Accessibility + Screen Recording) PLUS, when Chrome is the DEFAULT browser, two Automation grants the
// helper needs to drive apps without a usage-time prompt: System Events (the "Allow JavaScript" menu-drive) and
// the browser itself. Obtained up-front in the permission step; gated to Chrome-default since the menu-drive is
// Chrome-only. Their "Enable" fires the helper-held consent (openAutomation), so the grant lands on the helper.
const effectivePermissions = (state: PreboardState): PermRow[] => {
  const b = state.browser
  const rows: PermRow[] = [...PERMISSIONS]
  if (b && b.id === 'com.google.Chrome') {
    rows.push(
      { key: 'automation:systemevents', name: 'System Events', why: 'Lets BlitzOS Automation open menus and drive apps for you.', auto: 'systemevents' },
      { key: 'automation:browser', name: b.name, why: `Lets BlitzOS Automation drive ${b.name} for you.`, auto: 'browser' }
    )
  }
  return rows
}
const CHECK_PATH = 'm5 12 4 4L19 6'
const ALERT_PATH = 'M12 8v5M12 16h.01'
// Padlock glyph for a not-yet-granted permission row (neutral state), drawn in the same 24x24 stroked
// style as the requirement-card icons (shackle + body as two stroked paths).
const LOCK_SHACKLE = 'M9 11V8a3 3 0 0 1 6 0v3'
const LOCK_BODY = 'M7 11h10v8H7z'
const INTRO_SLIDES: IntroSlide[] = [
  {
    title: 'Meet BlitzOS',
    copy: 'One place to manage your agent sessions. Move your mouse to the center of the top of your screen to open BlitzOS, or press',
    shortcut: 'Alt+Space',
    visual: 'home'
  },
  {
    title: 'Put your browser and apps in reach',
    copy: 'Connect a tab or a window, then just ask. Blitz works where you already are and reports back.',
    visual: 'connect'
  },
  {
    title: 'Watch the work unfold',
    copy: 'Blitz breaks large tasks into a workflow you can open as a board. Every step moves from to-do to done.',
    visual: 'workflow'
  },
  {
    title: 'Blitz runs on Claude Code',
    copy: 'BlitzOS uses your existing Claude Code as its agent engine. Make sure it\'s installed before continuing.',
    visual: 'requirement'
  },
]

const isGranted = (state: PreboardState, key: string): boolean => !!(state as Record<string, unknown>)[key] || state.steps[key] === 'granted'
const permissionPending = (state: PreboardState): boolean => effectivePermissions(state).some((permission) => !isGranted(state, permission.key))
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

// Same optional-method bridge for the automation permission rows (Enable → fire the helper-held consent;
// denied → open Privacy ▸ Automation). Optional-typed so a build lacking them no-ops rather than failing.
type OnboardingAutoApi = {
  requestHelperAutomation?: (target: AutoTarget) => Promise<{ granted: boolean; error?: string }>
  openAutomationSettings?: () => Promise<{ ok: boolean }>
  setIslandVeil?: (on: boolean) => void
}
const autoApi = (api: NonNullable<typeof window.agentOS>['onboarding'] | undefined): OnboardingAutoApi | undefined =>
  api as (OnboardingAutoApi & typeof api) | undefined

// JIT permissions (plans/blitzos-jit-permissions.md): onboarding NO LONGER walls the user behind a row of scary
// macOS grants. Every TCC grant is now requested at the moment the user first reaches for the capability that
// needs it (connect a browser tab → Automation; connect an app window → Accessibility + Screen Recording), so a
// fresh launch is just intro → chat with ZERO permission prompts. The 'permissions' / 'chromejs' render branches
// and their grant mechanisms are KEPT — the JIT connection flow reuses them — they're simply not flow steps.
function nextStep(_state: PreboardState, _permissionsDone: boolean): StepKey {
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
  const [activeKind, setActiveKind] = useState<string | null>(null)
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

  // Lock the island's hover open/close ONLY for the drag-out steps (the TCC permission reqs + the Chrome menu
  // step): there the user must move the cursor OUTSIDE the island to System Settings / the menu bar, and a
  // hover-retract would unmount NotchHost and tear down the open flow. During the INTRO slides the island uses
  // NORMAL hover (hover the notch to show/hide) — the auto-open hold in App already prevents the first-frame
  // collapse, so no intro lock is needed. (The old per-slide initialLock reset on every remount and left hover
  // feeling dead during onboarding — the reported bug.)
  useEffect(() => {
    const setupLock = introDone && (step === 'permissions' || step === 'chromejs')
    setOnboardingHoverLock(setupLock)
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

  // An automation permission row's "Enable": the helper fires a benign Apple Event at the target, raising the
  // macOS consent (blocks until the user chooses). Granted → mark it (gate clears); denied/dismissed → open
  // Privacy ▸ Automation so they can flip it on, then re-click Enable. Same Enable/checkmark UI as the drag rows.
  const openAutomation = (target: AutoTarget, key: string): void => {
    setActiveKind(key)
    setError(null)
    // Veil the island so the macOS consent dialog (which lands near the notch) isn't covered by it; bring it back
    // the moment the grant resolves (granted → row flips; denied → row stays + Settings opens).
    autoApi(api)?.setIslandVeil?.(true)
    const unveil = (): void => autoApi(api)?.setIslandVeil?.(false)
    const req = autoApi(api)?.requestHelperAutomation?.(target)
    if (!req) {
      unveil()
      setActiveKind(null)
      setError('Could not reach the BlitzOS helper.')
      return
    }
    req
      .then((r) => {
        unveil()
        setActiveKind(null)
        if (r?.granted) {
          markPreboardGranted(key)
          void api?.preboardMark?.(key, 'granted')
        } else {
          void autoApi(api)?.openAutomationSettings?.()
        }
      })
      .catch(() => {
        unveil()
        setActiveKind(null)
        setError('Could not request automation access.')
      })
  }

  const continuePermissions = (): void => {
    if (!state || permissionPending(state)) return
    setPermissionsDone(true)
    void api?.closePermissionDrag?.()
    goNext(state, true)
  }

  const grantedCount = state ? effectivePermissions(state).filter((permission) => isGranted(state, permission.key)).length : 0
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

  // Skip the "Blitz is ready" card entirely — go straight to chat as soon as setup is done.
  useEffect(() => {
    if (introDone && step === 'done') finishOnboarding()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introDone, step])

  return (
    <div
      className="nh-island isl-onboarding"
      style={{ paddingTop: top }}
    >
      {!introDone && (
        <div className={`isl-onb-intro isl-onb-slide visual-${introSlide.visual}`}>
          <div className="isl-onb-slide-body">
            {introSlide.visual !== 'final' && introSlide.visual !== 'requirement' && (
              <OnboardingVisual key={introIndex} kind={introSlide.visual} />
            )}
          <div className="isl-onb-head intro">
            <h1 className="isl-onb-title">{introSlide.title}</h1>
            <p className="isl-onb-copy">
              {introSlide.copy}
              {introSlide.shortcut && (
                <> <ShortcutKeys accel={introSlide.shortcut} /> to show or hide BlitzOS anytime.</>
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
              {introIndex >= INTRO_SLIDES.length - 1 ? 'Start BlitzOS' : 'Next'}
            </button>
          </div>
          </div>
        </div>
      )}
      {introDone && step !== 'done' && (
        <div className="isl-onb-slide isl-onb-setup">
          <div className="isl-onb-slide-body">
            <div className="isl-onb-head intro">
              <h1 className="isl-onb-title">Set up Blitz</h1>
              <p className="isl-onb-copy">BlitzOS Automation needs all three to work. Grant each one to continue.</p>
            </div>
            {error && <div className="isl-onb-error">{error}</div>}
            {step === 'permissions' && state && (
        <div className="isl-onb-card">
          <div className="isl-onb-card-head">
            <span>Mac access</span>
            <span>
              {grantedCount} of {effectivePermissions(state).length} granted
            </span>
          </div>
          <div className="isl-onb-perms">
            {effectivePermissions(state).map((permission) => {
              const granted = isGranted(state, permission.key)
              const active = activeKind === permission.key && !granted
              const auto = permission.auto
              return (
                <button
                  key={permission.key}
                  type="button"
                  className={`isl-onb-row${granted ? ' granted' : ''}${active ? ' active' : ''}`}
                  onClick={granted ? undefined : auto ? () => openAutomation(auto, permission.key) : () => openPermission(permission.key as DragKind)}
                  disabled={granted}
                >
                  <span className="isl-onb-row-icon" aria-hidden>
                    {granted ? (
                      <svg viewBox="0 0 24 24" focusable="false"><path d={CHECK_PATH} /></svg>
                    ) : active ? (
                      <span className="isl-onb-req-spin" />
                    ) : (
                      <svg viewBox="0 0 24 24" focusable="false">
                        <path d={LOCK_SHACKLE} />
                        <path d={LOCK_BODY} />
                      </svg>
                    )}
                  </span>
                  <span className="isl-onb-row-copy">
                    <span className="isl-onb-row-title">{permission.name}</span>
                    <span className="isl-onb-row-note">{permission.why}</span>
                  </span>
                  {granted ? (
                    <span className="isl-onb-row-status">Granted</span>
                  ) : (
                    <span className="isl-onb-row-cta">{active ? 'Reopen' : 'Enable'}</span>
                  )}
                </button>
              )
            })}
          </div>
          {activeKind && (
            <div className="isl-onb-hint">
              {activeKind.startsWith('automation:')
                ? 'Click “Allow” when macOS asks, so BlitzOS Automation can drive apps for you.'
                : 'Settings is open. Drag the BlitzOS Automation icon into the permission list, then flip it on.'}
            </div>
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
            <span>{chromeJsGranted ? (state.browser?.name || 'Chrome') : 'Let BlitzOS Automation drive Chrome'}</span>
            {!chromeJsGranted && <span>{state.browser?.name || 'Chrome'}</span>}
          </div>
          {chromeJsGranted ? (
            <p className="isl-onb-connected">
              <span className="isl-onb-connected-dot" aria-hidden="true" />
              BlitzOS Automation can now read and act in your tabs.
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
    </div>
  )
}

export default IslandOnboarding
