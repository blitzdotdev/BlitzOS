import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  getActiveTaskLinks,
  getActiveTaskPrLinks,
  getActiveTaskSessionLinks,
  TASK_ORDER_MIN_KEY,
  type TaskDocState,
  type TaskId,
  type TaskLink,
  type TaskTimelineEntry,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom, type TaskDocStore } from '@/atoms/runtime';
import type { RoomSyncState } from '@/lib/room-sync-state';

const emptyTaskDoc = (taskId: TaskId): TaskDocState =>
  ({
    meta: {
      taskId,
      title: '',
      status: 'backlog',
      ownerId: '',
      order: TASK_ORDER_MIN_KEY,
      createdAt: 0,
      updatedAt: 0,
    },
    body: '',
    links: [],
    timeline: [],
  }) as unknown as TaskDocState;

export type UseTaskDocResult = {
  state: TaskDocState;
  ready: boolean;
  syncState: RoomSyncState;
  links: TaskLink[];
  sessionLinks: TaskLink[];
  prLinks: TaskLink[];
  timeline: TaskTimelineEntry[];
  withStore: <T>(fn: (store: TaskDocStore) => Promise<T> | T) => Promise<T>;
};

/**
 * Subscribes to one task document. The store is ref-counted by the runtime, so
 * every access goes through `withStore`: in-flight callbacks can outlive unmount,
 * at which point a locally cached store may already be disposed.
 */
export function useTaskDoc(taskId: TaskId | null, enabled = true): UseTaskDocResult {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const fallback = useMemo(() => emptyTaskDoc((taskId ?? '') as TaskId), [taskId]);
  const [state, setState] = useState<TaskDocState>(fallback);
  const [ready, setReady] = useState(false);
  const [syncState, setSyncState] = useState<RoomSyncState>('idle');

  useEffect(() => {
    let cancelled = false;
    let acquired = false;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeSyncState: (() => void) | null = null;
    setReady(false);
    setSyncState('idle');
    setState(fallback);

    if (!runtime || !enabled || !taskId) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      try {
        const store = await runtime.acquireTaskStore(taskId);
        acquired = true;
        if (cancelled) {
          runtime.releaseTaskStoreRef(taskId);
          return;
        }
        setState(store.getState());
        setSyncState(store.getSyncState());
        setReady(true);
        unsubscribeSyncState = store.subscribeSyncState((next) => {
          if (!cancelled) {
            setSyncState(next);
          }
        });
        unsubscribe = store.subscribe((next) => {
          if (!cancelled) {
            setState(next);
          }
        });
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load task doc', { taskId, error });
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeSyncState?.();
      if (acquired && taskId) {
        runtime?.releaseTaskStoreRef(taskId);
      }
    };
  }, [enabled, fallback, runtime, taskId]);

  const withStore = useCallback(
    async <T,>(fn: (store: TaskDocStore) => Promise<T> | T): Promise<T> => {
      if (!runtime) {
        throw new Error('Runtime not ready');
      }
      if (!taskId) {
        throw new Error('No task selected');
      }
      return runtime.withTaskStore(taskId, fn);
    },
    [runtime, taskId]
  );

  const links = useMemo(() => (state.links ?? []) as unknown as TaskLink[], [state.links]);
  const timeline = useMemo(
    () => (state.timeline ?? []) as unknown as TaskTimelineEntry[],
    [state.timeline]
  );

  return {
    state,
    ready,
    syncState,
    links: useMemo(() => getActiveTaskLinks(links), [links]),
    sessionLinks: useMemo(() => getActiveTaskSessionLinks(links), [links]),
    prLinks: useMemo(() => getActiveTaskPrLinks(links), [links]),
    timeline,
    withStore,
  };
}
