// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => {
  const pool = { kind: 'shared-diff-render-worker' };
  return {
    pool,
    configurePool: vi.fn(() => Promise.resolve()),
    createPool: vi.fn(() => pool),
  };
});

vi.mock('../src/ui/diff-viewer/diff-render-worker', () => ({
  configureDiffRenderWorkerPool: workerMocks.configurePool,
  createDiffRenderWorkerPool: workerMocks.createPool,
}));

vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react');
  const WorkerPoolContext = React.createContext<unknown>(undefined);
  return {
    FileDiff: () => {
      const workerPool = React.useContext(WorkerPoolContext);
      return React.createElement('div', {
        'data-testid': 'file-diff',
        'data-render-worker': workerPool === workerMocks.pool ? 'shared' : 'main-thread',
      });
    },
    WorkerPoolContext,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../src/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../src/theme-provider', () => ({
  useActiveVSCodeDiffThemeName: () => undefined,
  useResolvedTheme: () => 'dark',
}));

import { DiffViewer } from '../src/ui/diff-viewer/diff-viewer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DiffViewer render worker routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    workerMocks.configurePool.mockClear();
    workerMocks.createPool.mockClear();
    workerMocks.createPool.mockReturnValue(workerMocks.pool);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps a sub-threshold syntax diff off the main-thread highlighter', async () => {
    const oldText = 'export const mode = "old";\n';
    const newText = 'export const mode = "new";\n';
    expect(oldText.length + newText.length).toBeLessThan(200_000);

    await act(async () => {
      root.render(
        createElement(DiffViewer, {
          path: 'src/config.ts',
          oldText,
          newText,
          showHeader: false,
        })
      );
    });

    expect(
      container.querySelector('[data-testid="file-diff"]')?.getAttribute('data-render-worker')
    ).toBe('shared');
    expect(workerMocks.createPool).toHaveBeenCalledTimes(1);
    expect(workerMocks.configurePool).toHaveBeenCalledWith(
      workerMocks.pool,
      expect.objectContaining({ lineDiffType: 'word' })
    );
  });

  it('retains the main-thread fallback when the runtime cannot create a worker pool', async () => {
    workerMocks.createPool.mockReturnValue(undefined);

    await act(async () => {
      root.render(
        createElement(DiffViewer, {
          path: 'README.md',
          oldText: 'before\n',
          newText: 'after\n',
          showHeader: false,
        })
      );
    });

    expect(
      container.querySelector('[data-testid="file-diff"]')?.getAttribute('data-render-worker')
    ).toBe('main-thread');
    expect(workerMocks.configurePool).not.toHaveBeenCalled();
  });
});
