import { useSyncExternalStore } from 'react'

// Per-agent reasoning-effort level. Backend default is xhigh (RESIDENT_EFFORT); the island lets a user pick a level
// on a BRAND-NEW empty chat only. Picking updates the UI immediately and (debounced) calls the backend, which
// persists it to the agent's meta.json + re-execs the tmux process so the new level takes effect. Module external
// store (useSyncExternalStore, like stagingStore) — NO zustand. Ephemeral: the durable copy is meta.json.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export const DEFAULT_EFFORT: EffortLevel = 'xhigh'
export const EFFORT_LABEL: Record<EffortLevel, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh' }

let levels: Record<string, EffortLevel> = {}
const listeners = new Set<() => void>()
const timers: Record<string, ReturnType<typeof setTimeout>> = {}
const emit = (): void => {
  for (const l of listeners) l()
}

// Persisted per agent so the effort a chat was started at survives an island reopen / app restart — the persistent
// "XHigh reasoning" line at the top of the transcript reads from here (and it stays in sync with meta.effort, which
// this same pick writes). A pre-feature / never-set chat reads the default (xhigh = what it actually runs at).
const KEY = (agentId: string): string => `blitzos.agent.${agentId}.effort`
function read(agentId: string): EffortLevel {
  try {
    const v = window.localStorage.getItem(KEY(agentId))
    return v && (EFFORT_LEVELS as readonly string[]).includes(v) ? (v as EffortLevel) : DEFAULT_EFFORT
  } catch {
    return DEFAULT_EFFORT
  }
}

export function getEffort(agentId: string): EffortLevel {
  return levels[agentId] || read(agentId)
}

// Update the selection immediately; debounce the backend re-exec so a few quick picks in a new chat coalesce into
// one restart. Safe against the send race: the message lives in chat.md, so a re-exec'd agent reads + answers it.
export function setEffort(agentId: string, level: EffortLevel): void {
  if (getEffort(agentId) === level) return
  levels = { ...levels, [agentId]: level }
  try {
    window.localStorage.setItem(KEY(agentId), level)
  } catch {
    /* best-effort persistence */
  }
  emit()
  clearTimeout(timers[agentId])
  timers[agentId] = setTimeout(() => {
    try {
      void window.agentOS?.setAgentEffort?.(agentId, level)
    } catch {
      /* no bridge */
    }
  }, 300)
}

export function useEffort(agentId: string): EffortLevel {
  const snap = (): EffortLevel => getEffort(agentId)
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    snap,
    snap
  )
}
