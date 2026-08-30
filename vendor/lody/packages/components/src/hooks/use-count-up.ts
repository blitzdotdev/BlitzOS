import { useEffect, useRef, useState } from 'react';

/* Ease-out cubic: fast start, gentle settle — the classic "counter
   spinning up and landing" feel. Linear felt mechanical; ease-out
   gives the number weight as it arrives at the final value. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export type UseCountUpOptions = {
  /** Tween duration in ms. Defaults to 900 — long enough to read as a
     deliberate count-up, short enough not to feel sluggish. */
  durationMs?: number;
  /** When false, the hook reports `target` verbatim with no animation
     (e.g. value not ready yet, or animation gated off). Flipping it
     true kicks off a count from the last reported value to `target`. */
  enabled?: boolean;
};

/**
 * Animate a number toward `target` with an ease-out tween, driven by
 * `requestAnimationFrame`. Returns the current in-flight value; the
 * caller formats it for display each render (so the same hook works
 * for token counts, currency, percentages, etc.).
 *
 * Behavior:
 * - First time `enabled` is true with a non-zero target, counts up
 *   from 0 — the "impactful entrance" the stats page wants.
 * - When `target` changes mid-life (e.g. the user flips the usage
 *   range tab), re-tweens from the currently-displayed value to the
 *   new target, so switching ranges visibly re-counts.
 * - Honors `prefers-reduced-motion`: snaps straight to `target`.
 *
 * rAF's own timestamp drives the clock (not `Date.now()`), so this is
 * purely local animation timing — no calibrated-time concerns.
 */
export function useCountUp(target: number, options?: UseCountUpOptions): number {
  const durationMs = options?.durationMs ?? 900;
  const enabled = options?.enabled ?? true;

  const [value, setValue] = useState(enabled ? 0 : target);
  /* Last value we actually rendered — the tween's starting point when
     `target` changes. Kept in a ref so the rAF loop reads the latest
     without re-subscribing. */
  const displayedRef = useRef(enabled ? 0 : target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || prefersReducedMotion()) {
      displayedRef.current = target;
      setValue(target);
      return undefined;
    }

    const from = displayedRef.current;
    const to = target;
    if (from === to) {
      setValue(to);
      return undefined;
    }

    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const elapsed = ts - startTs;
      const progress = Math.min(1, elapsed / durationMs);
      const current = from + (to - from) * easeOutCubic(progress);
      displayedRef.current = current;
      setValue(current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        displayedRef.current = to;
        setValue(to);
      }
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, durationMs, enabled]);

  return value;
}
