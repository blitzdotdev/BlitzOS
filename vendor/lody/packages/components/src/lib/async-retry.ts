type MaybePromise<T> = T | Promise<T>;

export type RetryDirective = boolean | { retry: boolean; delayMs?: number };

export interface RunWithRetryOptions<T> {
  /** The operation to attempt; re-invoked from scratch on each retry. */
  run: () => Promise<T>;
  /**
   * Decide whether a thrown error should be retried, and after what delay.
   * Return `true`/`false` for an immediate retry / give-up, or an object to add
   * a `delayMs` backoff before the next attempt.
   */
  shouldRetry: (error: unknown, attempt: number) => MaybePromise<RetryDirective>;
  /**
   * Bail between attempts once the operation has been superseded (e.g. the
   * caller's cache key changed). When it returns true, `runWithRetry` resolves
   * with `staleResult()` instead of retrying or throwing.
   */
  isStale?: () => boolean;
  /** Value to resolve with when `isStale()` cancels the operation (default: undefined). */
  staleResult?: () => MaybePromise<T>;
}

async function delay(ms: number | undefined): Promise<void> {
  if (!ms || ms <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runWithRetry<T>(options: RunWithRetryOptions<T>): Promise<T> {
  const resolveStale = async (): Promise<T> =>
    options.staleResult ? await options.staleResult() : (undefined as T);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await options.run();
    } catch (error) {
      if (options.isStale?.()) return await resolveStale();
      const directive = await options.shouldRetry(error, attempt);
      const retry = typeof directive === 'boolean' ? directive : directive.retry;
      if (!retry) throw error;
      await delay(typeof directive === 'boolean' ? undefined : directive.delayMs);
      if (options.isStale?.()) return await resolveStale();
    }
  }
}
