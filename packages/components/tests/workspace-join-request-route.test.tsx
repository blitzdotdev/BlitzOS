// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  query: vi.fn(),
  submit: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useParams: () => ({ token: 'open-token' }),
  }),
  useNavigate: () => mocks.navigate,
}));

vi.mock('@lody/platform/react', () => ({
  useCloudMutation: () => mocks.submit,
  useCloudQuery: (...args: unknown[]) => mocks.query(...args),
  usePlatformCapability: () => true,
}));

vi.mock('../src/hooks/useStableSession', () => ({
  useStableSession: () => ({ data: null, isPending: false }),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useAuthSignOut: () => mocks.signOut,
}));

import { WorkspaceJoinRequestRoute } from '../src/routes/join/$token';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('WorkspaceJoinRequestRoute', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the public preview before authentication and preserves the join URL on sign-in', async () => {
    await initI18n('en');
    mocks.query.mockReturnValue({
      status: 'available',
      workspaceName: 'PKU Research Lab',
      workspaceSlug: 'pku',
      expiresAt: 9_000_000_000_000_000,
      viewer: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<WorkspaceJoinRequestRoute />);
    });
    expect(mocks.query).toHaveBeenCalledOnce();

    const continueButton = container.querySelector('button');
    expect(continueButton).not.toBeNull();
    await act(async () => continueButton?.click());
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/login',
      search: { redirect: '/join/open-token', view: 'email' },
    });

    await act(async () => root.unmount());
    container.remove();
  });
});
