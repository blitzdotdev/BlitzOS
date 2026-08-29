import { describe, expect, it } from 'vitest';
import type { SessionMeta, TaskId } from '@lody/shared';
import { selectAttachableSessions } from '../src/lib/task-attachable-sessions';

const TASK = 't1' as TaskId;
const OTHER = 't2' as TaskId;

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: 'session-1',
    machineId: 'machine-1',
    createdAt: '2026-07-26T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'codex',
    ...overrides,
  }) as SessionMeta;

const titles = new Map([['t2', 'Refactor auth']]);

describe('selectAttachableSessions', () => {
  it('offers an unattached session', () => {
    const result = selectAttachableSessions([session({ id: 'a', title: 'Chat' })], TASK, titles);
    expect(result).toHaveLength(1);
    expect(result[0]?.attachedTaskTitle).toBeUndefined();
  });

  it('omits sessions already on this task — they are listed above the picker', () => {
    const result = selectAttachableSessions([session({ id: 'a', taskId: TASK })], TASK, titles);
    expect(result).toHaveLength(0);
  });

  it('shows a session held by another task, annotated rather than hidden', () => {
    const result = selectAttachableSessions([session({ id: 'a', taskId: OTHER })], TASK, titles);
    expect(result[0]?.attachedTaskTitle).toBe('Refactor auth');
  });

  it('falls back to the task id when its title has not synced yet', () => {
    const result = selectAttachableSessions(
      [session({ id: 'a', taskId: 't9' as TaskId })],
      TASK,
      titles
    );
    expect(result[0]?.attachedTaskTitle).toBe('t9');
  });

  it('carries the repo as context so similar titles can be told apart', () => {
    const result = selectAttachableSessions(
      [session({ id: 'a', repoFullName: 'loro-dev/lody' })],
      TASK,
      titles
    );
    expect(result[0]?.contextLabel).toBe('loro-dev/lody');
  });

  it('puts the most recently active conversation first', () => {
    const result = selectAttachableSessions(
      [
        session({ id: 'old', lastMessageAt: 10 }),
        session({ id: 'recent', lastMessageAt: 99 }),
        session({ id: 'never' }),
      ],
      TASK,
      titles
    );
    expect(result.map((entry) => entry.sessionId)).toEqual(['recent', 'old', 'never']);
  });

  it('tolerates a missing title without inventing one', () => {
    const result = selectAttachableSessions([session({ id: 'a' })], TASK, titles);
    expect(result[0]?.title).toBe('');
  });
});
