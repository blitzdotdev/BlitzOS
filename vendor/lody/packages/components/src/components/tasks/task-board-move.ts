import { TASK_STATUS_VALUES, type TaskStatus } from '@lody/shared';

/** Droppable id for an empty column (or the column body itself). */
export const taskBoardColumnDropId = (status: TaskStatus): string => `column:${status}`;

export const parseTaskBoardColumnDropId = (id: string): TaskStatus | null => {
  if (!id.startsWith('column:')) return null;
  const status = id.slice('column:'.length) as TaskStatus;
  return (TASK_STATUS_VALUES as readonly string[]).includes(status) ? status : null;
};

/** Ordered task ids in each board column (manual order already applied). */
export type TaskBoardColumns = Readonly<Record<TaskStatus, readonly string[]>>;

export type TaskBoardMove = {
  taskId: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
  /** Neighbour above the card in the target column after the move; null = first. */
  beforeTaskId: string | null;
  /** Neighbour below the card in the target column after the move; null = last. */
  afterTaskId: string | null;
};

const emptyColumns = (): Record<TaskStatus, string[]> => {
  const out = {} as Record<TaskStatus, string[]>;
  for (const status of TASK_STATUS_VALUES) {
    out[status] = [];
  }
  return out;
};

const cloneColumns = (columns: TaskBoardColumns): Record<TaskStatus, string[]> => {
  const out = emptyColumns();
  for (const status of TASK_STATUS_VALUES) {
    out[status] = [...columns[status]];
  }
  return out;
};

/** Group task ids by status, preserving input order within each status. */
export function buildTaskBoardColumns(
  tasks: readonly { taskId: string; status: unknown }[]
): Record<TaskStatus, string[]> {
  const columns = emptyColumns();
  for (const task of tasks) {
    if (!(TASK_STATUS_VALUES as readonly unknown[]).includes(task.status)) {
      continue;
    }
    columns[task.status as TaskStatus].push(task.taskId);
  }
  return columns;
}

export function findTaskBoardColumn(
  columns: TaskBoardColumns,
  taskId: string
): { status: TaskStatus; index: number } | null {
  for (const status of TASK_STATUS_VALUES) {
    const index = columns[status].indexOf(taskId);
    if (index >= 0) return { status, index };
  }
  return null;
}

/**
 * Same-list reorder matching `@dnd-kit/sortable` `arrayMove`.
 * Indices are into the list *before* the move.
 */
export function arrayMoveIds(list: readonly string[], fromIndex: number, toIndex: number): string[] {
  if (fromIndex === toIndex) return [...list];
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(fromIndex, 1);
  if (item === undefined) return [...list];
  next.splice(Math.min(toIndex, next.length), 0, item);
  return next;
}

/**
 * Apply one drag-over step to a column layout (live preview + commit). Pure so
 * the UI can call it from onDragOver and again on onDragEnd without waiting on
 * React state to flush.
 *
 * Returns null when the layout would be unchanged (or the drop is invalid).
 *
 * `insertAfterOver`: when the pointer is over the lower half of a card, insert
 * after that card instead of before it.
 */
