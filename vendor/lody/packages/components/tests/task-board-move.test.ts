import { describe, expect, it } from 'vitest';
import {
  applyTaskBoardDragOver,
  buildTaskBoardColumns,
  parseTaskBoardColumnDropId,
  previewTaskBoardColumns,
  resolveTaskBoardMove,
  resolveTaskBoardMoveFromPreview,
  taskBoardColumnDropId,
} from '../src/components/tasks/task-board-move';

const cols = (map: Partial<Record<'backlog' | 'todo' | 'in_progress' | 'done', string[]>>) => {
  const tasks = Object.entries(map).flatMap(([status, ids]) =>
    (ids ?? []).map((taskId) => ({
      taskId,
      status: status as 'backlog' | 'todo' | 'in_progress' | 'done',
    }))
  );
  return buildTaskBoardColumns(tasks);
};

describe('taskBoardColumnDropId', () => {
  it('round-trips status through the column droppable id', () => {
    expect(parseTaskBoardColumnDropId(taskBoardColumnDropId('todo'))).toBe('todo');
    expect(parseTaskBoardColumnDropId('not-a-column')).toBeNull();
    expect(parseTaskBoardColumnDropId('column:nope')).toBeNull();
  });
});

describe('buildTaskBoardColumns', () => {
  it('keeps the board usable when a runtime row has an unsupported status', () => {
    const columns = buildTaskBoardColumns([
      { taskId: 'valid', status: 'todo' },
      { taskId: 'future', status: 'blocked' },
      { taskId: 'missing', status: undefined },
    ]);

    expect(columns.todo).toEqual(['valid']);
    expect(Object.values(columns).flat()).toEqual(['valid']);
  });
});

describe('resolveTaskBoardMove', () => {
  it('returns null when active and over are the same card', () => {
    const columns = cols({ backlog: ['a', 'b'] });
    expect(resolveTaskBoardMove({ columns, activeId: 'a', overId: 'a' })).toBeNull();
  });

  it('reorders within a column like arrayMove (later onto earlier)', () => {
    const columns = cols({ backlog: ['a', 'b', 'c'] });
    // arrayMove([a,b,c], 2, 0) → [c,a,b]
    expect(resolveTaskBoardMove({ columns, activeId: 'c', overId: 'a' })).toEqual({
      taskId: 'c',
      fromStatus: 'backlog',
      toStatus: 'backlog',
      beforeTaskId: null,
      afterTaskId: 'a',
    });
  });

  it('reorders within a column like arrayMove (earlier onto later)', () => {
    const columns = cols({ backlog: ['a', 'b', 'c'] });
    // arrayMove([a,b,c], 0, 2) → [b,c,a]
    expect(resolveTaskBoardMove({ columns, activeId: 'a', overId: 'c' })).toEqual({
      taskId: 'a',
      fromStatus: 'backlog',
      toStatus: 'backlog',
      beforeTaskId: 'c',
      afterTaskId: null,
    });
  });

  it('moves a card one slot down when dropped on the next neighbour', () => {
    const columns = cols({ backlog: ['a', 'b', 'c'] });
    // arrayMove([a,b,c], 0, 1) → [b,a,c]
    expect(resolveTaskBoardMove({ columns, activeId: 'a', overId: 'b' })).toEqual({
      taskId: 'a',
      fromStatus: 'backlog',
      toStatus: 'backlog',
      beforeTaskId: 'b',
      afterTaskId: 'c',
    });
  });

  it('returns null when the drop leaves the card at the same index', () => {
    // Drop b onto itself already null; drop onto column end of same single-item is no-op.
    expect(
      resolveTaskBoardMove({
        columns: cols({ backlog: ['a'] }),
        activeId: 'a',
        overId: taskBoardColumnDropId('backlog'),
      })
    ).toBeNull();
  });

  it('moves across columns onto a card (insert at over index)', () => {
    const columns = cols({ backlog: ['a', 'b'], todo: ['x', 'y'] });
    expect(resolveTaskBoardMove({ columns, activeId: 'a', overId: 'y' })).toEqual({
      taskId: 'a',
      fromStatus: 'backlog',
      toStatus: 'todo',
      beforeTaskId: 'x',
      afterTaskId: 'y',
    });
  });

  it('moves across columns onto an empty column droppable', () => {
    const columns = cols({ backlog: ['a'], done: [] });
    expect(
      resolveTaskBoardMove({
        columns,
        activeId: 'a',
        overId: taskBoardColumnDropId('done'),
      })
    ).toEqual({
      taskId: 'a',
      fromStatus: 'backlog',
      toStatus: 'done',
      beforeTaskId: null,
      afterTaskId: null,
    });
  });

  it('appends when dropping on a non-empty column body', () => {
    const columns = cols({ backlog: ['a'], todo: ['x'] });
    expect(
      resolveTaskBoardMove({
        columns,
        activeId: 'a',
        overId: taskBoardColumnDropId('todo'),
      })
    ).toEqual({
      taskId: 'a',
      fromStatus: 'backlog',
      toStatus: 'todo',
      beforeTaskId: 'x',
      afterTaskId: null,
    });
  });

  it('returns null for unknown active or over ids', () => {
    const columns = cols({ backlog: ['a'] });
    expect(
      resolveTaskBoardMove({ columns, activeId: 'missing', overId: 'a' })
    ).toBeNull();
    expect(
      resolveTaskBoardMove({ columns, activeId: 'a', overId: 'missing' })
    ).toBeNull();
  });
});

describe('previewTaskBoardColumns', () => {
  it('moves the active id into the over column for live preview', () => {
    const columns = cols({ backlog: ['a', 'b'], todo: ['x'] });
    expect(
      previewTaskBoardColumns({ columns, activeId: 'a', overId: 'x' })
    ).toEqual({
      ...cols({}),
      backlog: ['b'],
      todo: ['a', 'x'],
    });
  });

  it('inserts after the over card when insertAfterOver is set (cross-column)', () => {
    const columns = cols({ backlog: ['a'], todo: ['x', 'y', 'z'] });
    // Drop a on y's lower half → between y and z.
    expect(
      applyTaskBoardDragOver({
        columns,
        activeId: 'a',
        overId: 'y',
        insertAfterOver: true,
      })
    ).toEqual({
      ...cols({}),
      backlog: [],
      todo: ['x', 'y', 'a', 'z'],
    });
  });

  it('inserts before the over card by default (cross-column mid-list)', () => {
    const columns = cols({ backlog: ['a'], todo: ['x', 'y', 'z'] });
    expect(
      applyTaskBoardDragOver({
        columns,
        activeId: 'a',
        overId: 'y',
        insertAfterOver: false,
      })
    ).toEqual({
      ...cols({}),
      backlog: [],
      todo: ['x', 'a', 'y', 'z'],
    });
  });
});

describe('resolveTaskBoardMoveFromPreview', () => {
  it('reads neighbours from the preview layout the user already saw', () => {
    const start = cols({ backlog: ['a', 'b'], todo: ['x'] });
    const preview = cols({ backlog: ['b'], todo: ['x', 'a'] });
    expect(
      resolveTaskBoardMoveFromPreview({
        startColumns: start,
        previewColumns: preview,
        taskId: 'a',
      })
    ).toEqual({
      taskId: 'a',
      fromStatus: 'backlog',
      toStatus: 'todo',
      beforeTaskId: 'x',
      afterTaskId: null,
    });
  });
});
