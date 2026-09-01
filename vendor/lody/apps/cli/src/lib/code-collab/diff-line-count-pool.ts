import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogger } from '@/utils/logger';

import { computeLineCounts } from './diff-line-counts';
import {
  runDiffWorkerTask,
  type DiffWorkerTaskInput,
  type DiffWorkerTaskResult,
} from './diff-worker-task';
import { tinypoolRuntimeOptions } from './tinypool-runtime';

/**
 * Off-main-thread line counting for turn diffs.
 *
 * In the published/Electron build this module is bundled into `dist/index.js`, so the
 * worker entry sits next to it at `dist/diff-worker.js`. We drive it with a small
 * Tinypool. When that sibling is missing — for example, in source-level tests without
 * a built worker — we compute inline on the main thread. Any pool init/run failure also
 * degrades to inline so line counts never block turn persistence.
 *
 * Tinypool is kept external from the bundle (it resolves its own `entry/worker.js`
 * relative to its package dir) and is staged into the Electron app alongside the
 * other external runtime deps.
 */

type TinypoolInstance = {
  run(payload: DiffWorkerTaskInput): Promise<DiffWorkerTaskResult>;
  destroy(): Promise<void>;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILENAME = path.join(MODULE_DIR, 'diff-worker.js');

let pool: TinypoolInstance | null = null;
let inlineOnly = false;
let initPromise: Promise<TinypoolInstance | null> | null = null;
const loggedFallbackReasons = new Set<string>();
let inlineFallbackReason = 'unknown';

const INLINE_SLOW_THRESHOLD_MS = 1_000;

function textBytes(value: string | null): number {
  return value === null ? 0 : Buffer.byteLength(value, 'utf8');
}

function logInlineFallbackOnce(reason: string, error?: unknown): void {
  const key = reason;
  if (loggedFallbackReasons.has(key)) return;
  loggedFallbackReasons.add(key);
  const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error);
  getLogger('code-collab').warn(
    `[code-collab] diff line-count worker unavailable; falling back to main-thread computation reason=${reason} worker=${WORKER_FILENAME}${
      detail ? ` error=${detail}` : ''
    }`
  );
}

function markInlineFallback(reason: string, error?: unknown): void {
  inlineOnly = true;
  inlineFallbackReason = reason;
  logInlineFallbackOnce(reason, error);
}

function logInlineComputation(args: {
  readonly reason: string;
  readonly startedAtMs: number;
  readonly oldText: string | null;
  readonly newText: string | null;
}): void {
  const durationMs = Date.now() - args.startedAtMs;
  const message = `[code-collab] diff line-count inline computation completed reason=${
    args.reason
  } durationMs=${durationMs} oldBytes=${textBytes(args.oldText)} newBytes=${textBytes(
    args.newText
  )}`;
  const logger = getLogger('code-collab');
  if (durationMs >= INLINE_SLOW_THRESHOLD_MS) {
    logger.warn(message);
  } else {
    logger.debug(message);
  }
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
  // Avoid the `new URL(..., import.meta.url)` asset pattern Vite rewrites; the worker
  // is emitted as a plain sibling entry. Its absence marks a non-bundled (dev) run.
  if (!existsSync(WORKER_FILENAME)) {
    markInlineFallback('worker_missing');
    return null;
  }
  try {
    const { default: Tinypool } = await import('tinypool');
    pool = new Tinypool({
      filename: WORKER_FILENAME,
      minThreads: 0,
      maxThreads: 2,
      idleTimeout: 30_000,
      ...tinypoolRuntimeOptions(),
    }) as unknown as TinypoolInstance;
    return pool;
  } catch (error) {
    markInlineFallback('pool_init_failed', error);
    return null;
  }
}

/** Compute `[add, del]` line counts, off the main thread when a worker is available. */
export async function computeLineCountsAsync(
  oldText: string | null,
  newText: string | null
): Promise<[number, number]> {
  const activePool = await getPool();
  if (!activePool) {
    const startedAtMs = Date.now();
    const result = computeLineCounts(oldText, newText);
    logInlineComputation({ reason: inlineFallbackReason, startedAtMs, oldText, newText });
    return result;
  }
  try {
    const result = await activePool.run({ kind: 'line-count', oldText, newText });
    if (result.kind !== 'line-count') throw new Error('Unexpected diff worker result.');
    return result.lineCounts;
  } catch (error) {
    logInlineFallbackOnce('pool_run_failed', error);
    const startedAtMs = Date.now();
    const result = computeLineCounts(oldText, newText);
    logInlineComputation({ reason: 'pool_run_failed', startedAtMs, oldText, newText });
    return result;
  }
}

/** Count lines and prove the proposed new snapshot still matches disk in one worker task. */
export async function computeTurnEvidenceAsync(
  oldText: string | null,
  newText: string | null,
  absolutePath: string
): Promise<{ readonly lineCounts: [number, number]; readonly newIsCurrent: boolean }> {
  const input = { kind: 'turn-evidence', oldText, newText, absolutePath } as const;
  const activePool = await getPool();
  if (!activePool) {
    const result = await runDiffWorkerTask(input);
    if (result.kind !== 'turn-evidence') throw new Error('Unexpected inline diff result.');
    return result;
  }
  try {
    const result = await activePool.run(input);
    if (result.kind !== 'turn-evidence') throw new Error('Unexpected diff worker result.');
    return result;
  } catch (error) {
    // Unlike line-count-only callers, a failed disk proof must not silently
    // degrade to a stale head. Retry inline and propagate real I/O failures.
    logInlineFallbackOnce('turn_evidence_pool_run_failed', error);
    const result = await runDiffWorkerTask(input);
    if (result.kind !== 'turn-evidence') {
      throw new Error('Unexpected inline diff result after worker pool failure.', {
        cause: error,
      });
    }
    return result;
  }
}

/** Tear down the worker pool (called on CLI shutdown paths). */
export async function destroyDiffLineCountPool(): Promise<void> {
  const active = pool;
  pool = null;
  initPromise = null;
  if (active) {
    try {
      await active.destroy();
    } catch {
      // best-effort
    }
  }
}
