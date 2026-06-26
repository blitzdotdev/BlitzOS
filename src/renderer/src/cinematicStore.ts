import { useSyncExternalStore } from 'react'

// External store (no zustand) for the cinematic intro animation. Module-level so it survives component
// remounts and can be triggered from anywhere (the os:action handler in App.tsx).
let active = false
const listeners = new Set<() => void>()
const emit = (): void => { for (const l of listeners) l() }
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export const triggerCinematic   = (): void => { if (!active) { active = true; emit() } }
export const doneCinematic      = (): void => { if (active)  { active = false; emit() } }
export const isCinematicActive  = (): boolean => active
export const useCinematicActive = (): boolean =>
  useSyncExternalStore(subscribe, () => active)
