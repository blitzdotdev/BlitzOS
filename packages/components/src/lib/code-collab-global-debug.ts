import type { ParsedFileMetadataSnapshot } from './code-collab-session-file-provider';

export type CodeCollabDebugLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type CodeCollabDebugLog = {
  readonly level: CodeCollabDebugLogLevel;
  readonly message: string;
  readonly timestamp: number;
  readonly details?: Record<string, unknown>;
};

export type CodeCollabDebugRuntimeSource = 'provider' | 'file-index' | 'standalone';

export type CodeCollabDebugRuntimeRegistration = {
  readonly runtime: unknown;
  readonly source: CodeCollabDebugRuntimeSource;
  readonly ref?: string;
  readonly role?: string;
  readonly streamsToken?: unknown;
};

export type CodeCollabDebugGlobal = {
  readonly logs: CodeCollabDebugLog[];
  readonly runtimes: CodeCollabDebugRuntimeRegistration[];
  readonly runtime?: unknown;
  readonly providerRuntime?: unknown;
  readonly fileIndexRuntime?: unknown;
  readonly fileIndex?: ParsedFileMetadataSnapshot;
  readonly fileMetadata?: ParsedFileMetadataSnapshot;
  clearLogs(): void;
};

const MAX_LOGS = 2_000;

export function ensureCodeCollabGlobalDebug(): CodeCollabDebugGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  const target = window as typeof window & { currentCodeCollab?: CodeCollabDebugGlobal };
  target.currentCodeCollab ??= createCodeCollabDebugGlobal();
  return target.currentCodeCollab;
}

export function registerCodeCollabDebugRuntime(input: CodeCollabDebugRuntimeRegistration): void {
  const debug = ensureCodeCollabGlobalDebug();
  debug?.runtimes.push(input);
}

export function registerCodeCollabDebugProviderRuntime(runtime: unknown): void {
  const debug = ensureCodeCollabGlobalDebug();
  if (!debug) return;
  Object.defineProperty(debug, 'providerRuntime', {
    configurable: true,
    enumerable: true,
    value: runtime,
  });
}

export function registerCodeCollabDebugFileIndexRuntime(runtime: unknown): void {
  const debug = ensureCodeCollabGlobalDebug();
  if (!debug) return;
  Object.defineProperty(debug, 'fileIndexRuntime', {
    configurable: true,
    enumerable: true,
    value: runtime,
  });
}

export function recordCodeCollabDebugMetadata(metadata: ParsedFileMetadataSnapshot): void {
  const debug = ensureCodeCollabGlobalDebug();
  if (!debug) return;
  Object.defineProperty(debug, 'fileIndex', {
    configurable: true,
    enumerable: true,
    value: metadata,
  });
  Object.defineProperty(debug, 'fileMetadata', {
    configurable: true,
    enumerable: true,
    value: metadata,
  });
}

export function registerCodeCollabDebugControlDoc(_input: {
  readonly streamId: string;
  readonly doc: unknown;
}): void {
  return undefined;
}

export function appendCodeCollabDebugLog(
  level: CodeCollabDebugLogLevel,
  message: string,
  details?: Record<string, unknown>
): void {
  const debug = ensureCodeCollabGlobalDebug();
  if (!debug) return;
  debug.logs.push({
    level,
    message,
    timestamp: Date.now(),
    ...(details === undefined ? {} : { details }),
  });
  if (debug.logs.length > MAX_LOGS) {
    debug.logs.splice(0, debug.logs.length - MAX_LOGS);
  }
}

function createCodeCollabDebugGlobal(): CodeCollabDebugGlobal {
  const logs: CodeCollabDebugLog[] = [];
  const runtimes: CodeCollabDebugRuntimeRegistration[] = [];
  return {
    logs,
    runtimes,
    clearLogs: () => {
      logs.length = 0;
    },
  };
}
