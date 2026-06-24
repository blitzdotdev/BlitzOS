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
export const markPreboardGranted = (kind: DragKind): void => {
  const p = snap.preboard
  if (!p) return
  set({ preboard: { ...p, [kind]: true, steps: { ...p.steps, [kind]: 'granted' } } })
}

export const resetOnboardingProgress = (): void => set({ ...INITIAL })

/** Read the freshest progress synchronously (for handlers that must not wait for a re-render). */
export const getOnboardingProgress = (): OnboardingProgress => snap

export function useOnboardingProgress(): OnboardingProgress {
  return useSyncExternalStore(subscribe, () => snap)
}
