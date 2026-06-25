import { useSyncExternalStore } from 'react'

// The onboarding flow's PROGRESS, as a module-level external store. The island chassis (NotchHost + IslandOnboarding)
// remounts on every open/close, so the user's place in the flow — which intro slide, which setup step, whether they
// cleared the permission gate, and the last-known grant state — must live OUTSIDE the component to survive a
// hide+reopen (otherwise reopening drops them back at slide 1). Native React (useSyncExternalStore), NO zustand;
// same pattern as stagingStore. The on-disk preboard marks remain the durable source of truth across an app
// restart — this store is the in-session mirror, refreshed from preboardState() on each open. Reset on completion.

export type DragKind = 'fda' | 'accessibility' | 'screen'
export type StepKey = 'permissions' | 'chromejs' | 'browser' | 'done'
export type Outcome = 'granted' | 'denied' | 'skipped'
export type BrowserResult = { status: 'granted' | 'denied' | 'unavailable'; windows?: number; tabs?: number; browser?: string }
export type PreboardState = {
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

export type OnboardingProgress = {
  introIndex: number // current intro slide
  introDone: boolean // intro finished → in the setup phase
  permissionsDone: boolean // the user cleared the Mac-access gate (Continue)
  step: StepKey
  preboard: PreboardState | null // last-known grant/browser state (refreshed from preboardState on each open)
  browserResult: BrowserResult | null
}

const INITIAL: OnboardingProgress = {
  introIndex: 0,
  introDone: false,
  permissionsDone: false,
  step: 'permissions',
  preboard: null,
  browserResult: null
}

let snap: OnboardingProgress = INITIAL
const listeners = new Set<() => void>()
const emit = (): void => {
  for (const l of listeners) l()
}
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
// Replace snap wholesale on any change so getSnapshot returns a stable ref between changes (no render loop).
const set = (patch: Partial<OnboardingProgress>): void => {
  snap = { ...snap, ...patch }
  emit()
}

export const setIntroIndex = (introIndex: number): void => set({ introIndex })
export const setIntroDone = (introDone: boolean): void => set({ introDone })
export const setPermissionsDone = (permissionsDone: boolean): void => set({ permissionsDone })
export const setOnbStep = (step: StepKey): void => set({ step })
export const setPreboard = (preboard: PreboardState | null): void => set({ preboard })
export const setOnbBrowserResult = (browserResult: BrowserResult | null): void => set({ browserResult })

/** Idempotently flip a TCC permission to granted in the mirrored preboard state (the on-disk mark is written
 *  separately via preboardMark). No-op until preboardState has loaded. */
export const markPreboardGranted = (key: DragKind | string): void => {
  const p = snap.preboard
  if (!p) return
  // Drag grants (fda/accessibility/screen) also flip the live boolean; automation grants live only in `steps`.
  const isDrag = key === 'fda' || key === 'accessibility' || key === 'screen'
  set({ preboard: { ...p, ...(isDrag ? { [key]: true } : {}), steps: { ...p.steps, [key]: 'granted' } } })
}

/** Apply a fresh preboardState() read on island (re)open. It may ADD newly-detected grants, but it must NEVER
 *  downgrade a TCC permission the user already cleared: the live macOS grant check can lag a just-granted
 *  permission (the granted app has to be re-seen), so a plain overwrite makes a hide+reopen revert a green
 *  checkmark to incomplete. Merge instead, so toggling the island never loses progress. */
export const refreshPreboard = (ps: PreboardState): void => {
  const prev = snap.preboard
  if (!prev) {
    set({ preboard: ps })
    return
  }
  // Downgrade-proof by RULE, not by a hardcoded list: a refresh may UPGRADE (add a newly-detected grant) but must
  // never DOWNGRADE a step the user already settled. Preserve any terminal step (granted/skipped) across ALL steps
  // (fda/accessibility/screen/chromejs/browser/anything added later), and OR-merge the three boolean TCC grants. New
  // steps are protected automatically, so a hide+reopen (or forced/dev mode, which returns empty steps) never resets one.
  const steps: Record<string, Outcome | undefined> = { ...ps.steps }
  for (const [k, v] of Object.entries(prev.steps)) {
    if ((v === 'granted' || v === 'skipped') && steps[k] !== 'granted') steps[k] = v
  }
  set({
    preboard: {
      ...ps,
      fda: ps.fda || prev.fda,
      accessibility: ps.accessibility || prev.accessibility,
      screen: ps.screen || prev.screen,
      steps
    }
  })
}

export const resetOnboardingProgress = (): void => set({ ...INITIAL })

/** Read the freshest progress synchronously (for handlers that must not wait for a re-render). */
export const getOnboardingProgress = (): OnboardingProgress => snap

export function useOnboardingProgress(): OnboardingProgress {
  return useSyncExternalStore(subscribe, () => snap)
}
