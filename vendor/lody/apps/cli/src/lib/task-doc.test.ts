import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { Flock } from '@loro-dev/flock-wasm';
import {
  getTaskIndexFlockDocId,
  taskIndexKeys,
  taskDocSchema,
  type TaskId,
  type TaskIndexRowMap,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroDocumentManager } from './loro/doc';
import {
  applyAgentTaskUpdate,
  createTaskFromAgent,
  listWorkspaceTaskIds,
  planWorkspaceTaskEnumeration,
  readTask,
  selectTaskIndexRows,
} from './task-doc';

const row = (taskId: string, deletedAt?: number) => ({
  taskId,
  title: taskId,
  status: 'todo' as const,
  ownerId: 'user-1',
  order: taskId,
  createdAt: 1,
  updatedAt: 1,
  ...(deletedAt === undefined ? {} : { deletedAt }),
});

describe('planWorkspaceTaskEnumeration', () => {
  it('repairs only meta-discovered tasks with no index row', () => {
    const indexRows: TaskIndexRowMap = {
      visible: row('visible'),
      deleted: row('deleted', 2),
    };

    expect(
      planWorkspaceTaskEnumeration(indexRows, [
        'visible',
        'deleted',
        'missing',
        'missing',
      ] as TaskId[])
    ).toEqual({
      visibleTaskIds: ['visible'],
      missingIndexTaskIds: ['missing'],
    });
  });
});

describe('selectTaskIndexRows', () => {
  const listRow = (
    taskId: string,
    overrides: Partial<TaskIndexRowMap[string]> = {}
  ): TaskIndexRowMap[string] => ({ ...row(taskId), ...overrides });

  const rows: TaskIndexRowMap = {
    mine: listRow('mine', { title: 'Fix the header', updatedAt: 30 }),
    theirs: listRow('theirs', { ownerId: 'user-2', title: 'Header audit', updatedAt: 40 }),
    unassigned: listRow('unassigned', { ownerId: '', updatedAt: 20 }),
    entrusted: listRow('entrusted', { hasAgent: true, updatedAt: 10 }),
    dropped: listRow('dropped', { deletedAt: 5, updatedAt: 99 }),
    shipped: listRow('shipped', { status: 'done', updatedAt: 50 }),
  };

  it('orders newest-updated first and never returns a tombstoned row', () => {
    const page = selectTaskIndexRows(rows, { limit: 10 });
    expect(page.rows.map((entry) => entry.taskId)).toEqual([
      'shipped',
      'theirs',
      'mine',
      'unassigned',
      'entrusted',
    ]);
    expect(page.matched).toBe(5);
  });

  it('reports the match count so a truncated page is not read as everything', () => {
    const page = selectTaskIndexRows(rows, { limit: 2 });
    expect(page.rows.map((entry) => entry.taskId)).toEqual(['shipped', 'theirs']);
    expect(page.matched).toBe(5);
  });

  it('filters by status, owner, agent presence, and title substring', () => {
    expect(
      selectTaskIndexRows(rows, { status: ['done'], limit: 10 }).rows.map((e) => e.taskId)
    ).toEqual(['shipped']);
    expect(
      selectTaskIndexRows(rows, { ownerId: 'user-2', limit: 10 }).rows.map((e) => e.taskId)
    ).toEqual(['theirs']);
    // Empty owner is the unassigned filter, not "no filter".
    expect(selectTaskIndexRows(rows, { ownerId: '', limit: 10 }).rows.map((e) => e.taskId)).toEqual(
      ['unassigned']
    );
    expect(
      selectTaskIndexRows(rows, { hasAgent: true, limit: 10 }).rows.map((e) => e.taskId)
    ).toEqual(['entrusted']);
    expect(selectTaskIndexRows(rows, { hasAgent: false, limit: 10 }).matched).toBe(4);
    expect(
      selectTaskIndexRows(rows, { titleContains: 'HEADER', limit: 10 }).rows.map((e) => e.taskId)
    ).toEqual(['theirs', 'mine']);
  });

  it('breaks ties on taskId so repeated calls return the same page', () => {
    const tied: TaskIndexRowMap = {
      b: listRow('b', { updatedAt: 7 }),
      a: listRow('a', { updatedAt: 7 }),
    };
    expect(selectTaskIndexRows(tied, { limit: 10 }).rows.map((entry) => entry.taskId)).toEqual([
      'a',
      'b',
    ]);
  });
});

