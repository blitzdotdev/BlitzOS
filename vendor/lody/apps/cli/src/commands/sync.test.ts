import { describe, expect, it, vi } from 'vitest';
import type { TaskId } from '@lody/shared';
import { buildSyncDocIds, createWorkspaceSummary, mergeSummaries, syncItems } from './sync';

describe('buildSyncDocIds', () => {
  it('unions task rooms from repo existence and the Task Index', () => {
    const docIds = buildSyncDocIds(['session-1', 'machine-1'], ['t1', 't2'] as TaskId[]);

    expect(docIds).toContain('task-t1');
    expect(docIds).toContain('task-t2');
    expect(docIds).toContain('session-1');
  });

  it('returns a stable order', () => {
    expect(buildSyncDocIds(['session-b', 'session-a'], ['t1'] as TaskId[])).toEqual([
      'session-a',
      'session-b',
      'task-t1',
    ]);
  });

  it('does not sync a task twice when both enumerations contain it', () => {
    expect(buildSyncDocIds(['task-t1', 'session-1'], ['t1'] as TaskId[])).toEqual([
      'session-1',
      'task-t1',
    ]);
  });
});

describe('sync command helpers', () => {
  it('continues syncing remaining items after one item fails', async () => {
    const summary = createWorkspaceSummary('workspace-1');
    const syncOne = vi.fn(async (id: string) => {
      if (id === 'doc-2') {
        throw new Error('network unavailable');
      }
    });

    await syncItems({
      summary,
      kind: 'doc',
      ids: ['doc-1', 'doc-2', 'doc-3'],
      concurrency: 2,
      outputMode: 'json',
      syncOne,
    });

    expect(syncOne).toHaveBeenCalledTimes(3);
    expect(summary.totals.doc).toBe(3);
    expect(summary.completed.doc).toBe(2);
    expect(summary.failed.doc).toBe(1);
    expect(summary.failures).toEqual([
      {
        workspaceId: 'workspace-1',
        kind: 'doc',
        id: 'doc-2',
        error: 'network unavailable',
      },
    ]);
  });

  it('merges workspace summaries into final exit summary counters', async () => {
    const first = createWorkspaceSummary('workspace-1');
    first.totals.meta = 1;
    first.completed.meta = 1;

    const second = createWorkspaceSummary('workspace-2');
    second.totals.meta = 1;
    second.failed.meta = 1;
    second.failures.push({
      workspaceId: 'workspace-2',
      kind: 'meta',
      id: 'meta',
      error: 'timeout',
    });

    expect(mergeSummaries([first, second])).toMatchObject({
      ok: false,
      total: 2,
      completed: 1,
      failed: 1,
      failures: [
        {
          workspaceId: 'workspace-2',
          kind: 'meta',
          id: 'meta',
          error: 'timeout',
        },
      ],
    });
  });
});
