import { describe, expect, it } from 'vitest';
import {
  applyTaskIndexRowEvents,
  buildTaskIndexRow,
  computeTaskQueuePositions,
  countTaskLinks,
  getTaskIndexScanPrefix,
  listVisibleTaskIndexRows,
  parseTaskIndexRow,
  readTaskIndexRows,
  serializeTaskIndexKey,
  taskIndexKeys,
  type TaskIndexRow,
  type TaskIndexRowMap,
} from '../src/task-index';
import type { TaskId } from '../src/ids';

const row = (overrides: Partial<TaskIndexRow> = {}): TaskIndexRow => ({
  taskId: 't1',
  title: 'Title',
  status: 'backlog',
  ownerId: 'user-1',
  order: '1',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

describe('task index keys', () => {
  it('builds a scannable family key', () => {
    expect(taskIndexKeys.task('t1' as TaskId)).toEqual(['task', 't1']);
    expect(getTaskIndexScanPrefix()).toEqual(['task']);
    expect(serializeTaskIndexKey(taskIndexKeys.task('t1' as TaskId))).toBe('["task","t1"]');
  });
});

describe('parseTaskIndexRow', () => {
  it('accepts a valid row and drops unknown fields', () => {
    const parsed = parseTaskIndexRow({ ...row(), somethingElse: true });
    expect(parsed?.taskId).toBe('t1');
    expect(parsed && 'somethingElse' in parsed).toBe(false);
  });

  it('rejects rows that are not usable', () => {
    expect(parseTaskIndexRow(undefined)).toBeUndefined();
    expect(parseTaskIndexRow({ ...row(), status: 'nonsense' })).toBeUndefined();
    expect(parseTaskIndexRow({ ...row(), taskId: '' })).toBeUndefined();
    expect(parseTaskIndexRow({ ...row(), order: '' })).toBeUndefined();
  });
});

describe('readTaskIndexRows', () => {
  it('keys rows by task id', () => {
    const rows = readTaskIndexRows([
      { key: ['task', 't1'], value: row() },
      { key: ['task', 't2'], value: row({ taskId: 't2' }) },
    ]);
    expect(Object.keys(rows).sort()).toEqual(['t1', 't2']);
  });

  it('skips rows whose id disagrees with their key', () => {
    const rows = readTaskIndexRows([{ key: ['task', 't1'], value: row({ taskId: 'other' }) }]);
    expect(rows).toEqual({});
  });

  it('skips foreign families and malformed keys', () => {
    const rows = readTaskIndexRows([
      { key: ['other', 't1'], value: row() },
      { key: ['task'], value: row() },
      { key: ['task', ''], value: row() },
    ]);
    expect(rows).toEqual({});
  });
});

describe('applyTaskIndexRowEvents', () => {
  it('adds and replaces rows', () => {
    const first = applyTaskIndexRowEvents({}, [{ key: ['task', 't1'], value: row() }]);
    expect(first.t1?.title).toBe('Title');
    const second = applyTaskIndexRowEvents(first, [
      { key: ['task', 't1'], value: row({ title: 'Renamed' }) },
    ]);
    expect(second.t1?.title).toBe('Renamed');
  });

  it('removes a row when the value is gone', () => {
    const before: TaskIndexRowMap = { t1: row() };
    const after = applyTaskIndexRowEvents(before, [{ key: ['task', 't1'] }]);
    expect(after.t1).toBeUndefined();
  });

  it('removes a row that can no longer be read, rather than keeping a lie', () => {
    const before: TaskIndexRowMap = { t1: row() };
    const after = applyTaskIndexRowEvents(before, [
      { key: ['task', 't1'], value: { taskId: 't1', status: 'bogus' } },
    ]);
    expect(after.t1).toBeUndefined();
  });

  it('returns the same object when nothing changed, so subscribers do not re-render', () => {
    const before: TaskIndexRowMap = { t1: row() };
    const after = applyTaskIndexRowEvents(before, [{ key: ['other', 'x'], value: row() }]);
    expect(after).toBe(before);
  });

  it('leaves the previous map untouched', () => {
    const before: TaskIndexRowMap = { t1: row() };
    applyTaskIndexRowEvents(before, [{ key: ['task', 't2'], value: row({ taskId: 't2' }) }]);
    expect(Object.keys(before)).toEqual(['t1']);
  });
});

describe('listVisibleTaskIndexRows', () => {
  it('hides tombstoned rows', () => {
    const rows: TaskIndexRowMap = {
      t1: row(),
      t2: row({ taskId: 't2', deletedAt: 9 }),
    };
    expect(listVisibleTaskIndexRows(rows).map((entry) => entry.taskId)).toEqual(['t1']);
  });
});

describe('computeTaskQueuePositions', () => {
  const entrusted = (overrides: Partial<TaskIndexRow>): TaskIndexRow =>
    row({ hasAgent: true, agentConfigId: 'agent-1', ready: true, ...overrides });

  it('does not queue the head of an idle agent — it is about to run', () => {
    const positions = computeTaskQueuePositions([entrusted({ taskId: 'a', order: '1' })]);
    expect(positions.get('a')).toBeUndefined();
  });

  it('numbers the tasks behind the head', () => {
    const positions = computeTaskQueuePositions([
      entrusted({ taskId: 'b', order: '2' }),
      entrusted({ taskId: 'a', order: '1' }),
      entrusted({ taskId: 'c', order: '3' }),
    ]);
    expect(positions.get('a')).toBeUndefined();
    expect(positions.get('b')).toBe(1);
    expect(positions.get('c')).toBe(2);
  });

  it('puts everything behind work the agent already started', () => {
    const positions = computeTaskQueuePositions([
      entrusted({ taskId: 'running', status: 'in_progress' }),
      entrusted({ taskId: 'a', order: '1' }),
      entrusted({ taskId: 'b', order: '2' }),
    ]);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(2);
  });

  it('queues a todo task the same as a backlog one — the split is triage, not a gate', () => {
    const positions = computeTaskQueuePositions([
      entrusted({ taskId: 'running', status: 'in_progress' }),
      entrusted({ taskId: 'a', order: '1', status: 'todo' }),
    ]);
    expect(positions.get('a')).toBe(1);
  });

  it('queues each agent independently', () => {
    const positions = computeTaskQueuePositions([
      entrusted({ taskId: 'a1', order: '1', agentConfigId: 'agent-1' }),
      entrusted({ taskId: 'a2', order: '2', agentConfigId: 'agent-1' }),
      entrusted({ taskId: 'b1', order: '1', agentConfigId: 'agent-2' }),
      entrusted({ taskId: 'b2', order: '2', agentConfigId: 'agent-2' }),
    ]);
    expect(positions.get('a2')).toBe(1);
    expect(positions.get('b2')).toBe(1);
  });

  it('ignores tasks nobody was entrusted with', () => {
    const positions = computeTaskQueuePositions([
      row({ taskId: 'a', order: '1' }),
      row({ taskId: 'b', order: '2' }),
    ]);
    expect(positions.size).toBe(0);
  });

  it('does not queue an incomplete task — it waits on the user, not its turn', () => {
    const positions = computeTaskQueuePositions([
      entrusted({ taskId: 'a', order: '1' }),
      entrusted({ taskId: 'b', order: '2', ready: false }),
    ]);
    expect(positions.get('b')).toBeUndefined();
  });

  it('ignores finished, abandoned and tombstoned tasks', () => {
    const positions = computeTaskQueuePositions([
      entrusted({ taskId: 'a', order: '1' }),
      entrusted({ taskId: 'done', order: '2', status: 'done' }),
      entrusted({ taskId: 'gone', order: '3', deletedAt: 5 }),
      entrusted({ taskId: 'b', order: '4' }),
    ]);
    expect(positions.get('b')).toBe(1);
    expect(positions.get('done')).toBeUndefined();
    expect(positions.get('gone')).toBeUndefined();
  });

  it('breaks equal order keys by id so positions never flip', () => {
    const positions = computeTaskQueuePositions([
      entrusted({ taskId: 'z', order: '1' }),
      entrusted({ taskId: 'a', order: '1' }),
    ]);
    expect(positions.get('z')).toBe(1);
  });
});

describe('countTaskLinks', () => {
  const link = (over: Record<string, unknown>) =>
    ({ id: 'l', actorKind: 'human', linkedAt: 1, ...over }) as never;

  it('counts active session and pr links separately', () => {
    expect(
      countTaskLinks([
        link({ kind: 'session', sessionId: 's1' }),
        link({ kind: 'session', sessionId: 's2' }),
        link({ kind: 'pr', url: 'https://example.com/pr/1' }),
      ])
    ).toEqual({ sessionCount: 2, prCount: 1 });
  });

  it('ignores detached links so a removed session stops being counted', () => {
    // Detach writes a tombstone rather than deleting, so the row would keep
    // reporting work that is no longer attached if this skipped the check.
    expect(
      countTaskLinks([
        link({ kind: 'session', sessionId: 's1' }),
        link({ kind: 'session', sessionId: 's2', removedAt: 5 }),
        link({ kind: 'pr', url: 'https://example.com/pr/1', removedAt: 6 }),
      ])
    ).toEqual({ sessionCount: 1, prCount: 0 });
  });
});

describe('applyTaskIndexRowEvents batch folding', () => {
  const sampleRow = (taskId: string) => ({
    taskId,
    title: 'Sample',
    status: 'backlog' as const,
    ownerId: 'user-1',
    order: '1',
    createdAt: 1,
    updatedAt: 1,
  });

  it('removes a row added earlier in the same batch', () => {
    // Reconnect catch-up delivers many events at once. Consulting only the
    // previous map made an add-then-remove pair leave the task on screen.
    const key = taskIndexKeys.task('t1' as TaskId);
    const out = applyTaskIndexRowEvents({}, [{ key, value: sampleRow('t1') }, { key }]);

    expect(Object.keys(out)).toEqual([]);
  });

  it('lets an unreadable row supersede a good one from the same batch', () => {
    // "A row we cannot read is worse than absent" has to hold within a batch
    // too, or a stale row outlives the event that invalidated it.
    const key = taskIndexKeys.task('t2' as TaskId);
    const out = applyTaskIndexRowEvents({}, [
      { key, value: sampleRow('t2') },
      { key, value: { garbage: true } },
    ]);

    expect(Object.keys(out)).toEqual([]);
  });

  it('applies a remove then re-add in order', () => {
    const key = taskIndexKeys.task('t3' as TaskId);
    const out = applyTaskIndexRowEvents({ t3: sampleRow('t3') }, [
      { key },
      { key, value: { ...sampleRow('t3'), title: 'Renamed' } },
    ]);

    expect(out.t3?.title).toBe('Renamed');
  });
});

describe('buildTaskIndexRow priority and labels', () => {
  const source = {
    taskId: 't1' as TaskId,
    title: 'Task',
    status: 'backlog' as const,
    ownerId: 'u1',
    order: 'a0',
    createdAt: 1,
    updatedAt: 1,
  };
  const counts = { sessionCount: 0, prCount: 0 };

  it('omits priority when unset so no-priority stays distinct from medium', () => {
    expect(buildTaskIndexRow(source, counts).priority).toBeUndefined();
  });

  it('carries every explicit priority level, including medium', () => {
    expect(buildTaskIndexRow({ ...source, priority: 'urgent' }, counts).priority).toBe('urgent');
    expect(buildTaskIndexRow({ ...source, priority: 'medium' }, counts).priority).toBe('medium');
    expect(buildTaskIndexRow({ ...source, priority: 'low' }, counts).priority).toBe('low');
  });

  it('normalizes labels so two writers cannot split one label in two', () => {
    const built = buildTaskIndexRow({ ...source, labels: ['Bug', ' bug ', 'FEATURE'] }, counts);

    expect(built.labels).toEqual(['bug', 'feature']);
  });

  it('summarizes only the first project — a card draws one', () => {
    const built = buildTaskIndexRow(
      {
        ...source,
        projects: [
          { kind: 'github', repoFullName: 'loro-dev/lody' },
          { kind: 'github', repoFullName: 'other/repo' },
        ],
      },
      counts
    );

    expect(built.projectKind).toBe('github');
    expect(built.projectKey).toBe('loro-dev/lody');
  });

  it('carries a local project by id, for the client to resolve', () => {
    const built = buildTaskIndexRow(
      { ...source, projects: [{ kind: 'local', localProjectId: 'p1' }] },
      counts
    );

    expect(built.projectKind).toBe('local');
    expect(built.projectKey).toBe('p1');
  });

  it('omits the project when it is absent or an unrecognized shape', () => {
    expect(buildTaskIndexRow(source, counts).projectKind).toBeUndefined();
    expect(buildTaskIndexRow({ ...source, projects: [] }, counts).projectKind).toBeUndefined();
    expect(
      buildTaskIndexRow({ ...source, projects: [{ kind: 'martian' }] }, counts).projectKind
    ).toBeUndefined();
  });

  it('omits labels entirely when there are none', () => {
    expect(buildTaskIndexRow(source, counts).labels).toBeUndefined();
    expect(buildTaskIndexRow({ ...source, labels: [] }, counts).labels).toBeUndefined();
  });
});
