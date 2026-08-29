import { useLayoutEffect, useRef } from 'react';
import { onFrame, nowSeconds } from './clock';
import { SPRING_SNAPPY, blurIn, type SpringConfig } from './spring';

// Entrance motion written straight to the DOM.
//
// Every one of these used to be `style={blurIn(t, at)}` with `t` coming from a
// 60fps setState — so one moving caption re-rendered the whole tree. Here the
// element animates itself, React renders once, and the animation UNSUBSCRIBES
// when it settles. A step that has finished animating costs zero per frame.
//
// The blur is the expensive part (it forces an offscreen pass), so it is
// dropped to `filter: none` the moment it is imperceptible rather than being
// left at `blur(0.02px)` forever, which keeps the layer on the compositor.

export type EnterOptions = {
  /** Delay before the element starts, in seconds. */
  at?: number;
  /** Vertical travel in px. */
  distance?: number;
  /** Peak blur in px. */
  blur?: number;
  /** Seconds over which the blur resolves. */
  blurDuration?: number;
  spring?: SpringConfig;
};

/** After this the spring is visually at rest, so we stop drawing it. */
const SETTLE_SECONDS = 1.5;

export function useEntrance<T extends HTMLElement>(options: EnterOptions = {}) {
  const ref = useRef<T | null>(null);
  const { at = 0, distance, blur, blurDuration, spring } = options;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const start = nowSeconds();
    const params = { distance, blur, blurDuration, spring: spring ?? SPRING_SNAPPY };

    const apply = (elapsed: number): void => {
      const style = blurIn(elapsed, at, params);
      element.style.opacity = String(style.opacity);
      element.style.transform = style.transform;
      element.style.filter = style.filter;
    };

    // Paint frame zero synchronously, or the element flashes at its resting
    // position for one frame before the animation takes over.
    apply(0);
    element.style.willChange = 'transform, opacity, filter';

    return onFrame((seconds) => {
      const elapsed = seconds - start;
      if (elapsed < at + SETTLE_SECONDS) {
        apply(elapsed);
        return true;
      }
      // Land exactly on the resting values and hand the layer back.
      element.style.opacity = '1';
      element.style.transform = '';
      element.style.filter = '';
      element.style.willChange = '';
      return false;
    });
  }, [at, distance, blur, blurDuration, spring]);

  return ref;
}

/**
 * `<Enter at={0.2}>…</Enter>` — the JSX form. Prefer this over passing a clock
 * value down through props; the whole point is that the parent does not
 * re-render while this moves.
 */
export function Enter({
  at,
  distance,
  blur,
  blurDuration,
  spring,
  className,
  style,
  children,
}: EnterOptions & {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useEntrance<HTMLDivElement>({ at, distance, blur, blurDuration, spring });
  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
