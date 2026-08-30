export type AnimationFrameScheduler = {
  request: (callback: FrameRequestCallback) => number;
  cancel: (frameId: number) => void;
};

const browserAnimationFrameScheduler: AnimationFrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (frameId) => cancelAnimationFrame(frameId),
};

/**
 * Subscribe to a snapshot source without queueing every intermediate snapshot
 * as a separate React update. A burst keeps only its newest value and publishes
 * it at the next browser frame, which gives rendering real backpressure.
 */
export function subscribeLatestOnAnimationFrame<T>(options: {
  subscribe: (listener: (value: T) => void) => () => void;
  onValue: (value: T) => void;
  initialValue?: T;
  shouldDefer?: (previous: T | undefined, next: T) => boolean;
  scheduler?: AnimationFrameScheduler;
}): () => void {
  const scheduler = options.scheduler ?? browserAnimationFrameScheduler;
  let active = true;
  let frameId: number | null = null;
  let pending: { value: T } | null = null;
  let previousValue = options.initialValue;

  const unsubscribe = options.subscribe((value) => {
    if (!active) return;
    const shouldDefer = options.shouldDefer?.(previousValue, value) ?? true;
    previousValue = value;

    if (!shouldDefer) {
      pending = null;
      if (frameId !== null) {
        scheduler.cancel(frameId);
        frameId = null;
      }
      options.onValue(value);
      return;
    }

    pending = { value };
    if (frameId !== null) return;

    frameId = scheduler.request(() => {
      frameId = null;
      if (!active || pending === null) return;
      const next = pending.value;
      pending = null;
      options.onValue(next);
    });
  });

  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    pending = null;
    if (frameId !== null) {
      scheduler.cancel(frameId);
      frameId = null;
    }
  };
}
