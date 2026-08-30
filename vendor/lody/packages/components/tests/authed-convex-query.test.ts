import { describe, expect, it } from 'vitest';
import {
  canRunAuthedWorkspaceQuery,
  CONVEX_AUTH_RECOVERY_DELAYS_MS,
  getConvexAuthRecoveryDelayMs,
  isAuthedWorkspaceQueryLoading,
  resolveAuthenticatedConvexState,
  shouldRecoverConvexAuthMismatch,
} from '../src/lib/authed-convex-query';

describe('resolveAuthenticatedConvexState', () => {
  const authenticated = {
    isConvexAuthenticated: true,
    isConvexAuthLoading: false,
    hasRawSessionUser: true,
    hasLocalToken: true,
    isSessionPending: false,
    isSessionRetrying: false,
    confirmedUnauthenticated: false,
  };

  it('requires both the Better Auth session and Convex server confirmation', () => {
    expect(resolveAuthenticatedConvexState(authenticated)).toEqual({
      isAuthenticated: true,
      isLoading: false,
    });
    expect(resolveAuthenticatedConvexState({ ...authenticated, hasRawSessionUser: false })).toEqual(
      { isAuthenticated: false, isLoading: true }
    );
    expect(
      resolveAuthenticatedConvexState({ ...authenticated, isConvexAuthenticated: false })
    ).toEqual({ isAuthenticated: false, isLoading: true });
    expect(
      shouldRecoverConvexAuthMismatch({
        ...authenticated,
        hasRawSessionUser: true,
        isConvexAuthenticated: false,
      })
    ).toBe(true);
  });

  it('waits through session recovery but settles after confirmed expiry', () => {
    expect(
      resolveAuthenticatedConvexState({
        ...authenticated,
        hasRawSessionUser: false,
        isSessionRetrying: true,
      })
    ).toEqual({ isAuthenticated: false, isLoading: true });
    expect(
      resolveAuthenticatedConvexState({
        ...authenticated,
        hasRawSessionUser: false,
        confirmedUnauthenticated: true,
      })
    ).toEqual({ isAuthenticated: false, isLoading: false });
  });

  it('keeps an established raw session usable during background refetch', () => {
    expect(resolveAuthenticatedConvexState({ ...authenticated, isSessionPending: true })).toEqual({
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('caps recovery backoff without declaring a refreshable session terminal', () => {
    expect(getConvexAuthRecoveryDelayMs(0)).toBe(CONVEX_AUTH_RECOVERY_DELAYS_MS[0]);
    expect(getConvexAuthRecoveryDelayMs(100)).toBe(
      CONVEX_AUTH_RECOVERY_DELAYS_MS[CONVEX_AUTH_RECOVERY_DELAYS_MS.length - 1]
    );
  });
});

describe('canRunAuthedWorkspaceQuery', () => {
  it('returns true only when a workspace id exists and Convex auth is ready', () => {
    expect(canRunAuthedWorkspaceQuery('workspace-1', true)).toBe(true);
    expect(canRunAuthedWorkspaceQuery('workspace-1', false)).toBe(false);
    expect(canRunAuthedWorkspaceQuery('', true)).toBe(false);
    expect(canRunAuthedWorkspaceQuery(null, true)).toBe(false);
    expect(canRunAuthedWorkspaceQuery(undefined, true)).toBe(false);
  });
});

describe('isAuthedWorkspaceQueryLoading', () => {
  it('waits while Convex auth is still loading for a workspace', () => {
    expect(
      isAuthedWorkspaceQueryLoading({
        workspaceId: 'workspace-1',
        isConvexAuthLoading: true,
        canQuery: false,
        queryResult: undefined,
      })
    ).toBe(true);
  });

  it('waits when an authed query has been issued but has not returned', () => {
    expect(
      isAuthedWorkspaceQueryLoading({
        workspaceId: 'workspace-1',
        isConvexAuthLoading: false,
        canQuery: true,
        queryResult: undefined,
      })
    ).toBe(true);
  });

  it('does not treat a skipped query as loading after auth has settled', () => {
    expect(
      isAuthedWorkspaceQueryLoading({
        workspaceId: 'workspace-1',
        isConvexAuthLoading: false,
        canQuery: false,
        queryResult: undefined,
      })
    ).toBe(false);
  });

  it('does not treat an empty result as loading', () => {
    expect(
      isAuthedWorkspaceQueryLoading({
        workspaceId: 'workspace-1',
        isConvexAuthLoading: false,
        canQuery: true,
        queryResult: [],
      })
    ).toBe(false);
  });
});
