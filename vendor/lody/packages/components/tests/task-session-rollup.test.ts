import { describe, expect, it } from 'vitest';
import type { SessionMeta, TaskId } from '@lody/shared';
import { buildTaskSessionRollups } from '../src/hooks/use-task-session-rollup';

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'session-1',
    machineId: 'machine-1',
    createdAt: '2026-07-26T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'codex',
    ...overrides,
  }) as SessionMeta;

const TASK = 't1' as TaskId;

describe('buildTaskSessionRollups', () => {
  it('ignores sessions that belong to no task', () => {
    expect(buildTaskSessionRollups([session()]).size).toBe(0);
  });

  it('groups sessions under their task', () => {
    const rollups = buildTaskSessionRollups([
      session({ id: 'a', taskId: TASK }),
      session({ id: 'b', taskId: TASK }),
    ]);
    expect(rollups.get(TASK)?.sessions).toHaveLength(2);
  });

  it('flags needs-you from live status', () => {
    const rollups = buildTaskSessionRollups([
      session({ taskId: TASK, status: { type: 'requestPermission' } }),
    ]);
    expect(rollups.get(TASK)?.needsYou).toBe(true);
  });

  it('keeps needs-you after the heartbeat repaired the status to idle', () => {
    // This is the case the durable marker exists for: the machine went offline
    // mid-question, so the live status no longer says anything.
    const rollups = buildTaskSessionRollups([
      session({ taskId: TASK, status: { type: 'idle' }, awaitingUserSince: 1234 }),
    ]);
    expect(rollups.get(TASK)?.needsYou).toBe(true);
  });

  it('drops needs-you once the request resolved and the marker was cleared', () => {
    const rollups = buildTaskSessionRollups([session({ taskId: TASK, status: { type: 'idle' } })]);
    expect(rollups.get(TASK)?.needsYou).toBe(false);
  });

  it('reports running for both running and initializing sessions', () => {
    expect(
      buildTaskSessionRollups([session({ taskId: TASK, status: { type: 'running' } })]).get(TASK)
        ?.running
    ).toBe(true);
    expect(
      buildTaskSessionRollups([session({ taskId: TASK, status: { type: 'initializing' } })]).get(
        TASK
      )?.running
    ).toBe(true);
  });

  it('counts only pull requests that are still open', () => {
    const rollups = buildTaskSessionRollups([
      session({
        taskId: TASK,
        pullRequests: [
          { url: 'a', status: 'open' },
          { url: 'b', status: 'draft' },
          { url: 'c', status: 'merged' },
          { url: 'd', status: 'closed' },
        ] as SessionMeta['pullRequests'],
      }),
    ]);
    expect(rollups.get(TASK)?.openPrCount).toBe(2);
  });

  it('one waiting session is enough to flag the whole task', () => {
    const rollups = buildTaskSessionRollups([
      session({ id: 'a', taskId: TASK, status: { type: 'running' } }),
      session({ id: 'b', taskId: TASK, awaitingUserSince: 9 }),
    ]);
    expect(rollups.get(TASK)?.needsYou).toBe(true);
    expect(rollups.get(TASK)?.running).toBe(true);
  });
});
