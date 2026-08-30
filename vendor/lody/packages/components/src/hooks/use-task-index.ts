import { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  applyTaskIndexRowEvents,
  getTaskIndexFlockDocId,
  readTaskIndexRows,
  getTaskIndexScanPrefix,
  type TaskIndexFlockEvent,
} from '@lody/shared';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import {
  clearOpenTaskTabsAtom,
  clearTaskIndexAtom,
  taskIndexReadyAtom,
  taskIndexRowsAtom,
} from '@/atoms/tasks';

/**
 * Keeps the task index rows in sync with the workspace task index Flock
 * document.
 *
 * Local rows are published before the room join so the Tasks page paints from
 * local state and never shows a spinner while the network settles; the remote
 * join then merges whatever this device has not seen yet.
 *
 * Mount this once per workspace (the app layout does), not per view.
 */
export function useTaskIndexSync(): void {
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const setRows = useSetAtom(taskIndexRowsAtom);
  const setReady = useSetAtom(taskIndexReadyAtom);
  const clearIndex = useSetAtom(clearTaskIndexAtom);
  const clearOpenTabs = useSetAtom(clearOpenTaskTabsAtom);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeFlock: (() => void) | null = null;
    let unsubscribeRoom: (() => void) | null = null;

    void (async () => {
      if (!runtime) {
        return;
      }
      try {
        const handle = await runtime.repo.openFlockDoc(
          getTaskIndexFlockDocId(runtime.workspaceId)
        );
        if (cancelled) {
          return;
        }

        setRows(readTaskIndexRows(handle.flock.scan({ prefix: getTaskIndexScanPrefix() })));
        setReady(true);

        unsubscribeFlock = handle.flock.subscribe((batch) => {
          if (cancelled) {
            return;
          }
          const events = (batch as { events?: TaskIndexFlockEvent[] }).events ?? [];
          if (events.length === 0) {
            return;
          }
          setRows((previous) => applyTaskIndexRowEvents(previous, events));
        });

        const subscription = await handle.joinRoom();
        if (cancelled) {
          subscription.unsubscribe();
          return;
        }
        unsubscribeRoom = () => subscription.unsubscribe();
        await subscription.firstSyncedWithRemote;
        if (cancelled) {
          return;
        }
        // Re-read rather than trusting the event stream alone: the first remote
        // sync can land as a snapshot rather than per-row events.
        setRows(readTaskIndexRows(handle.flock.scan({ prefix: getTaskIndexScanPrefix() })));
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to sync task index', error);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeFlock?.();
      unsubscribeRoom?.();
      // These rows describe the workspace we are leaving. Keeping them would let
      // the Tasks page render another workspace's tasks — with `ready` still true,
      // so it looks authoritative — for as long as opening the new index takes.
      clearIndex();
      // Open detail tabs are workspace-scoped too: a tab id from workspace A
      // must not stay selected after the user lands in workspace B.
      clearOpenTabs();
    };
  }, [clearIndex, clearOpenTabs, runtime, setReady, setRows]);
}
