import { useCallback, useEffect, useRef, useState } from 'react';
import { evaluateTimeline, timelineDuration, type Timeline } from './timeline';

export type UseTimelineOptions = {
  /** Start playing immediately on mount. Default `true`. */
  autoPlay?: boolean;
  /** Loop back to 0 when reaching the end. Default `false`. */
  loop?: boolean;
  /** Playback speed multiplier. Default `1`. */
  playbackRate?: number;
  /**
   * Override the timeline duration (seconds). Defaults to the latest keyframe.
   * Useful to hold on the final frame for a beat before looping/completing.
   */
  duration?: number;
  /** Called once when a non-looping timeline reaches its end. */
  onComplete?: () => void;
};

export type TimelineController = {
  /** Current playhead time in seconds. */
  time: number;
  /** Evaluated track values at `time`. */
  values: Record<string, number>;
  playing: boolean;
  duration: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Jump to a specific time (seconds); clamped to `[0, duration]`. */
  seek: (time: number) => void;
  /** Reset to 0 (does not change play state). */
  restart: () => void;
};

/**
 * Drives a `Timeline` with a `requestAnimationFrame` clock and exposes the
 * current playhead + evaluated track values. Frame-rate independent (advances
 * by real elapsed time), pauses cleanly when unmounted, and honours the OS
 * "reduce motion" preference by snapping to the final frame.
 *
 * The clock work per frame is just a subtraction plus `evaluateTimeline`; the
 * heavy visual cost (if any) belongs to whatever consumes `values`.
 */
export function useTimeline(
  timeline: Timeline,
  options: UseTimelineOptions = {}
): TimelineController {
  const { autoPlay = true, loop = false, playbackRate = 1, onComplete } = options;

  const duration = options.duration ?? timelineDuration(timeline);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [time, setTime] = useState(prefersReducedMotion ? duration : 0);
  const [playing, setPlaying] = useState(prefersReducedMotion ? false : autoPlay);

  // Refs the rAF loop reads without re-subscribing every render. `timeRef` is
  // the authoritative playhead — it is only written by the loop / seek /
  // restart, never during render. The rest mirror the latest props and are
  // synced in an effect (writing refs during render is disallowed).
  const timeRef = useRef(time);
  const rateRef = useRef(playbackRate);
  const durationRef = useRef(duration);
  const loopRef = useRef(loop);
  const onCompleteRef = useRef(onComplete);
  const completedRef = useRef(false);

  useEffect(() => {
    rateRef.current = playbackRate;
    durationRef.current = duration;
    loopRef.current = loop;
    onCompleteRef.current = onComplete;
  });

  const play = useCallback(() => {
    completedRef.current = false;
    setPlaying(true);
  }, []);
  const pause = useCallback(() => setPlaying(false), []);
  const toggle = useCallback(() => setPlaying((p) => !p), []);
  const seek = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(next, durationRef.current));
    timeRef.current = clamped;
    setTime(clamped);
  }, []);
  const restart = useCallback(() => {
    completedRef.current = false;
    timeRef.current = 0;
    setTime(0);
  }, []);

  useEffect(() => {
    if (!playing) return undefined;
    let raf = 0;
    let last: number | null = null;

    const tick = (now: number): void => {
      if (last === null) last = now;
      const deltaSeconds = ((now - last) / 1000) * rateRef.current;
      last = now;

      let next = timeRef.current + deltaSeconds;
      const dur = durationRef.current;
      if (next >= dur) {
        if (loopRef.current && dur > 0) {
          next = next % dur;
        } else {
          next = dur;
          timeRef.current = next;
          setTime(next);
          if (!completedRef.current) {
            completedRef.current = true;
            onCompleteRef.current?.();
          }
          setPlaying(false);
          return;
        }
      }
      timeRef.current = next;
      setTime(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  return {
    time,
    values: evaluateTimeline(timeline, time),
    playing,
    duration,
    play,
    pause,
    toggle,
    seek,
    restart,
  };
}
