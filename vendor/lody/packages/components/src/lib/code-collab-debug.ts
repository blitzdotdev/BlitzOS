import { appendCodeCollabDebugLog } from './code-collab-global-debug';

export const CODE_COLLAB_DEBUG_STORAGE_KEY = 'lody:debug:code-collab';

export function isCodeCollabDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const queryValue = new URLSearchParams(window.location.search).get('codeCollabDebug');
    if (isEnabledDebugValue(queryValue)) return true;
  } catch {
    // Ignore URL parsing failures; the localStorage flag is the stable path.
  }

  try {
    return isEnabledDebugValue(window.localStorage.getItem(CODE_COLLAB_DEBUG_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function logCodeCollabDebug(message: string, details?: Record<string, unknown>): void {
  const traceDetails = withCodeCollabTraceDetails(message, details);
  appendCodeCollabDebugLog('debug', message, traceDetails);
  if (!isCodeCollabDebugEnabled()) return;
  writeCodeCollabConsole('debug', message, traceDetails);
}

export function logCodeCollabInfo(message: string, details?: Record<string, unknown>): void {
  const traceDetails = withCodeCollabTraceDetails(message, details);
  appendCodeCollabDebugLog('info', message, traceDetails);
  if (!isCodeCollabDebugEnabled()) return;
  writeCodeCollabConsole('info', message, traceDetails);
}

export function warnCodeCollab(message: string, details?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const traceDetails = withCodeCollabTraceDetails(message, details);
  appendCodeCollabDebugLog('warn', message, traceDetails);
  writeCodeCollabConsole('warn', message, traceDetails);
}

export function describeCodeCollabError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const details = error as {
      readonly reason?: unknown;
      readonly tokenReason?: unknown;
      readonly httpStatus?: unknown;
    };
    return {
      name: error.name,
      message: error.message,
      ...(details.reason === undefined ? {} : { reason: details.reason }),
      ...(details.tokenReason === undefined ? {} : { tokenReason: details.tokenReason }),
      ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { value: String(error) };
}

function isEnabledDebugValue(value: string | null): boolean {
  return value === '1' || value === 'true' || value === 'debug' || value === 'verbose';
}

function withCodeCollabTraceDetails(
  message: string,
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (typeof window === 'undefined') return details;
  const performanceNow = window.performance?.now.bind(window.performance);
  if (!performanceNow) return details;

  const traceNowMs = Math.round(performanceNow() * 100) / 100;
  const trace = getCodeCollabTraceBuffer();
  const entry = {
    seq: trace.length + 1,
    event: message,
    traceNowMs,
    wallTimeMs: Date.now(),
    ...(details === undefined ? {} : { details }),
  };
  trace.push(entry);
  if (trace.length > 2_000) {
    trace.splice(0, trace.length - 2_000);
  }

  return {
    ...(details ?? {}),
    traceSeq: entry.seq,
    traceNowMs,
  };
}

function getCodeCollabTraceBuffer(): Array<{
  readonly seq: number;
  readonly event: string;
  readonly traceNowMs: number;
  readonly wallTimeMs: number;
  readonly details?: Record<string, unknown>;
}> {
  const target = window as typeof window & {
    __lodyCodeCollabTrace?: Array<{
      readonly seq: number;
      readonly event: string;
      readonly traceNowMs: number;
      readonly wallTimeMs: number;
      readonly details?: Record<string, unknown>;
    }>;
  };
  target.__lodyCodeCollabTrace ??= [];
  return target.__lodyCodeCollabTrace;
}

function writeCodeCollabConsole(
  level: 'debug' | 'info' | 'warn',
  message: string,
  details?: Record<string, unknown>
): void {
  const prefix = `[Code Collab] ${message}`;
  if (details === undefined) {
    console[level](prefix);
    return;
  }
  console[level](prefix, details);
}
