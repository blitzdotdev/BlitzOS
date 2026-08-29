import { useCallback, useSyncExternalStore } from 'react';
import { getServerNow } from '@lody/shared';

import { useStableNow } from '@/hooks/use-stable-now';
import {
  getCodexResetForecastStore,
  type CodexResetForecastState,
} from '@/lib/codex-reset-forecast-store';
import {
  isCodexResetWatchExpired,
  selectActiveCodexResetWatch,
  type CodexResetWatch,
} from '@/lib/codex-reset-forecast';

export type UseCodexResetForecastResult = {
  state: CodexResetForecastState;
  /** The forecast only while it is still in force; `null` otherwise. */
  watch: CodexResetWatch | null;
  /** A forecast was loaded but has already lapsed. */
  isExpired: boolean;
  nowMs: number;
  /**
   * Call when the user OPENS a surface that shows the forecast. Nothing loads
   * on mount, so a surface that never opens never requests anything.
   */
  revalidate: () => void;
  /** Force a fetch, ignoring the store's freshness window. */
  refresh: () => void;
};

/**
 * Reads the shared Codex reset forecast. `enabled` is false on every surface
 * that is not a first-party Codex provider, and no request is made there.
 *
 * This hook deliberately has NO load effect: mounting a chip, a popover trigger
 * or a closed dialog must not hit the network. Each entry point calls
 * `revalidate()` from the interaction that reveals the forecast.
 */
export function useCodexResetForecast(enabled: boolean): UseCodexResetForecastResult {
  const store = getCodexResetForecastStore();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  const revalidate = useCallback(() => {
    if (!enabled) return;
    void store.revalidate();
  }, [enabled, store]);

  // A watch expires on a wall-clock deadline, not on any event this component
  // observes, so `now` must advance on its own or a lapsed forecast would linger
  // until something unrelated re-rendered. The shared minute ticker supplies the
  // cadence (no timer per consumer); the value itself still comes from the
  // synced server clock, matching the rate-limit reset copy this sits beside.
  useStableNow();
  const nowMs = getServerNow();

  return {
    state,
    watch: enabled ? selectActiveCodexResetWatch(state.data, nowMs) : null,
    isExpired: enabled && isCodexResetWatchExpired(state.data, nowMs),
    nowMs,
    revalidate,
    refresh: () => {
      if (!enabled) return;
      void store.refresh();
    },
  };
}