/**
 * A workspace whose index actually stores what was written and whose rooms are
 * distinct documents. Both matter: a `scan` that always returns nothing would
 * make the index-row dedup untestable, and one shared document would make every
 * task id resolve to the same task.
 */
const createFakeWorkspace = (
  seedRows: readonly { key: readonly unknown[]; value: unknown }[] = []
) => {
  const rows = new Map<string, { key: readonly unknown[]; value: unknown }>(
    seedRows.map((entry) => [JSON.stringify(entry.key), entry])
  );
  const docs = new Map<string, LoroDoc>();
  const flock = {
    scan: vi.fn((options?: { prefix?: readonly unknown[] }) =>
      [...rows.values()].filter((entry) =>
        (options?.prefix ?? []).every((part, index) => entry.key[index] === part)
      )
    ),
    set: vi.fn((key: readonly unknown[], value: unknown) => {
      rows.set(JSON.stringify(key), { key, value });
    }),
    commit: vi.fn(),
  };
  const handle = { flock, syncOnce: vi.fn(async () => undefined) };
  const manager = {
    syncDocOrThrow: vi.fn(async () => undefined),
    repo: {
      openFlockDoc: vi.fn(async () => handle),
      openPersistedDoc: vi.fn(async (roomId: string) => {
        const existing = docs.get(roomId) ?? new LoroDoc();
        docs.set(roomId, existing);
        return { doc: existing, syncOnce: async () => undefined };
      }),
      flush: vi.fn(async () => undefined),
    },
  } as unknown as LoroDocumentManager;
  return { flock, manager };
};

describe('createTaskFromAgent', () => {
  const setupWorkspace = createFakeWorkspace;

  it('writes a readable task document and publishes its index row', async () => {
    const { flock, manager } = setupWorkspace();

    const created = await createTaskFromAgent(
      manager,
      'workspace-1' as WorkspaceId,
      { title: 'Fix the sidebar outline', body: '## Why\n\nIt is clipped.', priority: 'high' },
      { agentConfigId: 'agent-1', name: 'Claude' },
      'user-1'
    );

    expect(created).not.toBeNull();
    if (!created) return;
    expect(created.meta.title).toBe('Fix the sidebar outline');
    // Creation defaults: backlog, owned by the operator, never entrusted to an
    // agent — an agent-created task must not be able to start itself.
    expect(created.meta.status).toBe('backlog');
    expect(created.meta.ownerId).toBe('user-1');
    expect(created.meta.createdBy).toBe('user-1');
    expect(created.meta.agent).toBeUndefined();
    expect(created.body).toBe('## Why\n\nIt is clipped.');

    // Attribution lives on the timeline entry: turn-level authorship is the
    // human operator and cannot say "an agent wrote this".
    expect(created.timeline).toEqual([
      expect.objectContaining({
        kind: 'activity',
        activityType: 'created',
        actorKind: 'agent',
        actorId: 'agent-1',
        actorName: 'Claude',
      }),
    ]);

    expect(flock.set).toHaveBeenCalledWith(
      ['task', created.meta.taskId],
      expect.objectContaining({
        taskId: created.meta.taskId,
        title: 'Fix the sidebar outline',
        status: 'backlog',
        priority: 'high',
        hasAgent: false,
      })
    );
    expect(flock.commit).toHaveBeenCalledOnce();
  });

  it('reads back through readTask, so the seeded document is a real task', async () => {
    const { manager } = setupWorkspace();
    const created = await createTaskFromAgent(
      manager,
      'workspace-1' as WorkspaceId,
      { title: 'Round trip' },
      {},
      'user-1'
    );
    expect(created).not.toBeNull();
    if (!created) return;

    // The same document, re-opened without the creation seed: a placeholder
    // would surface here instead of the real task.
    await expect(readTask(manager, created.meta.taskId)).resolves.toEqual(
      expect.objectContaining({ meta: expect.objectContaining({ title: 'Round trip' }) })
    );
  });

  it('orders a new task after the ones already in the index', async () => {
    const { manager } = setupWorkspace([
      { key: ['task', 'existing'], value: { ...row('existing'), order: 'a1' } },
    ]);
    const created = await createTaskFromAgent(
      manager,
      'workspace-1' as WorkspaceId,
      { title: 'Later' },
      {},
      'user-1'
    );
    expect(created?.meta.order && created.meta.order > 'a1').toBe(true);
  });

  it('creates nothing when there is neither a title nor a body', async () => {
    const { flock, manager } = setupWorkspace();
    await expect(
      createTaskFromAgent(manager, 'workspace-1' as WorkspaceId, { title: '  ' }, {}, 'user-1')
    ).resolves.toBeNull();
    expect(flock.set).not.toHaveBeenCalled();
  });
});

