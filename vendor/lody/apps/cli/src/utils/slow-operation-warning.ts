import type { Logger } from './logger';

/**
 * Wraps a promise with periodic warning logs if the operation takes too long.
 * This helps diagnose operations that may hang indefinitely (e.g., ACP protocol calls,
 * CRDT sync operations).
 */
export function withSlowOperationWarning<T>(
  promise: Promise<T>,
  logger: Logger,
  operationName: string,
  sessionId: string,
  intervalMs: number = 10000
): Promise<T> {
  let completed = false;
  const startMs = Date.now();

  const interval = setInterval(() => {
    if (!completed) {
      const elapsedMs = Date.now() - startMs;
      logger.debug(
        `[${sessionId}] Operation "${operationName}" is still pending after ${Math.round(elapsedMs / 1000)}s - possible hang`
      );
    }
  }, intervalMs);
  interval.unref?.();

  return promise.finally(() => {
    completed = true;
    clearInterval(interval);
  });
}
