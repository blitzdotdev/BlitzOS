type TimerHandle = ReturnType<typeof setTimeout>;

type StartupNavigationCooldownScheduler = {
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

type StartupNavigationCooldownClock = {
  now: () => number;
};

type StartupNavigationCooldownOptions = {
  cooldownMs?: number;
  scheduler?: StartupNavigationCooldownScheduler;
  clock?: StartupNavigationCooldownClock;
  navigationSource?: StartupNavigationCooldownSource;
};

export type StartupNavigationCooldownSource = {
  getLastNavigationAtMs: () => number | null;
  subscribe: (listener: () => void) => () => void;
};

export const STARTUP_NAVIGATION_COOLDOWN_MS = 10_000;

const getDefaultClock = (): StartupNavigationCooldownClock =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? { now: () => performance.now() }
    : { now: () => Date.now() };

let lastStartupNavigationAtMs: number | null = null;
const startupNavigationListeners = new Set<() => void>();

const defaultNavigationSource: StartupNavigationCooldownSource = {
  getLastNavigationAtMs: () => lastStartupNavigationAtMs,
  subscribe: (listener) => {
    startupNavigationListeners.add(listener);
    return () => {
      startupNavigationListeners.delete(listener);
    };
  },
};

export function markStartupNavigationForEagerSync(
  clock: StartupNavigationCooldownClock = getDefaultClock()
): void {
  lastStartupNavigationAtMs = clock.now();
  for (const listener of Array.from(startupNavigationListeners)) {
    listener();
  }
}

export function scheduleAfterStartupNavigationCooldown(
  callback: () => void,
  options: StartupNavigationCooldownOptions = {}
): () => void {
  const cooldownMs = options.cooldownMs ?? STARTUP_NAVIGATION_COOLDOWN_MS;
  const scheduler = options.scheduler ?? {
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const clock = options.clock ?? getDefaultClock();
  const navigationSource = options.navigationSource ?? defaultNavigationSource;

  let cancelled = false;
  let timer: TimerHandle | null = null;
  let unsubscribeNavigation: (() => void) | null = null;

  const cleanup = () => {
    if (timer) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  };

  const cleanupNavigation = () => {
    unsubscribeNavigation?.();
    unsubscribeNavigation = null;
  };

  const run = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    cleanup();
    cleanupNavigation();
    callback();
  };

  const armTimer = () => {
    if (cancelled) {
      return;
    }
    cleanup();
    const now = clock.now();
    const lastNavigationAtMs = navigationSource.getLastNavigationAtMs() ?? now;
    const delayMs = Math.max(0, lastNavigationAtMs + cooldownMs - now);
    timer = scheduler.setTimeout(run, delayMs);
  };

  unsubscribeNavigation = navigationSource.subscribe(armTimer);
  armTimer();

  return () => {
    cancelled = true;
    cleanup();
    cleanupNavigation();
  };
}