describe('applyAgentTaskUpdate', () => {
  const setupTask = async () => {
    const { flock, manager } = createFakeWorkspace();
    const created = await createTaskFromAgent(
      manager,
      'workspace-1' as WorkspaceId,
      { title: 'Before', priority: 'low', labels: ['bug'] },
      {},
      'user-1'
    );
    if (!created) throw new Error('setup failed to create a task');
    flock.set.mockClear();
    return { manager, flock, taskId: created.meta.taskId };
  };

  const activityTypes = (snapshot: { timeline: readonly { activityType?: string }[] }) =>
    snapshot.timeline.map((entry) => entry.activityType).filter(Boolean);

  it('writes every scalar property and records one attributed activity each', async () => {
    const { manager, taskId } = await setupTask();

    const updated = await applyAgentTaskUpdate(
      manager,
      'workspace-1' as WorkspaceId,
      taskId,
      {
        status: 'in_progress',
        title: 'After',
        ownerId: 'user-2',
        priority: 'urgent',
        labels: ['Feature'],
        projects: [{ kind: 'github', repoFullName: 'o/r', branch: 'main' }],
      },
      { agentConfigId: 'agent-1', name: 'Claude' }
    );

    expect(updated?.meta).toEqual(
      expect.objectContaining({
        status: 'in_progress',
        title: 'After',
        ownerId: 'user-2',
        priority: 'urgent',
        // Labels are normalized lowercase so "Feature" and "feature" stay one label.
        labels: ['feature'],
      })
    );
    expect(updated?.meta.projects).toEqual([
      { kind: 'github', repoFullName: 'o/r', branch: 'main' },
    ]);
    expect(activityTypes(updated!)).toEqual([
      'created',
      'status_changed',
      'title_changed',
      'owner_changed',
      'priority_changed',
      'labels_changed',
      'projects_changed',
    ]);
    expect(updated?.timeline.at(-1)).toEqual(
      expect.objectContaining({ actorKind: 'agent', actorId: 'agent-1', actorName: 'Claude' })
    );
  });

  it('clears a priority on "none" and unassigns on an empty owner', async () => {
    const { manager, taskId } = await setupTask();
    const updated = await applyAgentTaskUpdate(
      manager,
      'workspace-1' as WorkspaceId,
      taskId,
      { priority: null, ownerId: '' },
      {}
    );
    expect(updated?.meta.priority).toBeUndefined();
    expect(updated?.meta.ownerId).toBe('');
    expect(activityTypes(updated!)).toEqual(['created', 'owner_changed', 'priority_changed']);
  });

  it('does not rewrite an unchanged project list', async () => {
    const { manager, taskId } = await setupTask();
    const project = { kind: 'github' as const, repoFullName: 'o/r', branch: 'main' };
    const first = await applyAgentTaskUpdate(
      manager,
      'workspace-1' as WorkspaceId,
      taskId,
      { projects: [project] },
      {}
    );
    expect(activityTypes(first!)).toEqual(['created', 'projects_changed']);

    // Re-sending the same project (an agent retry, or an idempotent re-issue)
    // must not append to an append-only timeline, and must not bump updatedAt —
    // that would re-sort the task to the top of every newest-updated-first list.
    const updatedAtAfterFirst = first!.meta.updatedAt;
    const second = await applyAgentTaskUpdate(
      manager,
      'workspace-1' as WorkspaceId,
      taskId,
      { projects: [{ ...project }] },
      {}
    );
    expect(activityTypes(second!)).toEqual(['created', 'projects_changed']);
    expect(second!.meta.updatedAt).toBe(updatedAtAfterFirst);
  });

  it('treats a reordered label set as unchanged', async () => {
    const { manager, taskId } = await setupTask();
    const withTwo = await applyAgentTaskUpdate(
      manager,
      'workspace-1' as WorkspaceId,
      taskId,
      { labels: ['bug', 'ui'] },
      {}
    );
    expect(activityTypes(withTwo!)).toEqual(['created', 'labels_changed']);

    const reordered = await applyAgentTaskUpdate(
      manager,
      'workspace-1' as WorkspaceId,
      taskId,
      { labels: ['ui', 'bug'] },
      {}
    );
    expect(activityTypes(reordered!)).toEqual(['created', 'labels_changed']);
  });

  it('records nothing when the values already match', async () => {
    const { manager, flock, taskId } = await setupTask();
    const updated = await applyAgentTaskUpdate(
      manager,
      'workspace-1' as WorkspaceId,
      taskId,
      {
        status: 'backlog',
        title: 'Before',
        priority: 'low',
        labels: ['bug'],
        ownerId: 'user-1',
        projects: [],
      },
      {}
    );
    // A no-op update must not spam the thread — the timeline still holds only
    // the creation entry.
    expect(activityTypes(updated!)).toEqual(['created']);
    // Republishing an unchanged row is skipped, so the index write is not reissued.
    expect(flock.set).not.toHaveBeenCalled();
  });

  it('refuses a task that does not exist', async () => {
    const { manager } = await setupTask();
    await expect(
      applyAgentTaskUpdate(
        manager,
        'workspace-1' as WorkspaceId,
        'missing' as TaskId,
        { status: 'done' },
        {}
      )
    ).resolves.toBeNull();
  });
});

