import { nextCronFireMs } from './cron-next-fire';
import type { PendingScheduledTask } from './schema';

/**
 * Derive the session's currently-pending scheduled tasks (cron jobs / wakeups) purely from
 * the Cron* / ScheduleWakeup `tool_call` items already in session history. Nothing extra is
 * persisted — not in `SessionMeta`, not as a new history item; the panel above the composer
 * calls this on the history it already renders.
 *
 * The persisted `tool_call` keeps `title` (the tool name), `rawInput`, `rawOutput`, `content`,
 * `status`, and `schedulingTimeZone` (the creating machine's zone), but not provider metadata.
 * So we reconstruct from
 * `rawInput` + the owning turn's timestamp:
 *  - ScheduleWakeup: only the latest matters; scheduledFor ≈ turn end + delaySeconds (no TZ).
 *  - CronCreate: schedule/recurring/prompt come from rawInput.cron/recurring/prompt, and the
 *    cron is local-time to `schedulingTimeZone` — carried onto the task so the UI resolves it
 *    in the right zone (cron carries no timezone; the machine may differ from the viewer).
 *  - CronDelete: removes any cron whose output text contains the deleted id.
 *  - CronList: skipped (its structured jobs aren't persisted).
 * Fire-time resolution and "already fired -> hide" happen in the UI (see `nextCronFireMs`).
 */

const MAX_SUMMARY_LENGTH = 200;
const WAKEUP_TASK_ID = 'wakeup';

export interface ScheduledTaskHistoryEntry {
  timestamp?: string;
  startedAt?: number;
  endedAt?: number;
  // Structural, not `MessageContent[]`: the web's mirror-generated history item type
  // diverges from the hand-written union, so we read items defensively at runtime.
  items?: readonly unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateSummary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_SUMMARY_LENGTH
    ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : trimmed;
}

/** Strip undefined fields so the result is minimal and comparisons stay stable. */
function cleanTask(task: PendingScheduledTask): PendingScheduledTask {
  const out: PendingScheduledTask = { id: task.id, kind: task.kind, createdAtMs: task.createdAtMs };
  if (task.scheduledForMs !== undefined) out.scheduledForMs = task.scheduledForMs;
  if (task.humanSchedule !== undefined) out.humanSchedule = task.humanSchedule;
  if (task.recurring !== undefined) out.recurring = task.recurring;
  if (task.durable !== undefined) out.durable = task.durable;
  if (task.summary !== undefined) out.summary = task.summary;
  if (task.timeZone !== undefined) out.timeZone = task.timeZone;
  return out;
}

/** Best-effort anchor for a turn: prefer when it ended, else started, else its timestamp. */
function resolveAnchorMs(entry: ScheduledTaskHistoryEntry): number {
  if (typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt)) return entry.endedAt;
  if (typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt))
    return entry.startedAt;
  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function collectPendingScheduledTasksFromHistory(
  entries: readonly ScheduledTaskHistoryEntry[]
): PendingScheduledTask[] {
  const cronByCallId = new Map<string, { task: PendingScheduledTask; sourceText: string }>();
  let wakeup: PendingScheduledTask | undefined;

  for (const entry of entries) {
    const anchorMs = resolveAnchorMs(entry);
    for (const rawItem of entry.items ?? []) {
      const item = asRecord(rawItem);
      if (!item || item.type !== 'tool_call' || item.status !== 'completed') continue;
      // `toolName` is the canonical name; older history pinned it into `title`.
      const toolName = asString(item.toolName) ?? asString(item.title);
      if (!toolName) continue;
      const rawInput = asRecord(item.rawInput) ?? {};

      switch (toolName) {
        case 'ScheduleWakeup': {
          const delaySeconds = asFiniteNumber(rawInput.delaySeconds);
          wakeup = cleanTask({
            id: WAKEUP_TASK_ID,
            kind: 'wakeup',
            createdAtMs: anchorMs,
            scheduledForMs: delaySeconds !== undefined ? anchorMs + delaySeconds * 1000 : undefined,
            summary: truncateSummary(asString(rawInput.reason) ?? asString(rawInput.prompt)),
          });
          break;
        }
        case 'CronCreate': {
          const cron = asString(rawInput.cron);
          const toolCallId = asString(item.toolCallId);
          if (!cron || !toolCallId) break;
          cronByCallId.set(toolCallId, {
            task: cleanTask({
              id: toolCallId,
              kind: 'cron',
              createdAtMs: anchorMs,
              humanSchedule: cron,
              recurring: asBoolean(rawInput.recurring),
              summary: truncateSummary(asString(rawInput.prompt)),
              // Cron is local-time to the machine that created it (recorded at persist time).
              timeZone: asString(item.schedulingTimeZone),
            }),
            // The created job's id (needed to match a later CronDelete) is only in the
            // output text, so keep it for a robust substring match.
            sourceText: JSON.stringify([item.rawOutput ?? null, item.content ?? null]),
          });
          break;
        }
        case 'CronDelete': {
          const id = asString(rawInput.id);
          if (!id) break;
          // Deleting the current key during Map iteration is safe per spec.
          for (const [callId, existing] of cronByCallId) {
            if (existing.sourceText.includes(id)) cronByCallId.delete(callId);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const cronTasks = [...cronByCallId.values()].map((entry) => entry.task);
  return wakeup ? [wakeup, ...cronTasks] : cronTasks;
}

/** Resolve a task's concrete fire time: wakeups carry it, cron jobs derive it. */
export function resolveFireMs(task: PendingScheduledTask, nowMs: number): number | undefined {
  if (task.kind === 'wakeup') {
    return typeof task.scheduledForMs === 'number' ? task.scheduledForMs : undefined;
  }
  if (!task.humanSchedule) return undefined;
  // Cron expressions are local-time to the machine that created the job, so resolve them in
  // that machine's timezone (falls back to the viewer's local zone when unknown).
  const timeZone = task.timeZone;
  // Recurring cron: next occurrence relative to now (always upcoming).
  if (task.recurring) return nextCronFireMs(task.humanSchedule, nowMs, timeZone);
  // One-shot cron: its single fire time, anchored at creation — so once it has fired the
  // time resolves to the PAST (and the row is hidden) instead of jumping to next year.
  // Anchor just before the START of the creation minute (nextCronFireMs matches strictly
  // after `from`, rounded up to the next whole minute): a cron scheduled to fire in the
  // same minute it was created (e.g. "25 16 3 7 *" while the turn ends at 16:25:1x) must
  // still resolve to that minute — otherwise it skips a year ahead and never hides.
  const creationMinuteStartMs = Math.floor(task.createdAtMs / 60_000) * 60_000;
  return nextCronFireMs(task.humanSchedule, creationMinuteStartMs - 1, timeZone);
}
