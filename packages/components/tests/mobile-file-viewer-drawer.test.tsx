// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileFileViewerDrawer } from '../src/components/mobile/mobile-file-viewer-drawer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

vi.mock('../src/ui/drawer', async () => {
  const React = await import('react');
  const Passthrough = ({ children }: { readonly children?: ReactNode }) =>
    React.createElement('div', null, children);
  return {
    Drawer: Passthrough,
    DrawerContent: Passthrough,
    DrawerTitle: Passthrough,
  };
});

vi.mock('../src/components/mobile/vaul-drawer-edge-back-zone', async () => {
  const React = await import('react');
  return {
    VaulDrawerBody: ({ children }: { readonly children?: ReactNode }) =>
      React.createElement('div', null, children),
  };
});

vi.mock('../src/components/mobile/mobile-session-menu-sheet', async () => {
  const React = await import('react');
  return {
    MobileSessionMenuSheet: ({
      actions,
    }: {
      readonly actions: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly onClick: () => void;
      }>;
    }) =>
      React.createElement(
        'div',
        null,
        actions.map((action) =>
          React.createElement(
            'button',
            { key: action.id, type: 'button', onClick: action.onClick },
            action.label
          )
        )
      ),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function renderDrawer(onCopyMarkdown?: () => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(
        MobileFileViewerDrawer,
        {
          open: true,
          onOpenChange: vi.fn(),
          filePath: 'README.md',
          onCopyPath: vi.fn(),
          ...(onCopyMarkdown ? { onCopyMarkdown } : {}),
        },
        createElement('div', null, 'Markdown')
      )
    );
  });
  return container;
}

describe('MobileFileViewerDrawer', () => {
  it('adds a full Markdown copy action when the file view provides one', () => {
    const onCopyMarkdown = vi.fn();
    const view = renderDrawer(onCopyMarkdown);
    const action = Array.from(view.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy full Markdown'
    );

    expect(action).not.toBeUndefined();
    act(() => action?.click());
    expect(onCopyMarkdown).toHaveBeenCalledTimes(1);
  });

  it('omits the full Markdown copy action for other file types', () => {
    const view = renderDrawer();
    expect(view.textContent).not.toContain('Copy full Markdown');
    expect(view.textContent).toContain('Copy file path');
  });
});
