import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isResizeObserverLoopError,
  observeResizeOnAnimationFrame,
} from '../src/lib/resize-observer';

describe('resize observer helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matches only ResizeObserver loop browser errors', () => {
    expect(
      isResizeObserverLoopError('ResizeObserver loop completed with undelivered notifications.')
    ).toBe(true);
    expect(isResizeObserverLoopError(new Error('ResizeObserver loop limit exceeded'))).toBe(true);
    expect(isResizeObserverLoopError(new Error('ResizeObserver failed in app code'))).toBe(false);
  });

  it('defers ResizeObserver callbacks to the next animation frame', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let resizeCallback: ResizeObserverCallback | null = null;

    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }

    vi.stubGlobal('ResizeObserver', MockResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const listener = vi.fn();
    const target = {} as Element;
    const entry = { target, contentRect: { width: 12, height: 34 } } as ResizeObserverEntry;
    const observer = {} as ResizeObserver;

    const cleanup = observeResizeOnAnimationFrame(target, listener);
    resizeCallback?.([entry], observer);

    expect(listener).not.toHaveBeenCalled();
    frameCallbacks[0]?.(0);

    expect(listener).toHaveBeenCalledWith([entry], observer);
    cleanup();
  });

  it('cancels a pending animation frame on cleanup', () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let resizeCallback: ResizeObserverCallback | null = null;

    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }

    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('ResizeObserver', MockResizeObserver as unknown as typeof ResizeObserver);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      })
    );
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

    const listener = vi.fn();
    const target = {} as Element;
    const entry = { target, contentRect: { width: 12, height: 34 } } as ResizeObserverEntry;

    const cleanup = observeResizeOnAnimationFrame(target, listener);
    resizeCallback?.([entry], {} as ResizeObserver);
    cleanup();
    frameCallbacks[0]?.(0);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(listener).not.toHaveBeenCalled();
  });
});
