import { useCallback, useRef, useState } from 'react';
import type { SessionId } from '@lody/shared';

function createDraftSessionId(): SessionId {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID() as SessionId;
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}` as SessionId;
}

export function useChatLandingDraftSession() {
  const [sessionId, setSessionId] = useState<SessionId | null>(null);
  const sessionIdRef = useRef<SessionId | null>(null);

  const ensureSessionId = useCallback((): SessionId => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const next = createDraftSessionId();
    sessionIdRef.current = next;
    setSessionId(next);
    return next;
  }, []);

  const resetSessionId = useCallback(() => {
    sessionIdRef.current = null;
    setSessionId(null);
  }, []);

  return { sessionId, ensureSessionId, resetSessionId };
}
