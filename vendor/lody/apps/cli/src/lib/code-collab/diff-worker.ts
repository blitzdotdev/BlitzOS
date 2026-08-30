import {
  runDiffWorkerTask,
  type DiffWorkerTaskInput,
  type DiffWorkerTaskResult,
} from './diff-worker-task';

/**
 * Tinypool worker entry. Built as a standalone Vite bundle (`dist/diff-worker.js`,
 * sibling of `dist/index.js`) with `diff` inlined, so it needs no `node_modules` at
 * runtime. The line-count computation can be expensive on pathological inputs, so it
 * runs here off the main thread; see `diff-line-counts.ts` for the fallback chain.
 */
export default async function diffWorker(
  input: DiffWorkerTaskInput
): Promise<DiffWorkerTaskResult> {
  return await runDiffWorkerTask(input);
}
