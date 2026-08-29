// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoroSidebar } from '../src/components/loro-sidebar';

/**
 * The sidebar's Tasks row carries a quick-add `+`. Two things about it are easy
 * to break and invisible in review:
 *
 * - it must not exist while the Tasks beta is off (the row itself is gated, and
 *   an entry that leaks is the whole risk the gate exists for), and
 * - pressing it must capture a task, NOT navigate to Tasks. The control sits on
 *   top of the row button, so nesting it (or letting the click through) would
 *   quietly turn quick capture into navigation.
 */
const NEW_TASK_LABEL = 'New task';

describe('sidebar Tasks quick add', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom has no matchMedia; the sidebar reads it for the mobile layout.
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
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

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const render = (props: Partial<Parameters<typeof LoroSidebar>[0]>): void => {
    act(() => {
      root.render(<LoroSidebar workspaceName="Acme" workspaces={[]} {...props} />);
    });
  };

  const quickAddButton = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find(
      (button) => button.getAttribute('aria-label') === NEW_TASK_LABEL
    );

  const tasksRowButton = (): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === 'Tasks'
    );

  it('is absent while the Tasks beta is off', () => {
    render({ showTasks: false, onNewTaskClicked: vi.fn() });

    expect(tasksRowButton()).toBeUndefined();
    expect(quickAddButton()).toBeUndefined();
  });

  it('is absent when the host offers no capture handler', () => {
    render({ showTasks: true });

    expect(tasksRowButton()).toBeDefined();
    expect(quickAddButton()).toBeUndefined();
  });

  it('captures a task instead of navigating to Tasks', () => {
    const onNewTaskClicked = vi.fn();
    const onTasksClicked = vi.fn();
    render({ showTasks: true, onNewTaskClicked, onTasksClicked });

    const button = quickAddButton();
    expect(button).toBeDefined();
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onNewTaskClicked).toHaveBeenCalledTimes(1);
    expect(onTasksClicked).not.toHaveBeenCalled();
    // A `+` rendered inside the row button would be invalid markup and would
    // route the press to the row; keep them siblings.
    expect(button?.closest('button')).toBe(button);
  });
});
