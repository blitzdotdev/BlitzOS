import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CodeCollabV2FileTreeValue } from '@lody/shared';
import { getLogger } from '@/utils/logger';

import type {
  FileIndexFullStateWorkerInput,
  FileIndexFullStateWorkerResult,
  FileIndexScanWorkerInput,
  FileIndexWorkerInput,
  FileIndexWorkerResult,
} from './file-index-scan-worker';
import { tinypoolRuntimeOptions, type TinypoolRuntime } from './tinypool-runtime';

type TinypoolInstance = {
  run(payload: FileIndexWorkerInput): Promise<FileIndexWorkerResult>;
  destroy(): Promise<void>;
};

type TinypoolConstructor = new (options: {
  readonly filename: string;
  readonly minThreads: number;
  readonly maxThreads: number;
  readonly idleTimeout: number;
  readonly runtime?: TinypoolRuntime;
}) => TinypoolInstance;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILENAME = path.join(MODULE_DIR, 'file-index-scan-worker.js');
const TINYPOOL_MODULE_ID = 'tinypool';

let pool: TinypoolInstance | null = null;
let inlineOnly = false;
let initPromise: Promise<TinypoolInstance | null> | null = null;
const loggedFallbackReasons = new Set<string>();

function logFallbackOnce(reason: string, error?: unknown): void {
  if (loggedFallbackReasons.has(reason)) return;
  loggedFallbackReasons.add(reason);
  const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error);
  getLogger('code-collab').warn(
    `[code-collab] file-index worker unavailable; falling back to main-thread file-index path reason=${reason} worker=${WORKER_FILENAME}${
      detail ? ` error=${detail}` : ''
    }`
  );
}

function markInlineFallback(reason: string, error?: unknown): void {
  inlineOnly = true;
  logFallbackOnce(reason, error);
}

async function getPool(): Promise<TinypoolInstance | null> {
  if (inlineOnly) return null;
  if (pool) return pool;
  if (!initPromise) {
    initPromise = initPool();
  }
  return initPromise;
}

async function initPool(): Promise<TinypoolInstance | null> {
  if (!existsSync(WORKER_FILENAME)) {
    markInlineFallback('worker_missing');
    return null;
  }
  try {
    const { default: Tinypool } = (await import(TINYPOOL_MODULE_ID)) as {
      readonly default: TinypoolConstructor;
    };
    pool = new Tinypool({
      filename: WORKER_FILENAME,
      minThreads: 0,
      maxThreads: 1,
      idleTimeout: 30_000,
      ...tinypoolRuntimeOptions(),
    });
    return pool;
  } catch (error) {
    markInlineFallback('pool_init_failed', error);
    return null;
  }
}

export async function scanDirectoryEntriesInWorker(
  input: FileIndexScanWorkerInput
): Promise<Map<string, CodeCollabV2FileTreeValue> | null> {
  const activePool = await getPool();
  if (!activePool) {
    return null;
  }
  try {
    const result = await activePool.run(input);
    if (result.kind !== 'scan') {
      logFallbackOnce('unexpected_scan_result');
      return null;
    }
    return new Map(result.entries);
  } catch (error) {
    logFallbackOnce('pool_run_failed', error);
    return null;
  }
}

export async function computeFullFileIndexStateInWorker(
  input: FileIndexFullStateWorkerInput
): Promise<FileIndexFullStateWorkerResult | null> {
  const activePool = await getPool();
  if (!activePool) {
    return null;
  }
  try {
    const result = await activePool.run(input);
    if (result.kind !== 'full-state') {
      logFallbackOnce('unexpected_full_state_result');
      return null;
    }
    return result;
  } catch (error) {
    logFallbackOnce('pool_run_failed', error);
    return null;
  }
}
