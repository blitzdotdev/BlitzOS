import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import type { SessionMeta, TaskId } from '@lody/shared';
import { allActiveSessionsAtom } from '@/atoms/doc-meta';

export type TaskSessionRollup = {
  sessions: SessionMeta[];
  /** A linked session is blocked on a human answer. */
  needsYou: boolean;
  /** A linked session is executing right now. */
  running: boolean;
  openPrCount: number;
};

const emptyRollup: TaskSessionRollup = {
  sessions: [],
  needsYou: false,
  running: false,
  openPrCount: 0,
};

/**
 * Rolls linked-session state up per task.
 *
 * needs-you comes from `awaitingUserSince`, a durable marker the CLI writes when
 * it persists a permission request and clears on every resolution path. That
 * matters because the heartbeat TTL repairs a stale active status back to idle:
 * keying off `status` alone would make the signal vanish precisely when a machine
 * went offline mid-question. Live status is only an accelerator.
 */
export const buildTaskSessionRollups = (
  sessions: readonly SessionMeta[]
): Map<TaskId, TaskSessionRollup> => {
  const rollups = new Map<TaskId, TaskSessionRollup>();
  for (const session of sessions) {
    const taskId = session.taskId;
    if (!taskId) {
      continue;
    }
    const current = rollups.get(taskId) ?? {
      sessions: [],
      needsYou: false,
      running: false,
      openPrCount: 0,
    };
    current.sessions.push(session);
    const statusType = session.status?.type;
    if (session.awaitingUserSince !== undefined || statusType === 'requestPermission') {
      current.needsYou = true;
    }
    if (statusType === 'running' || statusType === 'initializing') {
      current.running = true;
    }
    for (const pr of session.pullRequests ?? []) {
      if (pr.status === 'open' || pr.status === 'draft') {
        current.openPrCount += 1;
      }
    }
    rollups.set(taskId, current);
  }
  return rollups;
};

export function useTaskSessionRollups(): Map<TaskId, TaskSessionRollup> {
  const sessions = useAtomValue(allActiveSessionsAtom);
  return useMemo(() => buildTaskSessionRollups(sessions), [sessions]);
}

export function useTaskSessionRollup(taskId: TaskId | null): TaskSessionRollup {
  const rollups = useTaskSessionRollups();
  return (taskId ? rollups.get(taskId) : undefined) ?? emptyRollup;
}
