export type AsyncConcurrencyGate = <T>(task: () => Promise<T>) => Promise<T>;

export function createAsyncConcurrencyGate(limit: number): AsyncConcurrencyGate {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Concurrency gate limit must be a positive integer, got ${String(limit)}.`);
  }

  let activeCount = 0;
  const waiters: Array<() => void> = [];

  const releaseNext = (): void => {
    const next = waiters.shift();
    if (next) {
      next();
    }
  };

  const acquire = async (): Promise<void> => {
    if (activeCount < limit) {
      activeCount += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      if (waiters.length > 0) {
        releaseNext();
      } else {
        activeCount -= 1;
      }
    }
  };
}
