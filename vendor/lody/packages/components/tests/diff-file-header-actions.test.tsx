// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

import { DiffFileHeaderActions } from '../src/ui/diff-viewer/diff-file-header-actions';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DiffFileHeaderActions', () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('copies the path and does not collapse the parent header', async () => {
    const parentClick = vi.fn();
    const onOpenFile = vi.fn();

    act(() => {
      root.render(
        createElement(
          'div',
          { onClick: parentClick },
          createElement(DiffFileHeaderActions, {
            path: 'docs/acp-session-fork-worktree.md',
            onOpenFile,
          })
        )
      );
    });

    const copyButton = container.querySelector(
      'button[aria-label="Copy file path"]'
    ) as HTMLButtonElement;
    expect(copyButton).toBeTruthy();

    await act(async () => {
      copyButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(writeText).toHaveBeenCalledWith('docs/acp-session-fork-worktree.md');
    expect(parentClick).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('opens the file without toggling the parent header', () => {
    const parentClick = vi.fn();
    const onOpenFile = vi.fn();

    act(() => {
      root.render(
        createElement(
          'div',
          { onClick: parentClick },
          createElement(DiffFileHeaderActions, {
            path: 'docs/acp-session-fork-worktree.md',
            onOpenFile,
          })
        )
      );
    });

    const openButton = container.querySelector(
      'button[aria-label="Open file"]'
    ) as HTMLButtonElement;
    expect(openButton).toBeTruthy();

    act(() => {
      openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onOpenFile).toHaveBeenCalledWith('docs/acp-session-fork-worktree.md');
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('hides the open-file button when no opener is wired', () => {
    act(() => {
      root.render(createElement(DiffFileHeaderActions, { path: 'src/app.ts' }));
    });

    expect(container.querySelector('button[aria-label="Open file"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Copy file path"]')).toBeTruthy();
  });
});
