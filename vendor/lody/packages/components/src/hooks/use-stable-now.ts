import { useSyncExternalStore } from 'react';

/**
 * Returns a `Date` that updates at most once per `intervalMs` (default 60 s).
 *
 * Using this hook instead of bare `new Date()` at render time avoids
 * unnecessary recalculation of relative-time labels on every re-render
 * and keeps the reference stable between intervals, which helps
 * downstream `useMemo` / `React.memo` bail out.
 *
 * All consumers with the same `intervalMs` share one interval timer and one
 * snapshot, so leaf components (e.g. every sidebar row's time label) can each
 * subscribe without paying a timer per row — and a tick re-renders only the
 * subscribed leaves instead of the list that used to own the `now` state.
 */
type StableNowTicker = {
  snapshot: Date;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  subscribe: (onStoreChange: () => void) => () => void;
};

const tickers = new Map<number, StableNowTicker>();

function getTicker(intervalMs: number): StableNowTicker {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const next: StableNowTicker = {
      snapshot: new Date(),
      listeners: new Set(),
      timer: null,
      subscribe: (onStoreChange) => {
        next.listeners.add(onStoreChange);
        if (next.timer === null) {
          // The snapshot may be stale if every listener unsubscribed since the
          // last tick; a reactivating consumer expects a fresh "now".
          next.snapshot = new Date();
          next.timer = setInterval(() => {
            next.snapshot = new Date();
            next.listeners.forEach((listener) => listener());
          }, intervalMs);
        }
        return () => {
          next.listeners.delete(onStoreChange);
          if (next.listeners.size === 0 && next.timer !== null) {
            clearInterval(next.timer);
            next.timer = null;
          }
        };
      },
    };
    tickers.set(intervalMs, next);
    ticker = next;
  }
  return ticker;
}

export function useStableNow(intervalMs = 60_000): Date {
  const ticker = getTicker(intervalMs);
  return useSyncExternalStore(
    ticker.subscribe,
    () => ticker.snapshot,
    () => ticker.snapshot
  );
}