export function applyTaskBoardDragOver(input: {
  columns: TaskBoardColumns;
  activeId: string;
  overId: string;
  insertAfterOver?: boolean;
}): Record<TaskStatus, string[]> | null {
  const { columns, activeId, overId, insertAfterOver = false } = input;
  if (activeId === overId) return null;

  const from = findTaskBoardColumn(columns, activeId);
  if (!from) return null;

  const columnDrop = parseTaskBoardColumnDropId(overId);

  if (columnDrop) {
    const toStatus = columnDrop;
    if (from.status === toStatus) {
      // Dropping on the column body of the same column → append.
      const list = columns[toStatus];
      if (from.index === list.length - 1) return null;
      const next = cloneColumns(columns);
      next[toStatus] = arrayMoveIds(list, from.index, list.length - 1);
      return next;
    }
    const next = cloneColumns(columns);
    next[from.status] = next[from.status].filter((id) => id !== activeId);
    next[toStatus] = [...next[toStatus], activeId];
    return next;
  }

  const over = findTaskBoardColumn(columns, overId);
  if (!over) return null;

  if (from.status === over.status) {
    // Same column: arrayMove to the over index (optionally after, via lower half).
    let toIndex = over.index;
    if (insertAfterOver) {
      // arrayMove(from, to) with to > from places the item at `to` after removal
      // semantics; for "after this card" we want toIndex = over.index when
      // moving down, and over.index+1 when moving up — simplest: place at
      // post-remove position after the over card.
      const list = columns[from.status];
      const without = list.filter((id) => id !== activeId);
      let post = over.index;
      if (from.index < over.index) post -= 1;
      if (insertAfterOver) post += 1;
      post = Math.max(0, Math.min(post, without.length));
      const nextList = [...without.slice(0, post), activeId, ...without.slice(post)];
      if (nextList.every((id, i) => id === list[i])) return null;
      const next = cloneColumns(columns);
      next[from.status] = nextList;
      return next;
    }
    if (from.index === toIndex) return null;
    const nextList = arrayMoveIds(columns[from.status], from.index, toIndex);
    if (nextList.every((id, i) => id === columns[from.status][i])) return null;
    const next = cloneColumns(columns);
    next[from.status] = nextList;
    return next;
  }

  // Cross column: insert before over, or after when pointer is in the lower half.
  const next = cloneColumns(columns);
  next[from.status] = next[from.status].filter((id) => id !== activeId);
  const dest = next[over.status];
  let insertAt = over.index + (insertAfterOver ? 1 : 0);
  // over.index was in the destination *before* we only touched source; dest is
  // unchanged for a cross-column move, so over.index is still valid.
  insertAt = Math.max(0, Math.min(insertAt, dest.length));
  next[over.status] = [...dest.slice(0, insertAt), activeId, ...dest.slice(insertAt)];
  return next;
}

/** Alias used by older call sites/tests. */
export function previewTaskBoardColumns(input: {
  columns: TaskBoardColumns;
  activeId: string;
  overId: string;
}): Record<TaskStatus, string[]> | null {
  return applyTaskBoardDragOver(input);
}

/**
 * Resolve a drag-and-drop into a durable move (status + neighbours). Pure: no
 * writes, no order-key math — the container maps neighbours to fractional keys.
 *
 * `overId` is either a task id or `column:<status>`.
 */
export function resolveTaskBoardMove(input: {
  columns: TaskBoardColumns;
  activeId: string;
  overId: string;
  insertAfterOver?: boolean;
}): TaskBoardMove | null {
  const { columns, activeId } = input;
  const from = findTaskBoardColumn(columns, activeId);
  if (!from) return null;

  const next = applyTaskBoardDragOver(input);
  if (!next) return null;

  return resolveTaskBoardMoveFromPreview({
    startColumns: columns,
    previewColumns: next,
    taskId: activeId,
  });
}

/**
 * Build a move from a live preview layout (end of drag). Prefer this when the
 * board already rearranged columns during drag-over so commit matches what the
 * user saw.
 */
export function resolveTaskBoardMoveFromPreview(input: {
  startColumns: TaskBoardColumns;
  previewColumns: TaskBoardColumns;
  taskId: string;
}): TaskBoardMove | null {
  const { startColumns, previewColumns, taskId } = input;
  const from = findTaskBoardColumn(startColumns, taskId);
  const to = findTaskBoardColumn(previewColumns, taskId);
  if (!from || !to) return null;
  if (from.status === to.status && from.index === to.index) return null;

  const list = previewColumns[to.status];
  const placed = to.index;
  return {
    taskId,
    fromStatus: from.status,
    toStatus: to.status,
    beforeTaskId: placed > 0 ? (list[placed - 1] ?? null) : null,
    afterTaskId: placed < list.length - 1 ? (list[placed + 1] ?? null) : null,
  };
}
