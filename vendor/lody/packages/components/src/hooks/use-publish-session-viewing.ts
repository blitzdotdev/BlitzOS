import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionId } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { userAtom } from '@/atoms';

/**
 * Publishes the ephemeral `session-viewing` presence entry while this session
 * view is mounted and the page is visible. Actively cleared on session switch,
 * page hide, and unmount — the presence TTL is only the crash fallback. The
 * owning machine's PR poller uses this signal for activity-aware scheduling.
 *
 * Reads `activeWorkspaceRuntimeAtom` (not the raw `runtimeAtom`): during a
 * workspace route switch the raw atom intentionally retains the stale runtime,
 * which would briefly publish the new session id into the old workspace's
 * presence room. The active atom is null until the route's runtime is ready.
 */
export function usePublishSessionViewing(sessionId: SessionId): void {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const currentUser = useAtomValue(userAtom);
  const userId = currentUser?.id ?? null;

  useEffect(() => {
    if (!runtime || !userId) return undefined;
    const publish = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        runtime.publishSessionViewing(null);
        return;
      }
      runtime.publishSessionViewing({ sessionId, userId });
    };
    publish();
    document.addEventListener('visibilitychange', publish);
    return () => {
      document.removeEventListener('visibilitychange', publish);
      runtime.publishSessionViewing(null);
    };
  }, [runtime, sessionId, userId]);
}
