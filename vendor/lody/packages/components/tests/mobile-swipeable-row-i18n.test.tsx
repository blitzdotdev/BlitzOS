// @vitest-environment jsdom

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

import { MobileSwipeableRow } from '../src/components/mobile/mobile-swipeable-row';
import { initI18n } from '../src/i18n';

describe('MobileSwipeableRow i18n labels', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function renderRow(props: Parameters<typeof MobileSwipeableRow>[0]) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(MobileSwipeableRow, props, createElement('div', null, 'Conversation row'))
      );
    });
  }

  it('renders active swipe actions in English when the language is English', async () => {
    await initI18n('en');

    renderRow({
      isPinned: false,
      onTogglePin: vi.fn(),
      onArchive: vi.fn(),
    });

    expect(container?.querySelector('button[aria-label="Pin"]')).not.toBeNull();
    expect(container?.querySelector('button[aria-label="Archive"]')).not.toBeNull();
    expect(container?.textContent).toContain('Pin');
    expect(container?.textContent).toContain('Archive');
    expect(container?.textContent).not.toContain('置顶');
    expect(container?.textContent).not.toContain('归档');
  });

  it('renders archived swipe actions in English when the language is English', async () => {
    await initI18n('en');

    renderRow({
      variant: 'archived',
      onRestore: vi.fn(),
      onDelete: vi.fn(),
    });

    expect(container?.querySelector('button[aria-label="Restore"]')).not.toBeNull();
    expect(container?.querySelector('button[aria-label="Delete"]')).not.toBeNull();
    expect(container?.textContent).toContain('Restore');
    expect(container?.textContent).toContain('Delete');
    expect(container?.textContent).not.toContain('恢复');
    expect(container?.textContent).not.toContain('删除');
  });
});
