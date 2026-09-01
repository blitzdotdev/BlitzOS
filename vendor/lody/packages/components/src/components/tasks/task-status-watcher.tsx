import { useEffect, useRef } from 'react';
import { useAtomValue } from 'jotai';
import {
  resolveTaskPrFollowStatus,
  shouldEnterTaskNeedsReview,
  type SessionMeta,
  type TaskId,
  type TaskPrState,
} from '@lody/shared';
import { allActiveSessionsAtom, archivedSessionListAtom } from '@/atoms/doc-meta';
import { taskListAtom } from '@/atoms/tasks';
import { useTaskActions } from '@/hooks/use-task-actions';

type TaskExecutionSnapshot = {
  /** Every linked session has finished. */
  allSessionsTerminal: boolean;
  sessionCount: number;
  prStates: TaskPrState[];
};

const isSessionTerminal = (session: SessionMeta, archivedIds: ReadonlySet<string>): boolean => {
  if (archivedIds.has(session.id)) {
    return true;
  }
  const prs = session.pullRequests ?? [];
  if (prs.length === 0) {
    return false;
  }
  return prs.every((pr) => pr.status === 'merged' || pr.status === 'closed');
};

const toPrState = (status: string | undefined): TaskPrState => {
  if (status === 'merged' || status === 'closed' || status === 'open' || status === 'draft') {
    return status;
  }
  return 'unknown';
};

const buildSnapshots = (
  sessions: readonly SessionMeta[],
  archivedIds: ReadonlySet<string>
): Map<TaskId, TaskExecutionSnapshot> => {
  const snapshots = new Map<TaskId, TaskExecutionSnapshot>();
  for (const session of sessions) {
    const taskId = session.taskId;
    if (!taskId) {
      continue;
    }
    const current =
      snapshots.get(taskId) ??
      ({ allSessionsTerminal: true, sessionCount: 0, prStates: [] } satisfies TaskExecutionSnapshot);
    current.sessionCount += 1;
    if (!isSessionTerminal(session, archivedIds)) {
      current.allSessionsTerminal = false;
    }
    for (const pr of session.pullRequests ?? []) {
      current.prStates.push(toPrState(pr.status));
    }
    snapshots.set(taskId, current);
  }
  return snapshots;
};

const signatureOf = (snapshot: TaskExecutionSnapshot): string =>
  `${snapshot.allSessionsTerminal ? '1' : '0'}:${snapshot.sessionCount}:${snapshot.prStates.join(',')}`;

/**
 * Advances task status from what the linked sessions and pull requests actually
 * did.
 *
 * The two automations are deliberately different in kind:
 *
 * - `needs_review` is an attention prompt, so it fires only on a transition this
 *   client observed live. Applying it on load would bury the user under prompts
 *   about work they already know finished.
 * - Pull-request follow is deterministic reconciliation, so it may catch up. A
 *   task whose pull request merged last week is done whether or not anyone had
 *   the app open; refusing to say so is the dishonest option. An unknown or
 *   stale pull-request state never counts toward completion.
 *
 * Pull-request state is read from the linked sessions' metadata, which the
 * machine-side reconciler maintains — not from the task's own PR links, because
 * the list index deliberately carries no PR state and reading every task
 * document here would defeat it. The two agree in practice: linking a pull
 * request through the agent tool requires the session it came from.
 */
export function TaskStatusWatcher() {
  const tasks = useAtomValue(taskListAtom);
  const sessions = useAtomValue(allActiveSessionsAtom);
  const archived = useAtomValue(archivedSessionListAtom);
  const { updateTaskFields } = useTaskActions();

  const previousRef = useRef<Map<TaskId, string>>(new Map());
  const initializedRef = useRef(false);
  const inFlightRef = useRef<Set<TaskId>>(new Set());

  useEffect(() => {
    const archivedIds = new Set(archived.map((session) => session.id as string));
    const snapshots = buildSnapshots([...sessions, ...archived], archivedIds);
    const previous = previousRef.current;
    const next = new Map<TaskId, string>();

    for (const task of tasks) {
      const taskId = task.taskId as TaskId;
      const snapshot = snapshots.get(taskId);
      if (!snapshot) {
        continue;
      }
      const signature = signatureOf(snapshot);
      next.set(taskId, signature);

      if (task.status === 'done' || task.status === 'canceled') {
        continue;
      }
      if (inFlightRef.current.has(taskId)) {
        continue;
      }

      // Deterministic reconciliation: allowed to catch up on first pass.
      // `done` / `canceled` already returned above, so any follow status here is
      // necessarily a change — no need to compare against the current one.
      const followStatus = resolveTaskPrFollowStatus(snapshot.prStates);
      if (followStatus) {
        inFlightRef.current.add(taskId);
        void updateTaskFields(taskId, { status: followStatus })
          .catch(() => undefined)
          .finally(() => {
            inFlightRef.current.delete(taskId);
          });
        continue;
      }

      // Attention prompt: only on an observed flip, never retroactively.
      if (!initializedRef.current) {
        continue;
      }
      if (previous.get(taskId) === signature) {
        continue;
      }
      if (
        shouldEnterTaskNeedsReview({
          status: task.status,
          sessionTerminalStates: [snapshot.allSessionsTerminal],
          hasPrLinks: snapshot.prStates.length > 0,
        })
      ) {
        inFlightRef.current.add(taskId);
        void updateTaskFields(taskId, { status: 'needs_review' })
          .catch(() => undefined)
          .finally(() => {
            inFlightRef.current.delete(taskId);
          });
      }
    }

    previousRef.current = next;
    initializedRef.current = true;
  }, [archived, sessions, tasks, updateTaskFields]);

  return null;
}
