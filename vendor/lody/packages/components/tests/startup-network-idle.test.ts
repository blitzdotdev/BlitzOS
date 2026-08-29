import { describe, expect, it, vi } from 'vitest';
import {
  markStartupNavigationForEagerSync,
  scheduleAfterStartupNavigationCooldown,
  type StartupNavigationCooldownSource,
} from '../src/providers/startup-network-idle';

function createFakeScheduler() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { due: number; handler: () => void }>();

  const advance = (ms: number) => {
    now += ms;
    let fired = true;
    while (fired) {
      fired = false;
      const dueTimers = Array.from(timers)
        .filter(([, timer]) => timer.due <= now)
        .sort(([, left], [, right]) => left.due - right.due);
      for (const [id, timer] of dueTimers) {
        if (!timers.has(id)) {
          continue;
        }
        timers.delete(id);
        timer.handler();
        fired = true;
      }
    }
  };

  return {
    scheduler: {
      setTimeout: (handler: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { due: now + ms, handler });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        timers.delete(handle as unknown as number);
      },
    },
    advance,
    clock: {
      now: () => now,
    },
    pendingCount: () => timers.size,
  };
}

function createNavigationSource() {
  let lastNavigationAtMs: number | null = null;
  const listeners = new Set<() => void>();

  return {
    source: {
      getLastNavigationAtMs: () => lastNavigationAtMs,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies StartupNavigationCooldownSource,
    mark: (atMs: number) => {
      lastNavigationAtMs = atMs;
      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

describe('scheduleAfterStartupNavigationCooldown', () => {
  it('waits for the cooldown when no navigation has been recorded yet', () => {
    const time = createFakeScheduler();
    const navigation = createNavigationSource();
    const run = vi.fn();

    scheduleAfterStartupNavigationCooldown(run, {
      cooldownMs: 10,
      scheduler: time.scheduler,
      clock: time.clock,
      navigationSource: navigation.source,
    });

    time.advance(9);
    expect(run).not.toHaveBeenCalled();
    time.advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(navigation.listenerCount()).toBe(0);
  });

  it('waits until the last navigation has cooled down', () => {
    const time = createFakeScheduler();
    const navigation = createNavigationSource();
    const run = vi.fn();

    navigation.mark(0);
    scheduleAfterStartupNavigationCooldown(run, {
      cooldownMs: 10,
      scheduler: time.scheduler,
      clock: time.clock,
      navigationSource: navigation.source,
    });

    time.advance(9);
    expect(run).not.toHaveBeenCalled();
    time.advance(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('restarts the cooldown when navigation changes while waiting', () => {
    const time = createFakeScheduler();
    const navigation = createNavigationSource();
    const run = vi.fn();

    navigation.mark(0);
    scheduleAfterStartupNavigationCooldown(run, {
      cooldownMs: 10,
      scheduler: time.scheduler,
      clock: time.clock,
      navigationSource: navigation.source,
    });

    time.advance(9);
    navigation.mark(time.clock.now());
    time.advance(9);
    expect(run).not.toHaveBeenCalled();
    time.advance(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(time.pendingCount()).toBe(0);
    expect(navigation.listenerCount()).toBe(0);
  });

  it('can cancel a delayed startup and unsubscribe from navigation changes', () => {
    const time = createFakeScheduler();
    const navigation = createNavigationSource();
    const run = vi.fn();

    const cancel = scheduleAfterStartupNavigationCooldown(run, {
      cooldownMs: 10,
      scheduler: time.scheduler,
      clock: time.clock,
      navigationSource: navigation.source,
    });

    expect(navigation.listenerCount()).toBe(1);
    cancel();
    navigation.mark(1);
    time.advance(100);

    expect(run).not.toHaveBeenCalled();
    expect(navigation.listenerCount()).toBe(0);
    expect(time.pendingCount()).toBe(0);
  });

  it('marks global startup navigation with the provided clock', () => {
    const time = createFakeScheduler();
    const run = vi.fn();

    markStartupNavigationForEagerSync(time.clock);
    scheduleAfterStartupNavigationCooldown(run, {
      cooldownMs: 10,
      scheduler: time.scheduler,
      clock: time.clock,
    });

    time.advance(9);
    expect(run).not.toHaveBeenCalled();
    time.advance(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
