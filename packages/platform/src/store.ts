/**
 * Minimal framework-agnostic observable value.
 *
 * The platform contracts are consumed by React (renderer) and by plain Node
 * (CLI), so they must not be expressed in React hooks. `ReadonlyStore` is the
 * shared currency: `get()` returns the current snapshot, `subscribe()` notifies
 * on change. The React binding in `./react` adapts it via `useSyncExternalStore`.
 */
export interface ReadonlyStore<T> {
  get(): T;
  /** Returns an unsubscribe function. Listeners are invoked after the value changes. */
  subscribe(listener: () => void): () => void;
}

export interface MutableStore<T> extends ReadonlyStore<T> {
  set(value: T): void;
}

export function createStore<T>(initial: T): MutableStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A store whose value never changes; `subscribe` is a no-op. */
export function createStaticStore<T>(value: T): ReadonlyStore<T> {
  return {
    get: () => value,
    subscribe: () => () => {},
  };
}
