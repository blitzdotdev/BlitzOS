// Imperative "navigate the island to a view" request. Lets an out-of-tree trigger (the native macOS menu bar →
// main → App) push the island to a view even when NotchHost is ALREADY mounted (a ref-fed initialView only takes
// effect on the next mount). Module-level + a listener set — the stagingStore/draftStore pattern. Renderer-local;
// nothing React-renders from it, so it's a plain fire-and-forget bus, no useSyncExternalStore.
import type { IslandView } from './types'

type Listener = (view: IslandView) => void
type AgentListener = (id: string) => void
const listeners = new Set<Listener>()
const agentListeners = new Set<AgentListener>()
let pendingAgentId: string | null = null

/** Ask the mounted island to switch to `view` now (e.g. App handling the menu's "Show Settings"). */
export function requestIslandView(view: IslandView): void {
  for (const l of listeners) {
    try {
      l(view)
    } catch {
      /* a dead listener must not block the others */
    }
  }
}

/** NotchHost subscribes; returns an unsubscribe. */
export function onIslandViewRequest(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Ask the mounted island to switch to an agent chat. If it is not mounted yet, the latest request is delivered on mount. */
export function requestIslandAgent(id: string): void {
  const next = String(id || '0')
  if (!agentListeners.size) {
    pendingAgentId = next
    return
  }
  pendingAgentId = null
  for (const l of agentListeners) {
    try {
      l(next)
    } catch {
      /* a dead listener must not block the others */
    }
  }
}

/** NotchHost subscribes to notification-click deep links; returns an unsubscribe. */
export function onIslandAgentRequest(listener: AgentListener): () => void {
  agentListeners.add(listener)
  if (pendingAgentId) {
    const id = pendingAgentId
    pendingAgentId = null
    queueMicrotask(() => {
      if (agentListeners.has(listener)) listener(id)
    })
  }
  return () => agentListeners.delete(listener)
}
