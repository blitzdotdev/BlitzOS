// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const membershipSyncMocks = vi.hoisted(() => ({
  fingerprint: undefined as string | null | undefined,
  updateSession: vi.fn<() => Promise<void>>(),
  useQuery: vi.fn(),
  isAuthenticated: true,
}));

vi.mock('../src/hooks/use-recoverable-convex-query', () => ({
  usePublicConvexQuery: () => undefined,
  useRecoverableConvexQuery: (...args: unknown[]) => {
    membershipSyncMocks.useQuery(...args);
    return args[1] === 'skip' || !membershipSyncMocks.isAuthenticated
      ? undefined
      : membershipSyncMocks.fingerprint;
  },
}));

vi.mock('../src/hooks/use-authenticated-convex', () => ({
  useAuthenticatedConvex: () => ({ isAuthenticated: membershipSyncMocks.isAuthenticated }),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useAuthClient: () => ({
    updateSession: membershipSyncMocks.updateSession,
  }),
}));

const { useDesktopWorkspaceMembershipSync } =
  await import('../src/hooks/use-desktop-workspace-membership-sync');
const { TestCloudPlatformProvider } = await import('./test-platform');

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function MembershipSyncProbe({ userId }: { userId: string | null }) {
  useDesktopWorkspaceMembershipSync(userId);
  return null;
}

describe('useDesktopWorkspaceMembershipSync', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    membershipSyncMocks.fingerprint = undefined;
    membershipSyncMocks.isAuthenticated = true;
    membershipSyncMocks.updateSession.mockReset();
    membershipSyncMocks.updateSession.mockResolvedValue();
    membershipSyncMocks.useQuery.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render(userId: string | null) {
    await act(async () => {
      root.render(
        createElement(
          TestCloudPlatformProvider,
          null,
          createElement(MembershipSyncProbe, { userId })
        )
      );
    });
  }

  it('uses the first fingerprint as a baseline and refreshes on change', async () => {
    membershipSyncMocks.fingerprint = null;
    await render('user-1');
    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();

    membershipSyncMocks.fingerprint = 'workspace-1';
    await render('user-1');
    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();

    membershipSyncMocks.fingerprint = 'workspace-1\nworkspace-2';
    await render('user-1');
    expect(membershipSyncMocks.updateSession).toHaveBeenCalledTimes(1);

    await render('user-1');
    expect(membershipSyncMocks.updateSession).toHaveBeenCalledTimes(1);
  });

  it('resets the baseline when the authenticated user changes', async () => {
    membershipSyncMocks.fingerprint = 'workspace-1';
    await render('user-1');

    membershipSyncMocks.fingerprint = undefined;
    await render(null);
    membershipSyncMocks.fingerprint = 'workspace-2';
    await render('user-2');

    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();
    expect(membershipSyncMocks.useQuery).toHaveBeenLastCalledWith(expect.anything(), {});
  });

  it('delegates auth recovery pauses to the recoverable query layer', async () => {
    membershipSyncMocks.fingerprint = 'workspace-1';
    membershipSyncMocks.isAuthenticated = false;

    await render('user-1');

    expect(membershipSyncMocks.useQuery).toHaveBeenLastCalledWith(expect.anything(), {});
    expect(membershipSyncMocks.updateSession).not.toHaveBeenCalled();
  });
});
