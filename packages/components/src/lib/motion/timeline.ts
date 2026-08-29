// Minimal, dependency-free keyframe timeline primitive — the substrate for a
// hand-authored ("手 K") animated onboarding. It is intentionally small and
// numeric-only: a timeline is a set of named numeric *tracks*, each a sorted
// list of keyframes. Interpolation, easing, and clamping live here as pure
// functions so they are trivial to unit-test and reuse; the rAF clock that
// drives them lives in `use-timeline.ts`.
//
// Convention: a keyframe's `easing` describes the transition *into* that
// keyframe (i.e. it eases the segment ending at it), matching After Effects /
// Framer semantics.

export type EasingFn = (t: number) => number;

export type EasingName =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeOutQuart'
  | 'easeInOutQuart'
  | 'easeOutQuint'
  | 'easeOutExpo'
  | 'easeInExpo'
  | 'easeInOutExpo'
  | 'easeOutBack'
  | 'easeInOutBack'
  | 'easeOutElastic';

const BACK_C1 = 1.70158;
const BACK_C2 = BACK_C1 * 1.525;
const BACK_C3 = BACK_C1 + 1;
const ELASTIC_C4 = (2 * Math.PI) / 3;

export const EASINGS: Record<EasingName, EasingFn> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 + (t - 1) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 + (t - 1) * (2 * t - 2) * (2 * t - 2)),
  easeOutQuart: (t) => 1 - (1 - t) ** 4,
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - 8 * (1 - t) ** 4),
  easeOutQuint: (t) => 1 - (1 - t) ** 5,
  easeOutExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  easeInExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  easeInOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  // Slight overshoot — gives UI elements a confident "settle".
  easeOutBack: (t) => 1 + BACK_C3 * (t - 1) ** 3 + BACK_C1 * (t - 1) ** 2,
  easeInOutBack: (t) =>
    t < 0.5
      ? ((2 * t) ** 2 * ((BACK_C2 + 1) * 2 * t - BACK_C2)) / 2
      : ((2 * t - 2) ** 2 * ((BACK_C2 + 1) * (2 * t - 2) + BACK_C2) + 2) / 2,
  easeOutElastic: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1,
};

/**
 * Normalized 0→1 progress of `time` across the window `[start, end]`, clamped.
 * The building block for scene-local timing on a shared master clock.
 */
export function progress(time: number, start: number, end: number): number {
  if (end <= start) return time >= end ? 1 : 0;
  const p = (time - start) / (end - start);
  return p <= 0 ? 0 : p >= 1 ? 1 : p;
}

/** `progress` with an easing applied. */
export function ease(
  time: number,
  start: number,
  end: number,
  easing: EasingName = 'easeOutCubic'
): number {
  return EASINGS[easing](progress(time, start, end));
}

/** Linear interpolation. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export type Keyframe = {
  /** Time of this keyframe, in seconds from the start of the timeline. */
  time: number;
  /** Track value at this keyframe. */
  value: number;
  /** Easing for the segment ending at this keyframe. Defaults to `linear`. */
  easing?: EasingName | EasingFn;
};

/** A named set of numeric tracks. */
export type Timeline = Record<string, Keyframe[]>;

function resolveEasing(easing: Keyframe['easing']): EasingFn {
  if (typeof easing === 'function') return easing;
  if (easing && easing in EASINGS) return EASINGS[easing];
  return EASINGS.linear;
}

/**
 * Evaluate a single track at `time` (seconds). Keyframes are assumed sorted by
 * time; the caller owns that invariant (author them in order). Before the first
 * keyframe returns the first value; after the last returns the last value.
 * Returns `0` for an empty track.
 */
export function evaluateTrack(keyframes: readonly Keyframe[], time: number): number {
  if (keyframes.length === 0) return 0;
  const first = keyframes[0]!;
  if (time <= first.time) return first.value;
  const last = keyframes[keyframes.length - 1]!;
  if (time >= last.time) return last.value;

  // Linear scan is fine: onboarding tracks have a handful of keyframes. If a
  // track ever grows large, swap this for a binary search.
  for (let i = 1; i < keyframes.length; i++) {
    const end = keyframes[i]!;
    if (time <= end.time) {
      const start = keyframes[i - 1]!;
      const span = end.time - start.time;
      // Coincident keyframes → step to the end value (avoid divide-by-zero).
      if (span <= 0) return end.value;
      const localT = (time - start.time) / span;
      const eased = resolveEasing(end.easing)(localT);
      return start.value + (end.value - start.value) * eased;
    }
  }
  return last.value;
}

/** Evaluate every track of a timeline at `time`, returning `{ track: value }`. */
export function evaluateTimeline(timeline: Timeline, time: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key in timeline) {
    out[key] = evaluateTrack(timeline[key]!, time);
  }
  return out;
}

/** Duration of a timeline = the latest keyframe time across all tracks (seconds). */
export function timelineDuration(timeline: Timeline): number {
  let max = 0;
  for (const key in timeline) {
    const track = timeline[key]!;
    const last = track[track.length - 1];
    if (last && last.time > max) max = last.time;
  }
  return max;
}
