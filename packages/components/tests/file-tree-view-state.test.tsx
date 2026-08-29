// @vitest-environment jsdom

// Regression coverage for "the folders all collapse again": opening a file from
// the side panel's Files tab selects a viewer tab, which UNMOUNTS the tree. With
// the expanded set living only in component state, coming back to Files rendered
// a fully collapsed tree. A keyed tree must restore its expanded folders (and
// its selected row) across that unmount, while an unkeyed one stays ephemeral.

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileTreeProviderView } from '../src/components/sessions/components/file-tree-view';
import { clearFileTreeViewStates } from '../src/lib/file-tree-view-state';
import type { FileWorkspaceProvider } from '../src/lib/file-workspace-provider';
import { initI18n } from '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Small enough to stay under the virtualization threshold, so every visible row
// is committed and the assertions can read the tree directly.
const PATHS = ['src/lib/util.ts', 'src/lib/deep/inner.ts', 'README.md'];

function createReadyProvider(paths: readonly string[]): FileWorkspaceProvider {
  return {
    kind: 'code-collab',
    getState: () => ({ kind: 'code-collab', ready: true, sourceState: 'live-readonly' }),
    listFiles: async () =>
      paths.map((path) => ({ path, kind: 'text' as const, sourceState: 'live-readonly' as const })),
  } as unknown as FileWorkspaceProvider;
}

describe('file tree view state across unmount', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    await initI18n('en');
    clearFileTreeViewStates();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  afterEach(async () => {
    await unmount();
    container?.remove();
    container = null;
    clearFileTreeViewStates();
    vi.unstubAllGlobals();
  });

  async function render(node: ReactNode): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(node);
    });
    return container;
  }

  async function unmount(): Promise<void> {
    if (!root) return;
    await act(async () => root?.unmount());
    root = null;
  }

  function rowLabels(host: HTMLElement): string[] {
    return [...host.querySelectorAll('[role="treeitem"]')].map(
      (row) => row.querySelector('span')?.textContent ?? ''
    );
  }

  function rowByLabel(host: HTMLElement, label: string): HTMLElement {
    const row = [...host.querySelectorAll('[role="treeitem"]')].find(
      (candidate) => candidate.querySelector('span')?.textContent === label
    );
    if (!row) throw new Error(`row "${label}" is not rendered`);
    return row as HTMLElement;
  }

  async function click(element: HTMLElement): Promise<void> {
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function treeElement(viewStateKey?: string) {
    return createElement(FileTreeProviderView, {
      fileProvider: createReadyProvider(PATHS),
      fileProviderPending: false,
      handleOpenFile: () => undefined,
      viewStateKey,
    });
  }

  it('restores expanded folders and the selected row for the same key', async () => {
    let host = await render(treeElement('session-files:s1'));

    expect(rowLabels(host)).toEqual(['src', 'README.md']);
    await click(rowByLabel(host, 'src'));
    await click(rowByLabel(host, 'lib'));
    await click(rowByLabel(host, 'util.ts'));
    expect(rowLabels(host)).toEqual(['src', 'lib', 'deep', 'util.ts', 'README.md']);

    // The viewer tab takes over the panel and the tree goes away.
    await unmount();
    container?.remove();

    host = await render(treeElement('session-files:s1'));
    expect(rowLabels(host)).toEqual(['src', 'lib', 'deep', 'util.ts', 'README.md']);
    expect(rowByLabel(host, 'src').getAttribute('aria-expanded')).toBe('true');
    expect(rowByLabel(host, 'util.ts').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps each tree independent and leaves unkeyed trees ephemeral', async () => {
    let host = await render(treeElement('session-files:s1'));
    await click(rowByLabel(host, 'src'));
    expect(rowLabels(host)).toEqual(['src', 'lib', 'README.md']);

    await unmount();
    container?.remove();

    // A different session must not inherit the first session's expansion.
    host = await render(treeElement('session-files:s2'));
    expect(rowLabels(host)).toEqual(['src', 'README.md']);

    await unmount();
    container?.remove();

    // No key at all: state stays component-local, exactly as before.
    host = await render(treeElement(undefined));
    await click(rowByLabel(host, 'src'));
    expect(rowLabels(host)).toEqual(['src', 'lib', 'README.md']);

    await unmount();
    container?.remove();

    host = await render(treeElement(undefined));
    expect(rowLabels(host)).toEqual(['src', 'README.md']);
  });
});
