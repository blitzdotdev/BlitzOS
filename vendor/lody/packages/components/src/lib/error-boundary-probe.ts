export const ERROR_BOUNDARY_PROBE_STORAGE_KEY = 'lody:error-boundary-probe';
export const ERROR_BOUNDARY_PROBE_QUERY_PARAM = 'lody_error_boundary_probe';
export const ERROR_BOUNDARY_PROBE_STORAGE_ENABLED_VALUE = 'enabled';
export const ERROR_BOUNDARY_PROBE_QUERY_THROW_VALUE = 'throw';
export const ERROR_BOUNDARY_PROBE_EVENT = 'lody:error-boundary-probe';

type ProbeStorage = Pick<Storage, 'getItem' | 'removeItem'>;
type ProbeHistory = Pick<History, 'replaceState' | 'state'>;
type ProbeLocation = Pick<Location, 'hash' | 'pathname' | 'search'>;

function readDefaultStorage(): ProbeStorage | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readDefaultHistory(): ProbeHistory | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.history;
}

function readDefaultLocation(): ProbeLocation | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.location;
}

export function shouldTriggerErrorBoundaryProbe(
  search: string,
  storage: ProbeStorage | null = readDefaultStorage()
): boolean {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return false;
  }

  if (params.get(ERROR_BOUNDARY_PROBE_QUERY_PARAM) !== ERROR_BOUNDARY_PROBE_QUERY_THROW_VALUE) {
    return false;
  }

  try {
    return (
      storage?.getItem(ERROR_BOUNDARY_PROBE_STORAGE_KEY) ===
      ERROR_BOUNDARY_PROBE_STORAGE_ENABLED_VALUE
    );
  } catch {
    return false;
  }
}

export function consumeErrorBoundaryProbe(
  storage: ProbeStorage | null = readDefaultStorage(),
  location: ProbeLocation | null = readDefaultLocation(),
  history: ProbeHistory | null = readDefaultHistory()
): boolean {
  if (!location || !shouldTriggerErrorBoundaryProbe(location.search, storage)) {
    return false;
  }

  try {
    storage?.removeItem(ERROR_BOUNDARY_PROBE_STORAGE_KEY);
  } catch {
    // ignore cleanup failures; the probe should still throw for the current page.
  }

  try {
    const params = new URLSearchParams(location.search);
    params.delete(ERROR_BOUNDARY_PROBE_QUERY_PARAM);
    const nextSearch = params.toString();
    const nextUrl = `${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash}`;
    history?.replaceState(history.state, '', nextUrl);
  } catch {
    // URL cleanup is best-effort. Never block the probe from exercising the boundary.
  }

  return true;
}
