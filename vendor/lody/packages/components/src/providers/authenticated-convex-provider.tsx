import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConvexAuth } from 'convex/react';
import {
  getConvexAuthRecoveryDelayMs,
  resolveAuthenticatedConvexState,
  shouldRecoverConvexAuthMismatch,
} from '@/lib/authed-convex-query';
import {
  AuthenticatedConvexContext,
  type AuthenticatedConvexContextValue,
} from '@/hooks/use-authenticated-convex';
import { useStableSession } from '@/hooks/useStableSession';
import { useRestartConvexAuth } from './convex-provider';

type PendingRecovery = {
  promise: Promise<void>;
  resolve: () => void;
  restartRequested: boolean;
  sawConvexReset: boolean;
};

function canRecoverAuthNow(): boolean {
  const online = typeof navigator === 'undefined' || navigator.onLine;
  const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return online && visible;
}

export function AuthenticatedConvexProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated: isConvexAuthenticated, isLoading: isConvexAuthLoading } =
    useConvexAuth();
  const {
    hasLocalToken,
    hasRawUser,
    isPending: isSessionPending,
    isRetrying: isSessionRetrying,
    confirmedUnauthenticated,
    rawData,
    refetch,
  } = useStableSession();
  const restartConvexAuth = useRestartConvexAuth();
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveryAllowed, setRecoveryAllowed] = useState(canRecoverAuthNow);
  const [recoveryRequested, setRecoveryRequested] = useState(false);
  const pendingRecoveryRef = useRef<PendingRecovery | null>(null);
  const authSessionId = rawData?.session?.id ?? null;
  const authSessionIdRef = useRef<string | null>(authSessionId);
  const automaticCommandRegistryRef = useRef({
    sessionId: authSessionIdRef.current,
    keys: new Set<string>(),
  });
  authSessionIdRef.current = authSessionId;

  const claimAutomaticCommand = useCallback((key: string): boolean => {
    const sessionId = authSessionIdRef.current;
    if (!sessionId) return false;

    const registry = automaticCommandRegistryRef.current;
    if (registry.sessionId !== sessionId) {
      registry.sessionId = sessionId;
      registry.keys.clear();
    }
    if (registry.keys.has(key)) return false;
    registry.keys.add(key);
    return true;
  }, []);

  const requestAuthRecovery = useCallback(() => {
    if (!confirmedUnauthenticated) {
      setRecoveryRequested(true);
    }
  }, [confirmedUnauthenticated]);

  const runRecovery = useCallback((): Promise<void> => {
    if (confirmedUnauthenticated) {
      return Promise.resolve();
    }
    if (pendingRecoveryRef.current) {
      return pendingRecoveryRef.current.promise;
    }

    let resolveRequest!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const pending: PendingRecovery = {
      promise,
      resolve: resolveRequest,
      restartRequested: false,
      sawConvexReset: false,
    };
    pendingRecoveryRef.current = pending;

    void Promise.resolve()
      .then(() => refetch())
      .catch(() => undefined)
      .then(() => {
        if (pendingRecoveryRef.current !== pending) return;
        pending.restartRequested = true;
        restartConvexAuth();
      });
    return promise;
  }, [confirmedUnauthenticated, refetch, restartConvexAuth]);

  useEffect(() => {
    const updateRecoveryAllowed = () => setRecoveryAllowed(canRecoverAuthNow());
    window.addEventListener('online', updateRecoveryAllowed);
    window.addEventListener('offline', updateRecoveryAllowed);
    document.addEventListener('visibilitychange', updateRecoveryAllowed);
    return () => {
      window.removeEventListener('online', updateRecoveryAllowed);
      window.removeEventListener('offline', updateRecoveryAllowed);
      document.removeEventListener('visibilitychange', updateRecoveryAllowed);
    };
  }, []);

  useEffect(() => {
    const pending = pendingRecoveryRef.current;
    if (!pending?.restartRequested) return;

    if (isConvexAuthLoading) {
      pending.sawConvexReset = true;
      return;
    }
    if (!pending.sawConvexReset) return;

    pendingRecoveryRef.current = null;
    if (isConvexAuthenticated) {
      setRecoveryRequested(false);
    }
    pending.resolve();
  }, [isConvexAuthLoading, isConvexAuthenticated]);

  useEffect(() => {
    if (!confirmedUnauthenticated) return;
    setRecoveryRequested(false);
    const pending = pendingRecoveryRef.current;
    if (!pending) return;
    pendingRecoveryRef.current = null;
    pending.resolve();
  }, [confirmedUnauthenticated]);

  useEffect(
    () => () => {
      pendingRecoveryRef.current?.resolve();
      pendingRecoveryRef.current = null;
    },
    []
  );

  const shouldRecoverMismatch = shouldRecoverConvexAuthMismatch({
    isConvexAuthenticated,
    isConvexAuthLoading,
    hasRawSessionUser: hasRawUser,
    confirmedUnauthenticated,
  });
  const isRecovering = recoveryRequested || shouldRecoverMismatch;

  useEffect(() => {
    if (!isRecovering) {
      setRecoveryAttempt(0);
      return undefined;
    }
    if (!recoveryAllowed) return undefined;

    let cancelled = false;
    const timeoutId = setTimeout(() => {
      void runRecovery().finally(() => {
        if (!cancelled) {
          setRecoveryAttempt((attempt) => attempt + 1);
        }
      });
    }, getConvexAuthRecoveryDelayMs(recoveryAttempt));

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [isRecovering, recoveryAllowed, recoveryAttempt, runRecovery]);

  const resolvedState = resolveAuthenticatedConvexState({
    isConvexAuthenticated,
    isConvexAuthLoading,
    hasRawSessionUser: hasRawUser,
    hasLocalToken,
    isSessionPending,
    isSessionRetrying,
    confirmedUnauthenticated,
  });
  const isAuthenticated = resolvedState.isAuthenticated && !isRecovering;
  const isLoading = resolvedState.isLoading || isRecovering;
  const value = useMemo<AuthenticatedConvexContextValue>(
    () => ({
      authSessionId,
      isAuthenticated,
      isLoading,
      isRecovering,
      confirmedUnauthenticated,
      claimAutomaticCommand,
      requestAuthRecovery,
    }),
    [
      authSessionId,
      claimAutomaticCommand,
      confirmedUnauthenticated,
      isAuthenticated,
      isLoading,
      isRecovering,
      requestAuthRecovery,
    ]
  );

  return (
    <AuthenticatedConvexContext.Provider value={value}>
      {children}
    </AuthenticatedConvexContext.Provider>
  );
}
