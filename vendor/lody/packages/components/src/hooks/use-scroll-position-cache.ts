import type { SessionId } from '@lody/shared';
import { LRUCache } from '@/lib/lru-cache';

/**
 * Scroll position state for a session.
 *
 * Simple approach: store either "at end" or a pixel offset.
 * Updated directly on scroll events, bypassing React lifecycle entirely.
 */
export type ScrollPositionState =
  | { type: 'end' }
  | { type: 'offset'; scrollOffset: number };

const DEFAULT_MAX_CACHE_SIZE = 50;

/**
 * Global LRU cache for scroll positions per session.
 * Module-level singleton that persists across component remounts.
 * Updated directly from scroll handlers - no React lifecycle involvement.
 */
const scrollPositionCache = new LRUCache<SessionId, ScrollPositionState>(DEFAULT_MAX_CACHE_SIZE);

/**
 * Save scroll position state for a session.
 * Call this directly from scroll event handlers.
 */
export function saveScrollPosition(sessionId: SessionId, state: ScrollPositionState): void {
  scrollPositionCache.set(sessionId, state);
}

/**
 * Get cached scroll position state for a session.
 * Returns undefined if no cached state exists (defaults to "end" behavior).
 */
export function getScrollPosition(sessionId: SessionId): ScrollPositionState | undefined {
  return scrollPositionCache.get(sessionId);
}

/**
 * Check if a session has cached scroll position.
 */
export function hasScrollPosition(sessionId: SessionId): boolean {
  return scrollPositionCache.has(sessionId);
}

/**
 * Clear scroll position cache for a specific session.
 */
export function clearScrollPosition(sessionId: SessionId): void {
  scrollPositionCache.delete(sessionId);
}

/**
 * Clear all cached scroll positions.
 */
export function clearAllScrollPositions(): void {
  scrollPositionCache.clear();
}
