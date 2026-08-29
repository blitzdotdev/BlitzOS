// @vitest-environment jsdom

import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionId } from '@lody/shared';
import { useSessionConversationDiffData } from '../src/components/sessions/use-session-conversation-diff-data';
import type { SessionConversationDiffMode } from '../src/components/sessions/use-session-conversation-diff-data';
import type { SessionFileProvider } from '../src/lib/session-file-provider';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const README_PATHS = ['README.md'];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
});

describe('useSessionConversationDiffData', () => {
  it('matches conversation fileDiff checkpoints by normalized path', async () => {
    vi.useFakeTimers();
    const checkpoint = {
      filePath: 'README.md',
      add: 1,
      del: 0,
      cc: {
        v: 1 as const,
        fileId: 't:000014',
        opId: '2:5',
        baseOpId: '1:5',
      },
    };
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'missing-text-frontiers',
    }));

    render(
      <DiffDataHarness
        mode="conversation"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[checkpoint]}
        fileProvider={createDiffProvider(getDiff)}
        onUpdate={() => undefined}
      />
    );

    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledWith('./README.md', 'turn-1', checkpoint);
  });

  it('ignores fileDiff checkpoints in All Changes mode', async () => {
    vi.useFakeTimers();
    const checkpoint = {
      filePath: 'README.md',
      add: 1,
      del: 0,
      cc: {
        v: 1 as const,
        fileId: 't:000014',
        opId: '2:5',
        baseOpId: '1:5',
      },
    };
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'missing-text-frontiers',
    }));

    render(
      <DiffDataHarness
        mode="base"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[checkpoint]}
        fileProvider={createDiffProvider(getDiff)}
        onUpdate={() => undefined}
      />
    );

    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledWith('./README.md', undefined, undefined);
  });

  it('keeps loaded All Changes data when equivalent checkpoints rerender', async () => {
    vi.useFakeTimers();
    const checkpoint = {
      filePath: 'README.md',
      add: 1,
      del: 0,
      cc: {
        v: 1 as const,
        fileId: 't:000014',
        opId: '2:5',
        baseOpId: '1:5',
      },
    };
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'ready',
      path: pathOrFileId,
      oldSnapshot: { kind: 'text', text: 'base\n' },
      newSnapshot: { kind: 'text', text: 'base\nhello\n' },
    }));
    const onUpdate = vi.fn();
    const provider = createDiffProvider(getDiff);

    render(
      <DiffDataHarness
        mode="base"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[checkpoint]}
        fileProvider={provider}
        onUpdate={onUpdate}
      />
    );

    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(1);
    expect(getDiff).toHaveBeenCalledWith('./README.md', undefined, undefined);

    rerender(
      <DiffDataHarness
        mode="base"
        filePaths={['./README.md']}
        loadFilePaths={['./README.md']}
        priorityFilePath="./README.md"
        fileDiffs={[{ ...checkpoint, cc: { ...checkpoint.cc } }]}
        fileProvider={provider}
        onUpdate={onUpdate}
      />
    );

    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls.at(-1)?.[0].resolvedByPath['./README.md']).toMatchObject({
      status: 'ready',
      oldSnapshot: { kind: 'text', text: 'base\n' },
      newSnapshot: { kind: 'text', text: 'base\nhello\n' },
    });
  });

  it('does not auto-retry provider-declared unavailable diff states', async () => {
    vi.useFakeTimers();
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async (pathOrFileId) => ({
      status: 'unavailable',
      path: pathOrFileId,
      reason: 'missing-text-frontiers',
    }));

    render(
      <DiffDataHarness fileProvider={createDiffProvider(getDiff)} onUpdate={() => undefined} />
    );

    await flushMicrotasks();
    expect(getDiff.mock.calls.length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flushMicrotasks();
    const stableCalls = getDiff.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledTimes(stableCalls);
  });

  it('retries thrown diff read failures only up to the configured retry limit', async () => {
    vi.useFakeTimers();
    const getDiff = vi.fn<SessionFileProvider['getDiff']>(async () => {
      throw new Error('temporary diff read failure');
    });

    render(
      <DiffDataHarness fileProvider={createDiffProvider(getDiff)} onUpdate={() => undefined} />
    );

    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(3);
  });

  it('keeps provider diff RPC concurrency bounded across resolved state updates', async () => {
    vi.useFakeTimers();
    const paths = Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`);
    type DiffResult = Awaited<ReturnType<SessionFileProvider['getDiff']>>;
    const pending = new Map<string, ReturnType<typeof createDeferred<DiffResult>>>();
    const getDiff = vi.fn<SessionFileProvider['getDiff']>((pathOrFileId) => {
      const deferred = createDeferred<DiffResult>();
      pending.set(pathOrFileId, deferred);
      return deferred.promise;
    });

    render(
      <DiffDataHarness
        mode="base"
        filePaths={paths}
        loadFilePaths={paths}
        priorityFilePath={paths[0]}
        fileProvider={createDiffProvider(getDiff)}
        onUpdate={() => undefined}
      />
    );

    await flushMicrotasks();
    expect(getDiff.mock.calls.map(([path]) => path)).toEqual([paths[0]]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    await flushMicrotasks();
    expect(getDiff).toHaveBeenCalledTimes(4);

    await act(async () => {
      pending.get(paths[0])?.resolve({
        status: 'ready',
        path: paths[0],
        oldSnapshot: { kind: 'text', text: 'old\n' },
        newSnapshot: { kind: 'text', text: 'new\n' },
      });
      await Promise.resolve();
    });
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300);
    });
    await flushMicrotasks();

    expect(getDiff).toHaveBeenCalledTimes(5);
  });
});

function render(node: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rerender(node);
}

function rerender(node: ReactNode): void {
  act(() => {
    root?.render(node);
  });
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  if (!resolve || !reject) {
    throw new Error('Failed to create deferred promise');
  }
  return { promise, resolve, reject };
}

function DiffDataHarness({
  fileProvider,
  mode = 'base',
  filePaths = README_PATHS,
  loadFilePaths = README_PATHS,
  priorityFilePath = 'README.md',
  fileDiffs,
  onUpdate,
}: {
  readonly fileProvider: SessionFileProvider;
  readonly mode?: SessionConversationDiffMode;
  readonly filePaths?: string[];
  readonly loadFilePaths?: string[];
  readonly priorityFilePath?: string;
  readonly fileDiffs?: Parameters<typeof useSessionConversationDiffData>[0]['fileDiffs'];
  readonly onUpdate: (result: ReturnType<typeof useSessionConversationDiffData>) => void;
}) {
  const result = useSessionConversationDiffData({
    sessionId: 'session-1' as SessionId,
    turnId: mode === 'base' ? 'all-changes' : 'turn-1',
    mode,
    filePaths,
    loadFilePaths,
    priorityFilePath,
    fileDiffs,
    fileProvider,
  });

  useEffect(() => {
    onUpdate(result);
  }, [onUpdate, result]);

  return null;
}

function createDiffProvider(getDiff: SessionFileProvider['getDiff']): SessionFileProvider {
  return {
    kind: 'code-collab',
    getDiff,
  } as SessionFileProvider;
}
