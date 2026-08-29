import {
  fetchCodexResetStatus,
  type CodexResetStatus,
  type CodexResetStatusFetcher,
} from './codex-reset-forecast';

/**
 * One cached read of the public Codex reset status, shared by every surface
 * that shows it (the provider row chip, the usage popover row, the dialog).
 *
 * NOTHING here loads in the background. A request happens only when a user
 * OPENS a surface that shows the forecast, so a workspace that never looks at
 * it never touches the endpoint. That is also why this is a module-level
 * singleton: `SessionUsagePopover` is mounted once per open tab and side chat —
 * including hidden ones — and `ProviderRow` renders once per configured
 * provider, so a per-component fetch would turn one global read-only value into
 * a request storm. All of them share this store, and concurrent callers coalesce
 * onto one in-flight request.
 *
 * Because a load is user-initiated, freshness is capped at
 * `MAX_TTL_MS` (5 minutes): opening a panel is a request to see the CURRENT
 * forecast, not whatever the CDN would still serve. A shorter served `max-age`
 * still wins, and `MIN_TTL_MS` keeps a user who toggles a popover from
 * hammering the endpoint. A lapsed TTL revalidates with `If-None-Match`, so the
 * usual outcome is a 304 rather than a re-download. Stale-while-revalidate
 * falls out of the state shape — `data` survives a revalidation, so nothing
 * blanks while a refresh is in flight.
 */

export type CodexResetForecastState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Kept across a refresh so a reload never blanks a forecast already shown. */
  data: CodexResetStatus | null;
  error: string | null;
};

export type CodexResetForecastStore = {
  subscribe: (listener: () => void) => () => void;
  getState: () => CodexResetForecastState;
  /**
   * A user opened a surface that shows the forecast. Fetch unless a fresh value
   * or an in-flight request already covers it. The returned promise settles when
   * the store has, which is what lets callers (and tests) observe the result
   * without polling.
   */
  revalidate: () => Promise<void>;
  /** Fetch now, ignoring the TTL. Coalesces with an in-flight request. */
  refresh: () => Promise<void>;
};

/** Never hammer the endpoint on repeated opens. */
const MIN_TTL_MS = 60 * 1000;
/**
 * The endpoint serves `public, max-age=14400` (4h). That is right for a CDN and
 * wrong for a user who just opened the panel to check a forecast, so the store
 * caps its own reuse well below it; the request it then makes is conditional
 * and normally answered 304. Also the fallback when the server sends no max-age.
 */
const MAX_TTL_MS = 5 * 60 * 1000;

const IDLE_STATE: CodexResetForecastState = { status: 'idle', data: null, error: null };

export function createCodexResetForecastStore({
  fetchStatus = fetchCodexResetStatus,
  now = () => Date.now(),
  defaultTtlMs = MAX_TTL_MS,
}: {
  fetchStatus?: CodexResetStatusFetcher;
  now?: () => number;
  defaultTtlMs?: number;
} = {}): CodexResetForecastStore {
  let state: CodexResetForecastState = IDLE_STATE;
  let loadedAtMs: number | null = null;
  let ttlMs = defaultTtlMs;
  let etag: string | null = null;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  const setState = (next: CodexResetForecastState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const load = (): Promise<void> => {
    if (inFlight) return inFlight;
    setState({ status: 'loading', data: state.data, error: null });
    const pending = fetchStatus({ etag })
      .then((result) => {
        // A 304 means the cached forecast is still current, so only its
        // freshness is refreshed.
        const data = result.status ?? state.data;
        if (!data) {
          throw new Error('Codex reset status was revalidated without a cached forecast');
        }
        etag = result.etag;
        ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, result.maxAgeMs ?? defaultTtlMs));
        loadedAtMs = now();
        setState({ status: 'ready', data, error: null });
      })
      .catch((error: unknown) => {
        // A failed refresh keeps the previously loaded forecast visible; the
        // dialog is what surfaces the error and offers a retry.
        setState({
          status: 'error',
          data: state.data,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = pending;
    return pending;
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    revalidate: () => {
      if (inFlight) return inFlight;
      if (state.status === 'ready' && loadedAtMs !== null && now() - loadedAtMs < ttlMs) {
        return Promise.resolve();
      }
      return load();
    },
    refresh: () => load(),
  };
}

let sharedStore: CodexResetForecastStore | null = null;

export function getCodexResetForecastStore(): CodexResetForecastStore {
  sharedStore ??= createCodexResetForecastStore();
  return sharedStore;
}

/** Test seam: replace (or clear, with no argument) the process-wide store. */
export function setCodexResetForecastStoreForTests(store: CodexResetForecastStore | null): void {
  sharedStore = store;
}
