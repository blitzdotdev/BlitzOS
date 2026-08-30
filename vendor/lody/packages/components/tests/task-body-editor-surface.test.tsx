// @vitest-environment jsdom

import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHandle } from '@meowdown/react';

const meowdownMock = vi.hoisted(() => ({
  attachImmediately: true,
  markdown: '',
  handleRef: null as Ref<EditorHandle> | null,
  onDocChange: null as (() => void) | null,
  setState: vi.fn<(markdown?: string) => void>(),
  unmount: vi.fn(),
}));

const assignRef = (ref: Ref<EditorHandle> | null, value: EditorHandle | null): void => {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
};

const editorHandle = {
  getMarkdown: () => meowdownMock.markdown,
  setState: (markdown?: string) => {
    meowdownMock.markdown = markdown ?? '';
    meowdownMock.setState(markdown);
  },
  getSelectedText: () => '',
  refreshMarkdownRendering: vi.fn(),
  editor: {
    mounted: true,
    unmount: meowdownMock.unmount,
  },
} as unknown as EditorHandle;

vi.mock('@meowdown/react', () => ({
  MeowdownEditor: ({
    handleRef,
    initialMarkdown,
    onDocChange,
  }: {
    handleRef?: Ref<EditorHandle>;
    initialMarkdown: string;
    onDocChange: () => void;
  }) => {
    meowdownMock.handleRef = handleRef ?? null;
    meowdownMock.onDocChange = onDocChange;
    if (!meowdownMock.markdown) {
      meowdownMock.markdown = initialMarkdown;
    }

    useLayoutEffect(() => {
      if (meowdownMock.attachImmediately) {
        assignRef(handleRef ?? null, editorHandle);
      }
      return () => assignRef(handleRef ?? null, null);
    }, [handleRef]);

    return <div data-testid="mock-editor" />;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('../src/lib/commands', () => ({
  useKeyScope: vi.fn(),
}));

vi.mock('../src/hooks/use-task-image', () => ({
  useTaskImageResolver: () => ({
    resolveImageUrl: vi.fn(),
    cacheVersion: 0,
  }),
}));

vi.mock('../src/components/tasks/task-body-selection-toolbar', () => ({
  TaskBodySelectionToolbar: () => null,
}));

vi.mock('../src/components/tasks/task-body-insert-menu', () => ({
  TaskBodyInsertMenu: () => null,
}));

import TaskBodyEditorSurface from '../src/components/tasks/task-body-editor-surface';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('TaskBodyEditorSurface lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    meowdownMock.attachImmediately = true;
    meowdownMock.markdown = '';
    meowdownMock.handleRef = null;
    meowdownMock.onDocChange = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
  });

  it('replays a task body that arrived before the editor handle was ready', async () => {
    meowdownMock.attachImmediately = false;
    const onCommit = vi.fn();

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="" onCommit={onCommit} />);
    });
    await act(async () => {
      root.render(<TaskBodyEditorSurface value="persisted body" onCommit={onCommit} />);
    });

    expect(meowdownMock.setState).not.toHaveBeenCalled();

    await act(async () => {
      assignRef(meowdownMock.handleRef, editorHandle);
    });

    expect(meowdownMock.setState).toHaveBeenCalledWith('persisted body');
    expect(meowdownMock.markdown).toBe('persisted body');
  });

  it('flushes an edited body when the task closes before the idle timer fires', async () => {
    const onCommit = vi.fn();

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="" onCommit={onCommit} />);
    });

    meowdownMock.markdown = 'draft before close';
    await act(async () => {
      meowdownMock.onDocChange?.();
    });
    await act(async () => {
      root.unmount();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('draft before close');
    expect(meowdownMock.unmount).toHaveBeenCalledTimes(1);

    root = createRoot(container);
  });

  it('reissues an in-flight body when the editor unmounts', async () => {
    vi.useFakeTimers();
    let resolveCommit: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      resolveCommit = resolve;
    });
    const onCommit = vi.fn(() => inFlight);

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="" onCommit={onCommit} />);
    });

    meowdownMock.markdown = 'draft while saving';
    await act(async () => {
      meowdownMock.onDocChange?.();
      vi.advanceTimersByTime(1_200);
    });
    expect(onCommit).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith('draft while saving');

    resolveCommit?.();
    await Promise.resolve();
    root = createRoot(container);
  });

  it('does not re-adopt the stale empty body while a local commit is awaiting its echo', async () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="" onCommit={onCommit} />);
    });

    meowdownMock.markdown = 'new local body';
    await act(async () => {
      meowdownMock.onDocChange?.();
      vi.advanceTimersByTime(1_200);
    });

    expect(onCommit).toHaveBeenCalledWith('new local body');
    meowdownMock.setState.mockClear();

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="" onCommit={onCommit} />);
    });

    expect(meowdownMock.setState).not.toHaveBeenCalled();
    expect(meowdownMock.markdown).toBe('new local body');

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="new local body" onCommit={onCommit} />);
    });
    expect(meowdownMock.setState).not.toHaveBeenCalled();
  });

  it('keeps a rejected body dirty and retries it on blur', async () => {
    vi.useFakeTimers();
    const onCommit = vi
      .fn<(next: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce();

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="" onCommit={onCommit} />);
    });

    meowdownMock.markdown = 'unsaved local body';
    await act(async () => {
      meowdownMock.onDocChange?.();
      vi.advanceTimersByTime(1_200);
      await Promise.resolve();
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    meowdownMock.setState.mockClear();

    // A reconnect can replay the old empty document after the failed write.
    // It must not erase the local draft merely because the editor is idle.
    await act(async () => {
      root.render(<TaskBodyEditorSurface value="" onCommit={onCommit} />);
    });
    expect(meowdownMock.setState).not.toHaveBeenCalled();
    expect(meowdownMock.markdown).toBe('unsaved local body');

    const editor = container.querySelector('.task-body-editor');
    expect(editor).not.toBeNull();
    await act(async () => {
      editor?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith('unsaved local body');

    await act(async () => {
      root.render(<TaskBodyEditorSurface value="unsaved local body" onCommit={onCommit} />);
    });
    expect(meowdownMock.setState).not.toHaveBeenCalled();
  });
});
