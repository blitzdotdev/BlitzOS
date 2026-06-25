// Imperative "navigate the island to a view" request. Lets an out-of-tree trigger (the native macOS menu bar →
// main → App) push the island to a view even when NotchHost is ALREADY mounted (a ref-fed initialView only takes
// effect on the next mount). Module-level + a listener set — the stagingStore/draftStore pattern. Renderer-local;
// nothing React-renders from it, so it's a plain fire-and-forget bus, no useSyncExternalStore.
import type { IslandView } from './types'

type Listener = (view: IslandView) => void
const listeners = new Set<Listener>()

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
