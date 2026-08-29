// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionForkDestinationPopover,
  getSessionForkDestinationOptions,
} from '../src/components/sessions/session-fork-destination-menu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string): string => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('getSessionForkDestinationOptions', () => {
  const t = (_key: string, fallback: string) => fallback;

  it('only offers the current workspace when worktree support is hidden', () => {
    expect(getSessionForkDestinationOptions(t, 'hidden').map((option) => option.id)).toEqual([
      'shared',
    ]);
  });

  it('disables the worktree option while Git status is still resolving', () => {
    const worktree = getSessionForkDestinationOptions(t, 'checking').find(
      (option) => option.id === 'new-worktree'
    );
    expect(worktree?.disabled).toBe(true);
    expect(worktree?.hint).toBe('Checking Git status…');
  });
});

describe('SessionForkDestinationPopover', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderPopover = async (
    props: Partial<ComponentProps<typeof SessionForkDestinationPopover>> = {}
  ): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          SessionForkDestinationPopover,
          {
            open: true,
            worktreeAvailability: 'available',
            onSelect: vi.fn(),
            ...props,
          },
          createElement('button', { type: 'button' }, 'Fork')
        )
      );
    });
  };

  it('lists both destinations when a new worktree is available', async () => {
    await renderPopover();
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      'Current workspaceNew tab · shares files and uncommitted changes',
      'New worktreeNew session · from the latest committed HEAD',
    ]);
  });

  it('does not leave the first destination focused after opening', async () => {
    await renderPopover();
    const firstItem = document.querySelector('[role="menuitem"]');
    expect(firstItem).toBeInstanceOf(HTMLButtonElement);
    expect(document.activeElement).not.toBe(firstItem);
  });

  it('selects the current workspace from a menu, not a modal dialog', async () => {
    const onSelect = vi.fn();
    await renderPopover({ onSelect });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    const shared = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Current workspace')
    );
    await act(async () => shared?.click());
    expect(onSelect).toHaveBeenCalledWith('shared');
  });
});
