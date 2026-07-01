import { useSyncExternalStore } from 'react'

// Persisted agent-tab order — the user drags tabs to organize them (browser-style). We store the display order of the
// NON-primary agent ids; Blitz '0' is ALWAYS pinned first and is never stored here. localStorage-backed (V1 targets one
// implicit workspace). Module external store (useSyncExternalStore, like effortStore/workflowStore) — NO zustand.
const KEY = 'blitzos.tabOrder'
let order: string[] | null = null
const listeners = new Set<() => void>()

function load(): string[] {
  if (order) return order
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) || '[]')
    order = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '0') : []
  } catch {
    order = []
  }
  return order
}

export function getTabOrder(): string[] {
  return load()
}

export function setTabOrder(ids: string[]): void {
  const next = ids.filter((x) => typeof x === 'string' && x !== '0') // Blitz '0' is implicit-first, never stored
  if (next.join('') === load().join('')) return
  order = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* best-effort persistence */
  }
  for (const l of listeners) l()
}

export function useTabOrder(): string[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    getTabOrder,
    getTabOrder
  )
}

// Apply the saved order to the live sessions: Blitz '0' first, then agents in the saved order, then any agent NOT yet
// in the saved order (freshly spawned) appended in their natural (creation) order. Array.sort is stable, so unranked
// ties keep their incoming order.
export function orderTabs<T extends { id: string }>(sessions: T[], saved: string[]): T[] {
  const rank = new Map(saved.map((id, i) => [id, i]))
  const blitz = sessions.filter((s) => s.id === '0')
  const rest = sessions.filter((s) => s.id !== '0')
  rest.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
  return [...blitz, ...rest]
}
