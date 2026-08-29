/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  convexAuth: { isAuthenticated: false, isLoading: false },
  refetch: vi.fn(),
  restartConvexAuth: vi.fn(),
  session: {
    hasLocalToken: true,
    hasRawUser: true,
    isPending: false,
    isRetrying: false,
    confirmedUnauthenticated: false,
    rawData: { session: { id: 'session-1' } },
  },
}));

vi.mock('convex/react', () => ({
  useConvexAuth: () => mocks.convexAuth,
}));

vi.mock('../src/hooks/useStableSession', () => ({
  useStableSession: () => ({ ...mocks.session, refetch: mocks.refetch }),
}));

vi.mock('../src/providers/convex-provider', () => ({
  useRestartConvexAuth: () => mocks.restartConvexAuth,
}));

import {
  useAuthenticatedConvex,
  type AuthenticatedConvexContextValue,
} from '../src/hooks/use-authenticated-convex';
import { AuthenticatedConvexProvider } from '../src/providers/authenticated-convex-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('AuthenticatedConvexProvider', () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: AuthenticatedConvexContextValue | null;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.convexAuth.isAuthenticated = false;
    mocks.convexAuth.isLoading = false;
    mocks.session.hasRawUser = true;
    mocks.session.confirmedUnauthenticated = false;
    mocks.session.rawData = { session: { id: 'session-1' } };
    mocks.refetch.mockReset();
    mocks.restartConvexAuth.mockReset();
    current = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function Consumer() {
    current = useAuthenticatedConvex();
    return <div>{current.isLoading ? 'recovering' : 'ready'}</div>;
  }

  it('coalesces recovery while the Better Auth and Convex states disagree', async () => {
    let resolveRefetch!: () => void;
    const pendingRefetch = new Promise<void>((resolve) => {
      resolveRefetch = resolve;
    });
    mocks.refetch.mockReturnValue(pendingRefetch);

    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(container.textContent).toBe('recovering');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      current!.requestAuthRecovery();
      current!.requestAuthRecovery();
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    resolveRefetch();
    await act(async () => {
      await pendingRefetch;
    });
    expect(mocks.restartConvexAuth).toHaveBeenCalledTimes(1);
    await act(async () => {
      current!.requestAuthRecovery();
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(1);

    mocks.convexAuth.isLoading = true;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    mocks.convexAuth.isAuthenticated = true;
    mocks.convexAuth.isLoading = false;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    expect(container.textContent).toBe('ready');
    expect(current?.isAuthenticated).toBe(true);
    expect(current?.isRecovering).toBe(false);
  });

  it('deduplicates automatic commands for one Better Auth session', async () => {
    mocks.convexAuth.isAuthenticated = true;

    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(current!.claimAutomaticCommand('github-profile-refresh:workspace-1')).toBe(true);
    expect(current!.claimAutomaticCommand('github-profile-refresh:workspace-1')).toBe(false);

    mocks.session.rawData = { session: { id: 'session-2' } };
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(current!.claimAutomaticCommand('github-profile-refresh:workspace-1')).toBe(true);
  });

  it('keeps retrying a reported auth failure after Convex rejects refreshed auth', async () => {
    mocks.convexAuth.isAuthenticated = true;
    mocks.refetch.mockResolvedValue(undefined);

    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });

    expect(container.textContent).toBe('ready');
    await act(async () => {
      current!.requestAuthRecovery();
    });
    expect(container.textContent).toBe('recovering');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mocks.restartConvexAuth).toHaveBeenCalledTimes(1);

    mocks.convexAuth.isLoading = true;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    mocks.convexAuth.isAuthenticated = false;
    mocks.convexAuth.isLoading = false;
    await act(async () => {
      root.render(
        <AuthenticatedConvexProvider>
          <Consumer />
        </AuthenticatedConvexProvider>
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.refetch).toHaveBeenCalledTimes(2);
    expect(mocks.restartConvexAuth).toHaveBeenCalledTimes(2);
  });
});
