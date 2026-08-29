import { useRef, type MutableRefObject } from 'react';

// Returns a ref whose `.current` always reflects the latest `value`
// passed during render. Callers read the ref inside effects, event
// handlers, or intervals that should not retear-down on every prop
// change — the ref lets them see the current value without re-keying
// the effect lifecycle.
export function useLatestRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
