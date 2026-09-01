// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SaveTextConflictError,
  useCodeCollabSaveText,
  type UseCodeCollabSaveTextResult,
} from '../src/hooks/use-code-collab-save-text';
import type { SessionFileOpenResult, SessionFileProvider } from '../src/lib/session-file-provider';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

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

describe('useCodeCollabSaveText', () => {
  it('keeps edits dirty in memory until flush explicitly saves them', async () => {
    vi.useFakeTimers();
    const saveText = vi.fn(async (_pathOrFileId: string, text: string) => readyResult(text));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(saveText).not.toHaveBeenCalled();
    expect(hook?.status.kind).toBe('pending');

    await act(async () => {
      await hook?.flush();
    });
    expect(saveText).toHaveBeenCalledTimes(1);
    expect(saveText).toHaveBeenLastCalledWith('t:file-1', 'draft');
    expect(hook?.status.kind).toBe('saved');
  });

  it('flush waits for an in-flight explicit save before saving newer pending text', async () => {
    const firstSave = createDeferred<SessionFileOpenResult>();
    const secondSave = createDeferred<SessionFileOpenResult>();
    const saveText = vi.fn((pathOrFileId: string, text: string) => {
      if (text === 'first') return firstSave.promise;
      if (text === 'second') return secondSave.promise;
      throw new Error(`unexpected save ${pathOrFileId}: ${text}`);
    });
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('first');
    });
    let firstFlush: Promise<void> | undefined;
    await act(async () => {
      firstFlush = hook?.flush();
      await flushMicrotasks();
    });
    expect(saveText).toHaveBeenCalledTimes(1);
    expect(saveText).toHaveBeenLastCalledWith('t:file-1', 'first');

    act(() => {
      hook?.onContentChange('second');
    });
    let secondFlush: Promise<void> | undefined;
    await act(async () => {
      secondFlush = hook?.flush();
      await flushMicrotasks();
    });
    expect(saveText).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve(readyResult('first'));
      await flushMicrotasks();
    });
    expect(saveText).toHaveBeenCalledTimes(2);
    expect(saveText).toHaveBeenLastCalledWith('t:file-1', 'second');

    await act(async () => {
      secondSave.resolve(readyResult('second'));
      await firstFlush;
      await secondFlush;
    });
    expect(hook?.status.kind).toBe('saved');
  });

  it('does not save pending text when switching files or unmounting', async () => {
    vi.useFakeTimers();
    const saveText = vi.fn(async (_pathOrFileId: string, text: string) => readyResult(text));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        fileId="t:file-1"
        onReady={(value) => {
          hook = value;
        }}
      />
    );
    act(() => {
      hook?.onContentChange('old file draft');
    });

    render(
      <SaveTextHarness
        provider={provider}
        fileId="t:file-2"
        onReady={(value) => {
          hook = value;
        }}
      />
    );
    act(() => {
      root?.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(saveText).not.toHaveBeenCalled();
  });

  it('warns before unloading while edits are dirty', () => {
    const saveText = vi.fn(async (_pathOrFileId: string, text: string) => readyResult(text));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps failed saves dirty and lets the next explicit flush retry', async () => {
    const saveText = vi
      .fn<SessionFileProvider['saveText']>()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(readyResult('draft'));
    const provider = createProvider(saveText);
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await hook?.flush();
    });
    expect(hook?.status.kind).toBe('error');

    await act(async () => {
      await hook?.flush();
    });
    expect(saveText).toHaveBeenCalledTimes(2);
    expect(hook?.status.kind).toBe('saved');
  });

  it('resolves save conflicts with the host conflict id', async () => {
    const saveText = vi.fn(async () => {
      throw new SaveTextConflictError('disk_changed', 'conflict-1', 'save_conflict: disk_changed');
    });
    const resolveSaveConflict = vi.fn(async () => {});
    const provider = createProvider(saveText, { resolveSaveConflict });
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await hook?.flush();
    });
    expect(hook?.status).toMatchObject({
      kind: 'conflict',
      conflict: 'disk_changed',
      conflictId: 'conflict-1',
    });

    await act(async () => {
      await hook?.resolveConflict('override');
    });
    expect(resolveSaveConflict).toHaveBeenCalledWith('t:file-1', {
      conflictId: 'conflict-1',
      resolution: 'override',
    });
    expect(hook?.status.kind).toBe('saved');
  });

  it('keeps the editor pending after loading conflict markers', async () => {
    const saveText = vi.fn(async () => {
      throw new SaveTextConflictError('disk_changed', 'conflict-1', 'save_conflict: disk_changed');
    });
    const resolveSaveConflict = vi.fn(async () => {});
    const provider = createProvider(saveText, { resolveSaveConflict });
    let hook: UseCodeCollabSaveTextResult | undefined;

    render(
      <SaveTextHarness
        provider={provider}
        onReady={(value) => {
          hook = value;
        }}
      />
    );

    act(() => {
      hook?.onContentChange('draft');
    });
    await act(async () => {
      await hook?.flush();
    });

    await act(async () => {
      await hook?.resolveConflict('load_with_conflicts');
    });
    expect(resolveSaveConflict).toHaveBeenCalledWith('t:file-1', {
      conflictId: 'conflict-1',
      resolution: 'load_with_conflicts',
    });
    expect(hook?.status.kind).toBe('pending');
  });
});

function SaveTextHarness(input: {
  readonly provider: SessionFileProvider;
  readonly fileId?: string;
  readonly enabled?: boolean;
  readonly onReady: (value: UseCodeCollabSaveTextResult) => void;
}): null {
  const hook = useCodeCollabSaveText({
    provider: input.provider,
    fileId: input.fileId ?? 't:file-1',
    enabled: input.enabled ?? true,
  });
  input.onReady(hook);
  return null;
}

function render(node: ReactNode): void {
  if (!container) {
    container = document.createElement('div');
    document.body.appendChild(container);
  }
  if (!root) {
    root = createRoot(container);
  }
  act(() => {
    root?.render(node);
  });
}

function createProvider(
  saveText: SessionFileProvider['saveText'],
  options: {
    readonly resolveSaveConflict?: SessionFileProvider['resolveSaveConflict'];
  } = {}
): SessionFileProvider {
  return {
    kind: 'code-collab',
    getState: () => ({ kind: 'code-collab', ready: true, sourceState: 'live-collaborative' }),
    listFiles: async () => [],
    searchFiles: async () => [],
    getFile: async () => null,
    openFile: async () => readyResult(''),
    saveText,
    ...(options.resolveSaveConflict === undefined
      ? {}
      : { resolveSaveConflict: options.resolveSaveConflict }),
    getDiff: async () => ({
      status: 'unavailable',
      path: 't:file-1',
      reason: 'metadata-only',
    }),
    listChangedFiles: async () => ({ status: 'ready', files: [] }),
  };
}

function readyResult(text: string): SessionFileOpenResult {
  return {
    status: 'ready',
    entry: {
      fileId: 't:file-1',
      path: 'README.md',
      kind: 'text',
      sourceState: 'live-collaborative',
    },
    snapshot: { kind: 'text', text },
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
