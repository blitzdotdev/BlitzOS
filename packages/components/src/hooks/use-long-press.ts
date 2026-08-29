import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

const DEFAULT_LONG_PRESS_MS = 500;
const DEFAULT_MOVE_THRESHOLD_PX = 10;

export type LongPressHandlers = {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
  /** When the user's pointer leaves the element entirely (e.g. they
     started a horizontal swipe that the swipeable-row gesture took
     over), we treat it as a cancel — otherwise the timer keeps
     ticking and a long-press fires from underneath the swipe. */
  onPointerLeave: (event: ReactPointerEvent) => void;
};

export type UseLongPressOptions = {
  /** Fired once the pointer has stayed within `moveThresholdPx` for
     `delayMs`. Receives nothing — the caller closes over whatever id
     it wants to act on. */
  onLongPress?: () => void;
  /** Disable the gesture entirely (returns no-op handlers) when false.
     Lets callers conditionally enable long-press without restructuring
     the JSX. */
  enabled?: boolean;
  /** Hold duration before the gesture fires. Default 500ms — matches
     iOS's edit-mode threshold. */
  delayMs?: number;
  /** Maximum pointer travel while held; exceeding this cancels.
     Stops a partial swipe / scroll start from accidentally arming the
     long-press. */
  moveThresholdPx?: number;
};

export type UseLongPressResult = {
  handlers: LongPressHandlers | Record<string, never>;
  /** Returns true if `onLongPress` already fired during the current
     gesture. Callers should consult this from their `onClick` and
     skip the regular tap action when it's true — otherwise a
     long-press lands the user on the row AND triggers selection. */
  shouldSwallowClick: () => boolean;
};

/**
 * Press-and-hold gesture for a single element. Designed to coexist
 * with the swipeable-row drag in `mobile-swipeable-row.tsx`: any
 * horizontal motion past `moveThresholdPx` cancels the long-press
 * timer so the drag wins, and any pointerleave (which fires when the
 * gesture lib captures the pointer) does the same.
 *
 * The hook deliberately ignores synthetic mouse events (`pointerType
 * === 'mouse'` still works for desktop / Storybook testing but the
 * primary target is touch). The returned `shouldSwallowClick` is a
 * ref-backed getter so it stays stable across renders — callers can
 * use it in `onClick` without rebuilding the handler on every paint.
 */
export function useLongPress({
  onLongPress,
  enabled = true,
  delayMs = DEFAULT_LONG_PRESS_MS,
  moveThresholdPx = DEFAULT_MOVE_THRESHOLD_PX,
}: UseLongPressOptions): UseLongPressResult {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const shouldSwallowClick = useCallback(() => firedRef.current, []);

  if (!enabled || !onLongPress) {
    return { handlers: {}, shouldSwallowClick };
  }

  const handlers: LongPressHandlers = {
    onPointerDown: (event) => {
      firedRef.current = false;
      startRef.current = { x: event.clientX, y: event.clientY };
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        onLongPress();
      }, delayMs);
    },
    onPointerMove: (event) => {
      if (timerRef.current === null || !startRef.current) return;
      const dx = event.clientX - startRef.current.x;
      const dy = event.clientY - startRef.current.y;
      if (Math.hypot(dx, dy) > moveThresholdPx) {
        clearTimer();
      }
    },
    onPointerUp: () => clearTimer(),
    onPointerCancel: () => clearTimer(),
    onPointerLeave: () => clearTimer(),
  };

  return { handlers, shouldSwallowClick };
}
