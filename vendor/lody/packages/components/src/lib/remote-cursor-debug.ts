export const REMOTE_CURSOR_DEBUG_STORAGE_KEY = 'lody:debug:remote-cursor';

// The resilient remote cursor store emits a start/success event on every
// save/load/delete, which floods the console even at the `debug` level. Gate
// the routine event logging behind an explicit flag so it stays silent by
// default but can be re-enabled when diagnosing Streams cursor issues.
export function isRemoteCursorDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const queryValue = new URLSearchParams(window.location.search).get('remoteCursorDebug');
    if (isEnabledDebugValue(queryValue)) return true;
  } catch {
    // Ignore URL parsing failures; the localStorage flag is the stable path.
  }

  try {
    return isEnabledDebugValue(window.localStorage.getItem(REMOTE_CURSOR_DEBUG_STORAGE_KEY));
  } catch {
    return false;
  }
}

function isEnabledDebugValue(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'debug' || value === 'verbose';
}
