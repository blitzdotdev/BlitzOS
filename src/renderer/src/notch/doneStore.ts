import { useSyncExternalStore } from 'react'

// Per-agent "unseen DONE" marks for the at-rest glance bar. An agent that finishes its turn (the RAW host status
// goes working→'watching', or →'idle' with no live terminal) gets a quiet green pip on its avatar in the COLLAPSED
// island until the user opens the island and
// VIEWS that agent (NotchHost clears it). A module-level external store ON PURPOSE (NO zustand — the mandated
// stagingStore.ts pattern): the set-site (App's chat-broadcast handler) and the clear-site (NotchHost's active-tab
// effect) live in different, remounting parts of the tree, so the marks must survive outside any component. The
// snapshot is a STABLE Set ref between changes, so useSyncExternalStore never loops and only re-renders on a real
// change. Ephemeral by design — a "you have a result" notification, not persisted across an app restart.

let doneIds: Set<string> = new Set()
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

// An agent just finished (working→idle). Idempotent; only a real change replaces the ref + notifies subscribers.
export function markDone(id: string): void {
  if (!id || doneIds.has(id)) return
  const next = new Set(doneIds)
  next.add(id)
  doneIds = next
  emit()
}

// The user viewed the agent, or it became active again — drop its mark.
export function clearDone(id: string): void {
  if (!doneIds.has(id)) return
  const next = new Set(doneIds)
  next.delete(id)
  doneIds = next
  emit()
}

// Reconcile to the live roster: drop marks for agents no longer present (closed/archived) so a pip can't outlive its
// agent. `keep(id)` returns true for ids still in the roster.
export function reconcileDone(keep: (id: string) => boolean): void {
  let changed = false
  const next = new Set(doneIds)
  for (const id of doneIds) if (!keep(id)) ((changed = true), next.delete(id))
  if (!changed) return
  doneIds = next
  emit()
}

// Subscribe to the set of agents with an unseen DONE. Stable ref between changes (see header).
export function useDoneAgents(): Set<string> {
  return useSyncExternalStore(subscribe, () => doneIds)
}
