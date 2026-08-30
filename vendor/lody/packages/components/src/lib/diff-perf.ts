const DIFF_PERF_STORAGE_KEY = 'lody.diffPerf';
const DIFF_PERF_QUERY_PARAM = 'lodyDiffPerf';
const DIFF_PERF_PREFIX = '[DiffPerf]';

export const isDiffPerfEnabled = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    if (window.localStorage.getItem(DIFF_PERF_STORAGE_KEY) === '1') {
      return true;
    }
  } catch {
    // Ignore storage access errors.
  }

  try {
    return new URLSearchParams(window.location.search).get(DIFF_PERF_QUERY_PARAM) === '1';
  } catch {
    return false;
  }
};

export const getDiffPerfNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export const logDiffPerf = (event: string, details?: Record<string, unknown>): void => {
  if (!isDiffPerfEnabled()) {
    return;
  }

  console.info(`${DIFF_PERF_PREFIX} ${event}`, {
    at: Math.round(getDiffPerfNow()),
    ...(details ?? {}),
  });
};

export const logDiffPerfLazy = (event: string, getDetails: () => Record<string, unknown>): void => {
  if (!isDiffPerfEnabled()) {
    return;
  }

  logDiffPerf(event, getDetails());
};

export const logDiffPerfDuration = (
  event: string,
  startedAt: number,
  details?: Record<string, unknown>,
  thresholdMs = 0
): void => {
  if (!isDiffPerfEnabled()) {
    return;
  }

  const durationMs = getDiffPerfNow() - startedAt;
  if (durationMs < thresholdMs) {
    return;
  }

  logDiffPerf(event, {
    durationMs: Math.round(durationMs * 10) / 10,
    ...(details ?? {}),
  });
};

export const logDiffPerfDurationLazy = (
  event: string,
  startedAt: number,
  getDetails: (durationMs: number) => Record<string, unknown>,
  thresholdMs = 0
): void => {
  if (!isDiffPerfEnabled()) {
    return;
  }

  const durationMs = getDiffPerfNow() - startedAt;
  if (durationMs < thresholdMs) {
    return;
  }

  logDiffPerf(event, {
    durationMs: Math.round(durationMs * 10) / 10,
    ...getDetails(durationMs),
  });
};

export const observeDiffPerfLongTasks = (): (() => void) | null => {
  if (!isDiffPerfEnabled() || typeof PerformanceObserver === 'undefined') {
    return null;
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        logDiffPerf('browser:long-task', {
          name: entry.name,
          durationMs: Math.round(entry.duration * 10) / 10,
          startTime: Math.round(entry.startTime),
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
    return () => observer.disconnect();
  } catch {
    return null;
  }
};
