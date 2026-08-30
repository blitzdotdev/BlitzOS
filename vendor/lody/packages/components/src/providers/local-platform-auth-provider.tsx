import { useMemo, type ReactNode } from 'react';
import type { LodyAuthClient } from '../lib/auth';
import { LocalPlatformConvexProvider } from './convex-provider';
import { StableSessionContext, type StableSessionValue } from '../hooks/useStableSession';
import {
  AuthenticatedConvexContext,
  type AuthenticatedConvexContextValue,
} from '@/hooks/use-authenticated-convex';
import { usePlatformSession } from '@lody/platform/react';

/**
 * Local-platform (open-source build) replacement for the cloud auth stack
 * (`ConvexProvider` → `StableSessionProvider` → `AuthenticatedConvexProvider`).
 * It mounts the same contexts the inner app shell consumes, but with static
 * values: the session resolves from the CLI-owned local platform snapshot, no
 * Better Auth request ever fires, and Convex stays unauthenticated so every
 * auth-gated Convex query skips. Zero cloud I/O by construction.
 */

/**
 * The synthetic email exists only to satisfy `normalizeCurrentUserFromSessionUser`
 * (zod `email()`), which populates `userAtom` in the root shell. The domain must
 * not be the missing-email domain, or the root shell would bounce to
 * /complete-email.
 */
const LOCAL_AUTHENTICATED_CONVEX_VALUE: AuthenticatedConvexContextValue = {
  authSessionId: null,
  isAuthenticated: false,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: false,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

export function LocalPlatformAuthProvider({
  authClient,
  children,
}: {
  authClient: LodyAuthClient;
  children: ReactNode;
}) {
  const platformSession = usePlatformSession();
  const sessionValue = useMemo<StableSessionValue>(() => {
    const user =
      platformSession.status === 'authenticated'
        ? {
            id: platformSession.user.id,
            name: platformSession.user.name ?? 'Local',
            email: 'local@lody.local',
            image: platformSession.user.image ?? null,
          }
        : null;
    const data = (user ? { user } : null) as StableSessionValue['data'];
    return {
      data,
      rawData: data,
      bootstrapSnapshot: null,
      hasLocalToken: false,
      hasRawUser: user !== null,
      isOptimistic: false,
      isPending: platformSession.status === 'loading',
      isRetrying: false,
      error: null,
      confirmedUnauthenticated: false,
      refetch: (() => Promise.resolve()) as unknown as StableSessionValue['refetch'],
    };
  }, [platformSession]);

  return (
    <LocalPlatformConvexProvider authClient={authClient}>
      <StableSessionContext.Provider value={sessionValue}>
        <AuthenticatedConvexContext.Provider value={LOCAL_AUTHENTICATED_CONVEX_VALUE}>
          {children}
        </AuthenticatedConvexContext.Provider>
      </StableSessionContext.Provider>
    </LocalPlatformConvexProvider>
  );
}
