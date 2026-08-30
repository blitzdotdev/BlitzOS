import type { SessionMeta } from '@lody/shared';

/**
 * What a linked conversation is doing right now, as the task view reports it.
 *
 * This is NOT a task-level status field — nothing here is stored on the task.
 * It is the session's own fact, read at render time, which is the rule for
 * every live signal the task surface shows (see AGENTS.md: "任务层没有第二状态
 * 系统").
 *
 * `null` means "we cannot say": the session meta has not synced to this client
 * (or the session is gone). An unknown session must not be drawn as idle —
 * "finished" and "never arrived" are different answers.
 */
export type TaskSessionActivity = 'needs-you' | 'running' | 'starting' | 'idle';

/**
 * needs-you comes from `awaitingUserSince` first, not just `status`: the
 * heartbeat TTL repairs a stale active status back to idle, so a machine that
 * dropped offline mid-question would otherwise lose exactly the signal that
 * matters. `requestPermission` is the live accelerator for the same fact.
 */
export function resolveTaskSessionActivity(
  session: Pick<SessionMeta, 'status' | 'awaitingUserSince'> | undefined
): TaskSessionActivity | null {
  if (!session) return null;
  const type = session.status?.type;
  if (session.awaitingUserSince !== undefined || type === 'requestPermission') {
    return 'needs-you';
  }
  if (type === 'running') return 'running';
  if (type === 'initializing') return 'starting';
  return 'idle';
}

export type TaskSessionActivityPresentation = {
  labelKey: string;
  labelFallback: string;
  /** Badge classes; idle stays a plain muted word so only live work draws the eye. */
  className: string;
};

export const TASK_SESSION_ACTIVITY_PRESENTATION: Record<
  TaskSessionActivity,
  TaskSessionActivityPresentation
> = {
  'needs-you': {
    labelKey: 'tasks.needsYou',
    labelFallback: 'Needs you',
    className: 'bg-status-warning/15 text-status-warning',
  },
  running: {
    labelKey: 'tasks.session.running',
    labelFallback: 'Running',
    className: 'bg-status-info/15 text-status-info',
  },
  starting: {
    labelKey: 'tasks.session.starting',
    labelFallback: 'Starting',
    className: 'bg-status-info/15 text-status-info',
  },
  idle: {
    labelKey: 'tasks.session.idle',
    labelFallback: 'Idle',
    className: 'bg-muted-foreground/10 text-muted-foreground',
  },
};
