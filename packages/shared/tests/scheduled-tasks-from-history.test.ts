import { describe, expect, it } from 'vitest';
import type { MessageContent } from '../src/ai';
import {
  collectPendingScheduledTasksFromHistory,
  type ScheduledTaskHistoryEntry,
} from '../src/scheduled-tasks-from-history';

function toolCall(args: {
  toolCallId: string;
  title: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  schedulingTimeZone?: string;
}): MessageContent {
  return {
    type: 'tool_call',
    toolCallId: args.toolCallId,
    title: args.title,
    status: args.status ?? 'completed',
    kind: 'other',
    rawInput: args.rawInput,
    rawOutput: args.rawOutput,
    schedulingTimeZone: args.schedulingTimeZone,
  } as MessageContent;
}

function entry(endedAt: number, items: MessageContent[]): ScheduledTaskHistoryEntry {
  return { timestamp: new Date(endedAt).toISOString(), endedAt, items };
}

describe('collectPendingScheduledTasksFromHistory', () => {
  it('derives a wakeup with scheduledFor = turn end + delaySeconds', () => {
    const endedAt = 1_000_000;
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(endedAt, [
        toolCall({
          toolCallId: 'w1',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 120, reason: 'wake up and report' },
        }),
      ]),
    ]);
    expect(tasks).toEqual([
      {
        id: 'wakeup',
        kind: 'wakeup',
        createdAtMs: endedAt,
        scheduledForMs: endedAt + 120_000,
        summary: 'wake up and report',
      },
    ]);
  });

  it('keeps only the latest ScheduleWakeup', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'w1',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 60, reason: 'first' },
        }),
      ]),
      entry(2_000, [
        toolCall({
          toolCallId: 'w2',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 30, reason: 'second' },
        }),
      ]),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'wakeup',
      createdAtMs: 2_000,
      scheduledForMs: 2_000 + 30_000,
      summary: 'second',
    });
  });

  it('derives a cron task from CronCreate rawInput', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(5_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '0 9 * * 1-5', prompt: 'daily standup', recurring: true },
          rawOutput: 'Scheduled task ab9963d6 (0 9 * * 1-5).',
        }),
      ]),
    ]);
    expect(tasks).toEqual([
      {
        id: 'c1',
        kind: 'cron',
        createdAtMs: 5_000,
        humanSchedule: '0 9 * * 1-5',
        recurring: true,
        summary: 'daily standup',
      },
    ]);
  });

  it('propagates the persisted machine timezone onto the cron task', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(5_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '0 9 * * *', prompt: 'p' },
          schedulingTimeZone: 'America/New_York',
        }),
      ]),
    ]);
    expect(tasks[0]?.timeZone).toBe('America/New_York');
  });

  it('removes a cron when a later CronDelete references its id', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '17 8 3 7 *', prompt: 'one-shot' },
          rawOutput: 'Scheduled one-shot task ab9963d6 (17 8 3 7 *).',
        }),
      ]),
      entry(2_000, [
        toolCall({ toolCallId: 'd1', title: 'CronDelete', rawInput: { id: 'ab9963d6' } }),
      ]),
    ]);
    expect(tasks).toEqual([]);
  });

  it('ignores non-completed tool calls and unrelated tools', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'p1',
          title: 'CronCreate',
          status: 'pending',
          rawInput: { cron: '* * * * *' },
        }),
        toolCall({ toolCallId: 'r1', title: 'Read', rawInput: { path: 'x' } }),
        { type: 'text', text: 'hello' } as MessageContent,
      ]),
    ]);
    expect(tasks).toEqual([]);
  });

  it('coexists a wakeup and cron jobs, wakeup first', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '0 9 * * *', prompt: 'p' },
        }),
        toolCall({
          toolCallId: 'w1',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 30, reason: 'r' },
        }),
      ]),
    ]);
    expect(tasks.map((t) => t.kind)).toEqual(['wakeup', 'cron']);
  });
});
