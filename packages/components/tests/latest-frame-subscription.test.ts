import { describe, expect, it } from 'vitest';
import {
  subscribeLatestOnAnimationFrame,
  type AnimationFrameScheduler,
} from '../src/lib/latest-frame-subscription';

function createHarness<T>() {
  let listener: ((value: T) => void) | null = null;
  let nextFrameId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  let unsubscribed = false;

  const scheduler: AnimationFrameScheduler = {
    request: (callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancel: (frameId) => {
      cancelled.push(frameId);
      frames.delete(frameId);
    },
  };

  return {
    scheduler,
    subscribe: (nextListener: (value: T) => void) => {
      listener = nextListener;
      return () => {
        unsubscribed = true;
        listener = null;
      };
    },
    emit: (value: T) => listener?.(value),
    flushFrame: () => {
      const frame = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!frame) return;
      frames.delete(frame[0]);
      frame[1](0);
    },
    pendingFrameCount: () => frames.size,
    cancelledFrameIds: () => cancelled,
    wasUnsubscribed: () => unsubscribed,
  };
}

describe('subscribeLatestOnAnimationFrame', () => {
  it('turns a large snapshot burst into one delivery of the latest state', () => {
    const harness = createHarness<number>();
    const delivered: number[] = [];
    const unsubscribe = subscribeLatestOnAnimationFrame({
      subscribe: harness.subscribe,
      onValue: (value) => delivered.push(value),
      scheduler: harness.scheduler,
    });

    for (let value = 1; value <= 3_140; value += 1) {
      harness.emit(value);
    }

    expect(harness.pendingFrameCount()).toBe(1);
    expect(delivered).toEqual([]);
    harness.flushFrame();
    expect(delivered).toEqual([3_140]);

    harness.emit(3_141);
    harness.flushFrame();
    expect(delivered).toEqual([3_140, 3_141]);
    unsubscribe();
  });

  it('cancels a pending delivery when the consumer unsubscribes', () => {
    const harness = createHarness<string>();
    const delivered: string[] = [];
    const unsubscribe = subscribeLatestOnAnimationFrame({
      subscribe: harness.subscribe,
      onValue: (value) => delivered.push(value),
      scheduler: harness.scheduler,
    });

    harness.emit('obsolete');
    unsubscribe();
    harness.flushFrame();

    expect(harness.wasUnsubscribed()).toBe(true);
    expect(harness.cancelledFrameIds()).toEqual([1]);
    expect(delivered).toEqual([]);
  });

  it('publishes urgent control state immediately and replaces a queued history snapshot', () => {
    type Snapshot = { historyVersion: number; controlVersion: number };
    const initial = { historyVersion: 0, controlVersion: 0 };
    const harness = createHarness<Snapshot>();
    const delivered: Snapshot[] = [];
    const unsubscribe = subscribeLatestOnAnimationFrame({
      subscribe: harness.subscribe,
      initialValue: initial,
      shouldDefer: (previous, next) => previous?.controlVersion === next.controlVersion,
      onValue: (value) => delivered.push(value),
      scheduler: harness.scheduler,
    });

    harness.emit({ historyVersion: 1, controlVersion: 0 });
    expect(harness.pendingFrameCount()).toBe(1);

    const controlUpdate = { historyVersion: 1, controlVersion: 1 };
    harness.emit(controlUpdate);
    expect(delivered).toEqual([controlUpdate]);
    expect(harness.pendingFrameCount()).toBe(0);
    expect(harness.cancelledFrameIds()).toEqual([1]);

    unsubscribe();
  });
});
