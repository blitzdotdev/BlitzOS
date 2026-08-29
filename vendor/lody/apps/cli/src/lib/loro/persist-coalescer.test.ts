import { describe, expect, it } from 'vitest';
import { PersistCoalescer } from './persist-coalescer';

type Reason = 'doc' | 'meta' | 'flock';

/**
 * A hand-driven timer queue. The coalescer's whole contract is "when does the
 * flush run relative to the requests", so the test owns the clock outright
 * rather than waiting on real timers.
 */
const createManualTimers = () => {
  let nextId = 1;
  const scheduled = new Map<number, () => void>();
  return {
    setTimer: (callback: () => void) => {
      const id = nextId++;
      scheduled.set(id, callback);
      return id;
    },
    clearTimer: (handle: unknown) => {
      scheduled.delete(handle as number);
    },
    get pendingCount() {
      return scheduled.size;
    },
    /** Fire every currently-scheduled timer, oldest first. */
    fire: () => {
      const callbacks = [...scheduled.entries()].sort((a, b) => a[0] - b[0]);
      scheduled.clear();
      for (const [, callback] of callbacks) {
        callback();
      }
    },
  };
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('PersistCoalescer', () => {
  it('collapses a burst of requests into a single flush carrying every reason', async () => {
    const timers = createManualTimers();
    const flushes: (readonly Reason[])[] = [];
    const coalescer = new PersistCoalescer<Reason>({
      debounceMs: 200,
      flush: async (reasons) => {
        flushes.push(reasons);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    coalescer.request('doc');
    coalescer.request('meta');
    coalescer.request('doc');
    coalescer.request('flock');

    expect(flushes).toEqual([]);
    expect(timers.pendingCount).toBe(1);

    timers.fire();
    await coalescer.flushNow();

    expect(flushes).toEqual([['doc', 'flock', 'meta']]);
  });

  it('covers requests that arrive mid-flush with a following flush', async () => {
    const timers = createManualTimers();
    const flushes: (readonly Reason[])[] = [];
    const inFlight = createDeferred();
    let flushCount = 0;
    const coalescer = new PersistCoalescer<Reason>({
      debounceMs: 200,
      flush: async (reasons) => {
        flushes.push(reasons);
        flushCount += 1;
        if (flushCount === 1) {
          await inFlight.promise;
        }
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    coalescer.request('doc');
    timers.fire();
    // The first flush is now suspended inside `flush`.
    expect(flushes).toEqual([['doc']]);

    coalescer.request('meta');
    // No second timer while a flush is running — it opens after completion.
    expect(timers.pendingCount).toBe(0);

    inFlight.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(timers.pendingCount).toBe(1);
    timers.fire();
    await coalescer.flushNow();

    expect(flushes).toEqual([['doc'], ['meta']]);
  });

  it('flushNow runs a scheduled flush instead of waiting out the window', async () => {
    const timers = createManualTimers();
    const flushes: (readonly Reason[])[] = [];
    const coalescer = new PersistCoalescer<Reason>({
      debounceMs: 200,
      flush: async (reasons) => {
        flushes.push(reasons);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    coalescer.request('doc');
    expect(timers.pendingCount).toBe(1);

    await coalescer.flushNow();

    expect(flushes).toEqual([['doc']]);
    expect(timers.pendingCount).toBe(0);
    expect(coalescer.busy).toBe(false);
  });

  it('keeps draining after a failed flush instead of wedging', async () => {
    const timers = createManualTimers();
    const errors: unknown[] = [];
    const flushes: (readonly Reason[])[] = [];
    let flushCount = 0;
    const coalescer = new PersistCoalescer<Reason>({
      debounceMs: 200,
      flush: async (reasons) => {
        flushCount += 1;
        if (flushCount === 1) {
          throw new Error('flush boom');
        }
        flushes.push(reasons);
      },
      onError: (error) => errors.push(error),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    coalescer.request('doc');
    timers.fire();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(coalescer.busy).toBe(false);

    coalescer.request('meta');
    timers.fire();
    await coalescer.flushNow();

    expect(flushes).toEqual([['meta']]);
  });

  it('cancel drops a scheduled flush', async () => {
    const timers = createManualTimers();
    const flushes: (readonly Reason[])[] = [];
    const coalescer = new PersistCoalescer<Reason>({
      debounceMs: 200,
      flush: async (reasons) => {
        flushes.push(reasons);
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    coalescer.request('doc');
    coalescer.cancel();
    await coalescer.flushNow();

    expect(flushes).toEqual([]);
    expect(timers.pendingCount).toBe(0);
  });
});
