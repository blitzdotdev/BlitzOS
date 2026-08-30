const RESIZE_OBSERVER_LOOP_MESSAGES = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
]);

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : null;
  }
  return null;
}

export function isResizeObserverLoopError(error: unknown): boolean {
  const message = readErrorMessage(error);
  return message !== null && RESIZE_OBSERVER_LOOP_MESSAGES.has(message);
}

function scheduleFrame(callback: FrameRequestCallback): () => void {
  if (
    typeof globalThis.requestAnimationFrame === 'function' &&
    typeof globalThis.cancelAnimationFrame === 'function'
  ) {
    const frameId = globalThis.requestAnimationFrame(callback);
    return () => globalThis.cancelAnimationFrame(frameId);
  }

  const timeoutId = globalThis.setTimeout(() => callback(Date.now()), 0);
  return () => globalThis.clearTimeout(timeoutId);
}

export function observeResizeOnAnimationFrame(
  target: Element,
  callback: ResizeObserverCallback
): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};

  let cancelFrame: (() => void) | null = null;
  let pendingEntries: ResizeObserverEntry[] | null = null;
  let pendingObserver: ResizeObserver | null = null;
  let disconnected = false;

  const observer = new ResizeObserver((entries, currentObserver) => {
    pendingEntries = entries.slice();
    pendingObserver = currentObserver;
    if (cancelFrame) return;

    cancelFrame = scheduleFrame(() => {
      cancelFrame = null;
      const nextEntries = pendingEntries;
      const nextObserver = pendingObserver;
      pendingEntries = null;
      pendingObserver = null;
      if (!disconnected && nextEntries && nextObserver) {
        callback(nextEntries, nextObserver);
      }
    });
  });

  observer.observe(target);

  return () => {
    disconnected = true;
    cancelFrame?.();
    cancelFrame = null;
    pendingEntries = null;
    pendingObserver = null;
    observer.disconnect();
  };
}

let resizeObserverLoopErrorHandlerInstalled = false;

export function installResizeObserverLoopErrorHandler(): void {
  if (resizeObserverLoopErrorHandlerInstalled || typeof window === 'undefined') return;
  resizeObserverLoopErrorHandlerInstalled = true;

  window.addEventListener(
    'error',
    (event) => {
      if (!isResizeObserverLoopError(event.error ?? event.message)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
}
