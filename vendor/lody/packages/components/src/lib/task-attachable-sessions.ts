import type { SessionMeta, TaskId } from '@lody/shared';
import type { AttachableSession } from '@/components/tasks/task-attach-session-dialog';

/**
 * Candidate sessions for manual attachment to a task.
 *
 * A session belongs to at most one task, so one already recorded elsewhere is
 * returned annotated rather than dropped — the picker disables it and says which
 * task has it. Sessions already on *this* task are omitted entirely, since they
 * are visible right above the picker.
 */
export const selectAttachableSessions = (
  sessions: readonly SessionMeta[],
  currentTaskId: TaskId,
  taskTitleById: ReadonlyMap<string, string>
): AttachableSession[] =>
  sessions
    .filter((session) => session.taskId !== currentTaskId)
    .map((session) => {
      const attachedTaskId = session.taskId;
      return {
        sessionId: session.id as string,
        title: session.title ?? '',
        ...(session.repoFullName ? { contextLabel: session.repoFullName } : {}),
        ...(session.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}),
        ...(attachedTaskId
          ? { attachedTaskTitle: taskTitleById.get(attachedTaskId) ?? attachedTaskId }
          : {}),
      };
    })
    // Most recently active first: the conversation you mean is usually the one
    // you were just in.
    .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
