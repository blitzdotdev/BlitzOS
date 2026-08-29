// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workerPoolMocks = vi.hoisted(() => {
  class FakeWorkerPoolManager {
    static readonly instances: FakeWorkerPoolManager[] = [];

    readonly initialOptions: unknown;
    readonly setRenderOptions = vi.fn(async (_options: unknown) => undefined);
    readonly terminate = vi.fn();

    constructor(_poolOptions: unknown, renderOptions: unknown) {
      this.initialOptions = renderOptions;
      FakeWorkerPoolManager.instances.push(this);
    }
  }

  return { FakeWorkerPoolManager, instances: FakeWorkerPoolManager.instances };
});

vi.mock('@pierre/diffs/worker', () => ({
  WorkerPoolManager: workerPoolMocks.FakeWorkerPoolManager,
}));

vi.mock('@pierre/diffs/worker/worker.js?worker', () => ({
  default: class FakeDiffRenderWorker {},
}));

import {
  configureDiffRenderWorkerPool,
  createDiffRenderWorkerPool,
  terminateDiffRenderWorkerPools,
} from '../src/ui/diff-viewer/diff-render-worker';

describe('shared diff render worker pools', () => {
  beforeEach(() => {
    terminateDiffRenderWorkerPools();
    workerPoolMocks.instances.length = 0;
  });

  afterEach(() => {
    terminateDiffRenderWorkerPools();
  });

  it('reuses one worker for each line-diff render profile', () => {
    const wordOptions = {
      lineDiffType: 'word' as const,
      theme: 'github-dark',
      tokenizeMaxLineLength: 20_000,
    };
    const firstWordPool = createDiffRenderWorkerPool(wordOptions);
    const secondWordPool = createDiffRenderWorkerPool({ ...wordOptions });
    const lineOnlyPool = createDiffRenderWorkerPool({
      ...wordOptions,
      lineDiffType: 'none',
    });

    expect(firstWordPool).toBe(secondWordPool);
    expect(lineOnlyPool).not.toBe(firstWordPool);
    expect(workerPoolMocks.instances).toHaveLength(2);
  });

  it('deduplicates and serializes theme updates for a shared pool', async () => {
    const initialOptions = {
      lineDiffType: 'word' as const,
      theme: 'github-dark',
      tokenizeMaxLineLength: 20_000,
    };
    const pool = createDiffRenderWorkerPool(initialOptions);
    expect(pool).toBeDefined();

    const manager = workerPoolMocks.instances[0];
    expect(manager).toBeDefined();
    await configureDiffRenderWorkerPool(pool!, { ...initialOptions });
    expect(manager!.setRenderOptions).not.toHaveBeenCalled();

    let resolveFirstUpdate: (() => void) | undefined;
    manager!.setRenderOptions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstUpdate = resolve;
        })
    );
    const lightOptions = { ...initialOptions, theme: 'github-light' };
    const customOptions = { ...initialOptions, theme: 'lody-custom' };

    const firstUpdate = configureDiffRenderWorkerPool(pool!, lightOptions);
    const latestUpdate = configureDiffRenderWorkerPool(pool!, customOptions);
    expect(manager!.setRenderOptions).toHaveBeenCalledTimes(1);
    expect(manager!.setRenderOptions).toHaveBeenLastCalledWith(lightOptions);

    resolveFirstUpdate?.();
    await Promise.all([firstUpdate, latestUpdate]);

    expect(manager!.setRenderOptions).toHaveBeenCalledTimes(2);
    expect(manager!.setRenderOptions).toHaveBeenLastCalledWith(customOptions);
    await configureDiffRenderWorkerPool(pool!, { ...customOptions });
    expect(manager!.setRenderOptions).toHaveBeenCalledTimes(2);
  });
});
