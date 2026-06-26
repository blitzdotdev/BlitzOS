import { useSyncExternalStore } from 'react'

// Per-run workflow-board expand state, lifted OUT of IslandPanel's per-mount local state. The island close+reopen
// REMOUNTS IslandPanel, and a per-mount `useState(new Set())` reset re-expanded boards the user had collapsed (the
// same remount-resets-local-state class as the onboarding initialHoverSeen bug). Moving it here (the stagingStore.ts
// module-store + useSyncExternalStore pattern) makes the user's choice survive the remount.
//
// DELIBERATELY in-memory only (no disk): it resets on app relaunch, so a fresh launch still starts every board
// collapsed and the kanban lazy-mount freeze-guard is preserved (no mount-all-on-relaunch).
const expanded = new Map<string, boolean>() // runId -> the user's explicit open(true)/collapsed(false) choice
const autoOpened = new Set<string>() // runIds already auto-expanded once (so a later manual collapse sticks)
const listeners = new Set<() => void>()
let version = 0
const emit = (): void => {
  version++
  listeners.forEach((l) => l())
}

export function isRunExpanded(runId: string): boolean {
  return expanded.get(runId) === true
}
export function setRunExpanded(runId: string, open: boolean): void {
  if (expanded.get(runId) === open) return
  expanded.set(runId, open)
  emit()
}
export function toggleRunExpanded(runId: string): void {
  setRunExpanded(runId, !isRunExpanded(runId))
}
export function hasAutoOpened(runId: string): boolean {
  return autoOpened.has(runId)
}
export function markAutoOpened(runId: string): void {
  autoOpened.add(runId)
}
// A monotonic version counter; reading it subscribes the component so it re-reads isRunExpanded for the ids it renders.
export function useWfExpandVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => version
  )
}
