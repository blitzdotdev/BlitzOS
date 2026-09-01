import { useEffect, useState } from 'react';

/**
 * Returns true only after `active` has been continuously true for `delayMs`.
 * Falls back to false immediately when `active` turns false. Used to keep
 * transient states (brief syncing, reconnect blips) from flashing UI.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!active) {
      setDelayed(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setDelayed(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, delayMs]);

  return active && delayed;
}