describe('listWorkspaceTaskIds', () => {
  // Uses a REAL `Flock`: the index scan used to be detached from its receiver,
  // which throws at runtime while the plain-function scan mock below passes.
  it('enumerates visible rows from a real task index Flock', async () => {
    const indexFlock = new Flock('index-peer');
    for (const indexRow of [row('t1'), row('t2'), row('t3', 9)]) {
      indexFlock.set(taskIndexKeys.task(indexRow.taskId as TaskId), { ...indexRow });
    }
    indexFlock.commit();

    const manager = {
      repo: {
        // No `e/*` existence rows, so nothing needs index repair.
        getMeta: () => new Flock('meta-peer'),
        openFlockDoc: vi.fn(async (flockDocId: string) => {
          expect(flockDocId).toBe(getTaskIndexFlockDocId('workspace-1' as WorkspaceId));
          return { flock: indexFlock };
        }),
      },
    } as unknown as LoroDocumentManager;

    await expect(listWorkspaceTaskIds(manager, 'workspace-1' as WorkspaceId)).resolves.toEqual([
      't1',
      't2',
    ]);
  });

  it('returns an existence-only Task and republishes its missing index row', async () => {
    const taskId = 'recovered' as TaskId;
    const meta = {
      taskId,
      title: 'Recovered task',
      status: 'todo' as const,
      ownerId: 'user-1',
      order: 'a0',
      createdAt: 1,
      updatedAt: 1,
    };
    const doc = new LoroDoc();
    const seed = new Mirror({
      doc,
      schema: taskDocSchema,
      initialState: {
        meta: {
          taskId: 'placeholder',
          title: '',
          status: 'backlog',
          ownerId: '',
          order: 'z0',
          agent: undefined,
          projects: undefined,
          lastRunConfig: undefined,
          createdAt: 0,
          updatedAt: 0,
          createdBy: undefined,
        },
        body: '',
        links: [],
        timeline: [],
      },
    });
    seed.setState((draft) => {
      Object.assign(draft.meta, meta);
    });
    seed.dispose();

    const flock = {
      scan: vi.fn(() => []),
      set: vi.fn(),
      commit: vi.fn(),
    };
    const handle = {
      flock,
      syncOnce: vi.fn(async () => undefined),
    };
    const manager = {
      syncDocOrThrow: vi.fn(async () => undefined),
      repo: {
        getMeta: () => ({
          scan: vi.fn(async () => [{ key: ['e', `task-${taskId}`], value: true }]),
        }),
        openFlockDoc: vi.fn(async () => handle),
        openPersistedDoc: vi.fn(async () => ({ doc })),
        flush: vi.fn(async () => undefined),
      },
    } as unknown as LoroDocumentManager;

    await expect(listWorkspaceTaskIds(manager, 'workspace-1' as WorkspaceId)).resolves.toEqual([
      taskId,
    ]);
    expect(flock.set).toHaveBeenCalledWith(
      ['task', taskId],
      expect.objectContaining({ taskId, title: 'Recovered task' })
    );
    expect(flock.commit).toHaveBeenCalledOnce();
  });
});
