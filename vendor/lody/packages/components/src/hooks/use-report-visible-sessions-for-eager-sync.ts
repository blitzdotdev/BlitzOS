import { useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionId, SessionMeta } from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';

type VisibleSessionInput = Pick<SessionMeta, 'id'>;

export function useReportVisibleSessionsForEagerSync(
  sourceId: string,
  primarySessions: readonly VisibleSessionInput[],
  extraSessions: readonly VisibleSessionInput[] = []
): void {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const visibleSessionIds = useMemo(() => {
    const ids = new Set<SessionId>();
    for (const session of primarySessions) {
      ids.add(session.id);
    }
    for (const session of extraSessions) {
      ids.add(session.id);
    }
    return Array.from(ids);
  }, [extraSessions, primarySessions]);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    runtime.setEagerSyncVisibleSessionIds(sourceId, visibleSessionIds);
  }, [runtime, sourceId, visibleSessionIds]);

  useEffect(() => {
    if (!runtime) {
      return undefined;
    }
    return () => {
      runtime.setEagerSyncVisibleSessionIds(sourceId, null);
    };
  }, [runtime, sourceId]);
}
