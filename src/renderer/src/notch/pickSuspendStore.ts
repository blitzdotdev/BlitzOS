// pickSuspendStore — the JIT grant flow SUSPENDS the window picker so the user can click in System Settings and the
// grant card. The picker overlay otherwise intercepts every window click (you can only drag window icons), which is
// exactly what the user hit. The mini-onboarding card sets this; NotchHost reads it to stop + NOT re-arm the picker
// until the card fully closes. Native external store + useSyncExternalStore (no zustand — house rule).
import { useSyncExternalStore } from 'react'

let suspended = false
const listeners = new Set<() => void>()

export function setPickSuspended(v: boolean): void {
  if (v === suspended) return
  suspended = v
  listeners.forEach((l) => l())
}

export function usePickSuspended(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => suspended
  )
}
