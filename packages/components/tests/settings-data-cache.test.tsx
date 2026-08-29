// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore, type Store } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceId } from '@lody/shared';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: mocks.useQuery,
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: true, isLoading: false }),
}));

vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { id: 'workspace-1' },
    hasAdminPermission: true,
  }),
}));

vi.mock('../src/hooks/useOrganization', () => ({
  useOrganization: () => ({
    activeOrganization: { id: 'workspace-1' },
    hasAdminPermission: true,
  }),
}));

import { currentWorkspaceIdAtom } from '../src/atoms/workspace-context';
import { SettingsDataCacheProvider } from '../src/components/settings/settings-data-cache';
import { TestCloudPlatformProvider } from './test-platform';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('SettingsDataCacheProvider', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let store: Store;

  beforeEach(() => {
    mocks.useQuery.mockReset();
    store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-1' as WorkspaceId);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it('skips workspace queries as soon as the current workspace is cleared', async () => {
    await act(async () => {
      root?.render(
        <TestCloudPlatformProvider>
          <Provider store={store}>
            <SettingsDataCacheProvider>
              <div />
            </SettingsDataCacheProvider>
          </Provider>
        </TestCloudPlatformProvider>
      );
    });

    expect(mocks.useQuery.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(mocks.useQuery.mock.calls.every(([, args]) => args !== 'skip')).toBe(true);

    mocks.useQuery.mockClear();
    await act(async () => {
      store.set(currentWorkspaceIdAtom, null);
    });

    expect(mocks.useQuery.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(mocks.useQuery.mock.calls.every(([, args]) => args === 'skip')).toBe(true);
  });
});
