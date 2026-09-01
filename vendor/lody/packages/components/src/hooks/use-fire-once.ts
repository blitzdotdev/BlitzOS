import { useCallback, useRef } from 'react';

/**
 * Guards for de-duplicating analytics (or other "fire-once") effects, so each
 * call site doesn't hand-roll its own `useRef` bookkeeping.
 *
 * Three distinct semantics, not interchangeable at a call site:
 * - `useFireOncePerCycle`: a key fires at most once per active cycle. Every key
 *   is forgotten when the cycle ends, so the next one fires again.
 * - `useFireOncePerKey`: the same over the component's whole lifetime.
 *   Revisiting a previously seen key (A → B → A) does NOT re-fire.
 * - `useFireOnKeyChange`: fires whenever the key differs from the previous one.
 *   Revisiting (A → B → A) DOES re-fire A, while consecutive duplicates are
 *   suppressed. Use this when re-selecting the same value is a meaningful event.
 */

/**
 * Returns `shouldFire(key)` → true the first time each distinct key is seen in
 * the current cycle, forgetting every key once `active` goes false.
 *
 * This is the "once per menu open" shape. The reset happens during render, not
 * in an effect, so the guard is already clear by the time any consumer effect
 * reads it — wherever the hook sits in the caller's hook order.
 */
export function useFireOncePerCycle<K = string>(active: boolean): (key: K) => boolean {
  const seenRef = useRef<Set<K>>(new Set());
  const activeRef = useRef(active);
  if (activeRef.current !== active) {
    activeRef.current = active;
    if (!active) seenRef.current.clear();
  }
  return useCallback((key: K) => {
    if (seenRef.current.has(key)) {
      return false;
    }
    seenRef.current.add(key);
    return true;
  }, []);
}

/**
 * Returns `shouldFire(key)` → true only the first time each distinct key is
 * seen. The per-lifetime case of `useFireOncePerCycle`: a cycle that never ends
 * never forgets.
 */
export function useFireOncePerKey<K = string>(): (key: K) => boolean {
  return useFireOncePerCycle<K>(true);
}

/** Returns `shouldFire(key)` → true whenever the key changes from the previous call. */
export function useFireOnKeyChange<K = string>(): (key: K) => boolean {
  const previousRef = useRef<K | null>(null);
  return useCallback((key: K) => {
    if (previousRef.current === key) {
      return false;
    }
    previousRef.current = key;
    return true;
  }, []);
}
