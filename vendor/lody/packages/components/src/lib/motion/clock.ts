// One requestAnimationFrame loop for the whole overlay, and — more importantly
// — a loop that STOPS.
//
// The onboarding used to drive its motion by calling setState on a rAF, which
// re-rendered the entire ceremony tree 60 times a second: three WebGL shader
// wrappers, the real Lody components, the lot. That is what made it drop frames
// and heat the machine, and it kept costing that even when nothing on screen
// was moving.
//
// Subscribers here return `false` when they are done, which unsubscribes them.
// When the last one leaves, the rAF is cancelled and the overlay costs nothing
// but the shaders. Animations are expected to settle and let go.

/** Return `false` to unsubscribe. Anything else keeps the subscription. */
export type FrameFn = (seconds: number) => boolean | void;

const subscribers = new Set<FrameFn>();
let rafId = 0;
let originMs = 0;

function tick(nowMs: number): void {
  rafId = 0;
  if (originMs === 0) originMs = nowMs;
  const seconds = (nowMs - originMs) / 1000;
  // Copy first: a subscriber may unsubscribe itself (or others) mid-tick.
  for (const fn of [...subscribers]) {
    if (fn(seconds) === false) subscribers.delete(fn);
  }
  if (subscribers.size > 0) rafId = requestAnimationFrame(tick);
}

/** Seconds since the clock first ran. Monotonic across the overlay's life. */
export function nowSeconds(): number {
  if (originMs === 0) return 0;
  return (performance.now() - originMs) / 1000;
}

export function onFrame(fn: FrameFn): () => void {
  if (originMs === 0) originMs = performance.now();
  subscribers.add(fn);
  if (rafId === 0) rafId = requestAnimationFrame(tick);
  return () => {
    subscribers.delete(fn);
    if (subscribers.size === 0 && rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };
}

/** For tests and diagnostics: how many animations are currently running. */
export function activeFrameSubscribers(): number {
  return subscribers.size;
}
