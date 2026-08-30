// Analytic spring solver.
//
// Deliberately analytic rather than the usual per-frame numeric integration:
// the ceremony is driven by a seekable master clock, so every visual must be a
// pure function of time. A stateful integrator cannot be scrubbed backwards or
// replayed deterministically; `springAt(t)` can.
//
// Parameters follow the familiar mass-spring-damper model so values port over
// from Framer/react-spring intuition.

export type SpringConfig = {
  /** Higher = snappier. */
  stiffness?: number;
  /** Higher = less oscillation. */
  damping?: number;
  mass?: number;
};

/** Arc-like: quick attack with a small, confident overshoot. */
export const SPRING_SNAPPY: Required<SpringConfig> = { stiffness: 300, damping: 20, mass: 1 };
/** Softer settle, no visible bounce — for large surfaces. */
export const SPRING_SMOOTH: Required<SpringConfig> = { stiffness: 170, damping: 26, mass: 1 };
/** Pronounced overshoot — for small accents only. */
export const SPRING_BOUNCY: Required<SpringConfig> = { stiffness: 340, damping: 14, mass: 1 };

/**
 * Normalized spring displacement at `time` seconds: 0 at t=0, settling to 1.
 * Underdamped configs overshoot past 1 before settling, which is the whole
 * point of using a spring rather than an easing curve.
 */
export function springAt(time: number, config: SpringConfig = {}): number {
  if (time <= 0) return 0;
  const stiffness = config.stiffness ?? SPRING_SNAPPY.stiffness;
  const damping = config.damping ?? SPRING_SNAPPY.damping;
  const mass = config.mass ?? SPRING_SNAPPY.mass;

  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    // Underdamped — oscillates while decaying.
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega0 * time);
    return (
      1 - decay * (Math.cos(omegaD * time) + ((zeta * omega0) / omegaD) * Math.sin(omegaD * time))
    );
  }

  if (zeta === 1) {
    // Critically damped — fastest approach with no overshoot.
    return 1 - Math.exp(-omega0 * time) * (1 + omega0 * time);
  }

  // Overdamped — sum of two decaying exponentials.
  const root = omega0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * omega0 + root;
  const r2 = -zeta * omega0 - root;
  // Solved from x(0) = 0 and x'(0) = 0:
  //   1 + c1 + c2 = 0  and  c1*r1 + c2*r2 = 0
  // giving c1 = r2/(r1-r2), c2 = -r1/(r1-r2). Getting these signs backwards
  // makes x(0) evaluate to 2, i.e. the spring starts past its target.
  const c1 = r2 / (r1 - r2);
  const c2 = -r1 / (r1 - r2);
  return 1 + c1 * Math.exp(r1 * time) + c2 * Math.exp(r2 * time);
}

/**
 * Spring progress for an element that starts at `startTime` on the master
 * clock. Returns 0 before it begins.
 */
export function springFrom(now: number, startTime: number, config?: SpringConfig): number {
  return springAt(now - startTime, config);
}

export type BlurInStyle = {
  opacity: number;
  filter: string;
  transform: string;
};

/**
 * Arc's signature entrance: the element springs up while a gaussian blur
 * resolves. The blur is what makes it read as "coming into focus" rather than
 * merely sliding — and it clears faster than the spring settles, so the motion
 * finishes sharp instead of smearing.
 */
export function blurIn(
  now: number,
  startTime: number,
  options: {
    /** Vertical travel in px. */
    distance?: number;
    /** Peak blur in px. */
    blur?: number;
    /** Seconds over which the blur resolves. */
    blurDuration?: number;
    spring?: SpringConfig;
  } = {}
): BlurInStyle {
  const distance = options.distance ?? 18;
  const maxBlur = options.blur ?? 10;
  const blurDuration = options.blurDuration ?? 0.42;

  const elapsed = now - startTime;
  if (elapsed <= 0) {
    return { opacity: 0, filter: `blur(${maxBlur}px)`, transform: `translateY(${distance}px)` };
  }

  const settle = springAt(elapsed, options.spring ?? SPRING_SNAPPY);
  // Opacity and blur run on their own, faster curve so the text is legible
  // before the spring has finished settling.
  const focus = Math.min(1, elapsed / blurDuration);
  const eased = 1 - (1 - focus) ** 3;

  return {
    opacity: eased,
    filter: `blur(${(1 - eased) * maxBlur}px)`,
    transform: `translateY(${(1 - settle) * distance}px)`,
  };
}

/** How long the springs used here take to become visually still. */
export const SPRING_SETTLE_SECONDS = 1.2;

/**
 * The spring, compiled to a CSS `linear()` timing function.
 *
 * A spring evaluated in JS costs a frame callback for as long as it runs, and
 * every value it writes is a style mutation on the main thread. The same curve
 * expressed as `linear()` is handed to the compositor once and then costs
 * nothing — including the overshoot, which is what `cubic-bezier` cannot
 * express and why CSS transitions usually read as stiff next to real spring
 * motion.
 *
 * Sample count trades curve fidelity against declaration length: 32 points is
 * smooth to the eye for the overshoot ranges used here.
 */
export function springLinear(config: SpringConfig = SPRING_SNAPPY, samples = 32): string {
  const points: string[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const progress = i / samples;
    points.push(springAt(progress * SPRING_SETTLE_SECONDS, config).toFixed(4));
  }
  return `linear(${points.join(',')})`;
}
