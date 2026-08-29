// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: navigateMock }),
}));

import { currentWorkspaceSlugAtom } from '../src/atoms';
import { developerModeEnabledAtom, tasksBetaEnabledAtom } from '../src/atoms/settings';
import { TasksBetaRouteGuard } from '../src/components/tasks/tasks-beta-route-guard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderGuard(store: ReturnType<typeof createStore>): void {
  act(() => {
    root.render(
      <Provider store={store}>
        <TasksBetaRouteGuard>
          <p>task page</p>
        </TasksBetaRouteGuard>
      </Provider>
    );
  });
}

function storeWith({ gateOn, slug }: { gateOn: boolean; slug: string | null }) {
  // localStorage-backed atoms rehydrate across stores, so the gate is set
  // explicitly rather than relying on a fresh store being a fresh gate.
  const store = createStore();
  store.set(developerModeEnabledAtom, gateOn);
  store.set(tasksBetaEnabledAtom, gateOn);
  store.set(currentWorkspaceSlugAtom, slug);
  return store;
}

beforeEach(() => {
  localStorage.clear();
  navigateMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TasksBetaRouteGuard', () => {
  it('renders the page when the Tasks beta is on, and does not redirect', () => {
    renderGuard(storeWith({ gateOn: true, slug: 'acme' }));

    expect(container.textContent).toContain('task page');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('honours a persisted gate on the first paint so deep links are not bounced to chat', () => {
    // Simulates a fresh tab opening /{ws}/tasks/{id}: the gate lives only in
    // localStorage, and nothing store.set()s it before the first render. The
    // atom may still report false until onMount; the guard must not redirect.
    localStorage.setItem('lody-developer-mode-enabled', JSON.stringify(true));
    localStorage.setItem('lody-tasks-beta-enabled', JSON.stringify(true));
    const store = createStore();
    store.set(currentWorkspaceSlugAtom, 'acme');

    renderGuard(store);

    expect(container.textContent).toContain('task page');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('does not bounce a storage-enabled deep link after the settle pass either', () => {
    localStorage.setItem('lody-developer-mode-enabled', JSON.stringify(true));
    localStorage.setItem('lody-tasks-beta-enabled', JSON.stringify(true));
    const store = createStore();
    store.set(currentWorkspaceSlugAtom, 'acme');

    renderGuard(store);
    // Flush the settle effect + any atomWithStorage onMount rehydrate.
    act(() => {
      /* settle */
    });

    expect(container.textContent).toContain('task page');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('renders nothing and returns to chat when the beta is off', () => {
    renderGuard(storeWith({ gateOn: false, slug: 'acme' }));

    expect(container.textContent).toBe('');
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$workspaceName/chat',
      params: { workspaceName: 'acme' },
      replace: true,
    });
  });

  it('does not navigate before the workspace slug resolves', () => {
    // A redirect with no slug would be a router error; rendering nothing for
    // that first tick is correct, but it must not become a permanent blank
    // page — the next test covers the recovery.
    renderGuard(storeWith({ gateOn: false, slug: null }));

    expect(container.textContent).toBe('');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('redirects once the slug arrives, so a null slug is not a dead end', () => {
    const store = storeWith({ gateOn: false, slug: null });
    renderGuard(store);
    expect(navigateMock).not.toHaveBeenCalled();

    act(() => store.set(currentWorkspaceSlugAtom, 'acme'));

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/$workspaceName/chat',
      params: { workspaceName: 'acme' },
      replace: true,
    });
  });

  it('hides the page immediately when the gate is turned off while it is open', () => {
    const store = storeWith({ gateOn: true, slug: 'acme' });
    renderGuard(store);
    expect(container.textContent).toContain('task page');

    // Turning Developer mode off must take the open page away, not leave it
    // rendered until the next navigation.
    act(() => store.set(developerModeEnabledAtom, false));

    expect(container.textContent).toBe('');
    expect(navigateMock).toHaveBeenCalledTimes(1);
  });
});
