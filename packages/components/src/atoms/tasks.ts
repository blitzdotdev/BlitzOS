import { atom } from 'jotai';
import { atomFamily, atomWithStorage } from 'jotai/utils';
import {
  compareTaskOrder,
  hasUnreadTaskMention,
  listVisibleTaskIndexRows,
  TASK_STATUS_VALUES,
  type TaskId,
  type TaskIndexRow,
  type TaskIndexRowMap,
  type TaskStatus,
} from '@lody/shared';
// `atoms/index.ts` does not re-export this module, so this direction is not a
// cycle; consumers import `@/atoms/tasks` directly.
import { userAtom } from '@/atoms';

/**
 * Rows read from the workspace task index Flock document. The index is the only
 * thing list and board views read, so opening the Tasks page never loads task
 * documents.
 */
export const taskIndexRowsAtom = atom<TaskIndexRowMap>({});

export const taskIndexReadyAtom = atom(false);

export const clearTaskIndexAtom = atom(null, (_get, set) => {
  set(taskIndexRowsAtom, {});
  set(taskIndexReadyAtom, false);
});

/**
 * All non-deleted tasks in manual order.
 *
 * No hand-rolled identity cache here. A previous version kept the last result in
 * a module-level variable and reused it when five chosen fields matched, which
 * (a) was shared across every jotai store in the process and (b) silently
 * swallowed changes to the fields it did not compare — a new comment moves
 * `lastCommentAt` and `mentionedUserIds`, so the unread badge would never appear.
 * It was also unnecessary: `applyTaskIndexRowEvents` returns the *same* map object
 * when a batch changes nothing, so this atom does not recompute in that case.
 */
export const taskListAtom = atom((get) =>
  listVisibleTaskIndexRows(get(taskIndexRowsAtom)).sort((a, b) =>
    compareTaskOrder({ order: a.order, id: a.taskId }, { order: b.order, id: b.taskId })
  )
);

export type TaskStatusGroup = { status: TaskStatus; tasks: TaskIndexRow[] };

/** Tasks grouped by status, in board-column order. Empty groups are kept so the board keeps its columns. */
export const taskGroupsAtom = atom<TaskStatusGroup[]>((get) => {
  const tasks = get(taskListAtom);
  return TASK_STATUS_VALUES.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
  }));
});

export const taskIndexRowAtomFamily = atomFamily((taskId: TaskId) =>
  atom((get) => get(taskIndexRowsAtom)[taskId])
);

/**
 * A task entrusted to an agent but missing execution inputs cannot run. The card
 * shows a warning rather than hiding the task, so the fix is one click away.
 * Tasks with no agent are never automated, so completeness is not asserted.
 */
export const taskNeedsSetupAtomFamily = atomFamily((taskId: TaskId) =>
  atom((get) => {
    const row = get(taskIndexRowsAtom)[taskId];
    return Boolean(row?.hasAgent) && row?.status === 'backlog' && row?.ready === false;
  })
);

/**
 * When this device last opened each task's thread.
 *
 * Read position is per-person, and a task document is shared, so it cannot live
 * there. Device-local is the honest scope: an unseen mention on a device you have
 * not opened the task on is correct, not a bug.
 */
export const taskThreadReadAtAtom = atomWithStorage<Record<string, number>>(
  'lody-task-thread-read',
  {}
);

/** Quick-add modal visibility. Opened from the command palette, a shortcut, and the Tasks page. */
export const taskQuickAddOpenAtom = atom(false);

/**
 * Column the quick-add dialog should start in, set by the board's per-column
 * add buttons. Null means "opened from somewhere without a column" (the command
 * palette, the shortcut), which starts in backlog.
 */
export const taskQuickAddStatusAtom = atom<TaskStatus | null>(null);

/** Sticky across consecutive creations so "Create More" keeps the modal open. */
export const taskQuickAddCreateMoreAtom = atom(false);

/**
 * The inbox: tasks where someone `@`-mentioned you in a comment you have not
 * read, newest first.
 *
 * Purely derived from the index and the local read position — no new storage,
 * no query, nothing synced. That is the whole reason this can exist as a small
 * feature: `mentionedUserIds` and `lastCommentAt` are already published on every
 * index row because the card badge needs them, so an inbox is a filter over data
 * the page has already loaded.
 *
 * Scope is deliberately narrow: only mentions. "Assigned to me" and "blocked on
 * me" are already answered by the board and the needs-you filter, and folding
 * them in here would turn a list you can clear into another view of everything.
 */
export const taskInboxAtom = atom((get) => {
  const userId = get(userAtom)?.id;
  if (!userId) return [];
  const readAt = get(taskThreadReadAtAtom);
  return get(taskListAtom)
    .filter((task) => hasUnreadTaskMention(task, userId, readAt[task.taskId]))
    .sort((a, b) => (b.lastCommentAt ?? 0) - (a.lastCommentAt ?? 0));
});

/** Badge count for the inbox entry. */
export const taskInboxCountAtom = atom((get) => get(taskInboxAtom).length);

/**
 * Task detail tabs currently open in the desktop Tasks workspace, in display
 * order. "All Tasks" is not in this list — it is the pinned home tab.
 *
 * Session-scoped (not localStorage): reopening the app starts from the list,
 * which matches how people use Tasks as a capture/triage surface rather than
 * a multi-document editor they resume mid-edit. Workspace switches clear it
 * below so one workspace's tabs never paint over another.
 */
export const openTaskTabsAtom = atom<TaskId[]>([]);

/** Open a task tab if it is not already open; moves it to the end when reopened. */
export const openTaskTabAtom = atom(null, (get, set, taskId: TaskId) => {
  const current = get(openTaskTabsAtom);
  if (current.includes(taskId)) {
    return;
  }
  set(openTaskTabsAtom, [...current, taskId]);
});

/** Close a task tab. No-op if it was not open. */
export const closeTaskTabAtom = atom(null, (get, set, taskId: TaskId) => {
  const current = get(openTaskTabsAtom);
  if (!current.includes(taskId)) {
    return;
  }
  set(
    openTaskTabsAtom,
    current.filter((id) => id !== taskId)
  );
});

/** Drop every open task tab (workspace switch / feature gate off). */
export const clearOpenTaskTabsAtom = atom(null, (_get, set) => {
  set(openTaskTabsAtom, []);
});

/** Properties a card/row can display beyond its title. */
export type TaskCardProperty = 'priority' | 'labels' | 'project' | 'agent';

export const TASK_CARD_PROPERTIES: readonly TaskCardProperty[] = [
  'priority',
  'labels',
  'project',
  'agent',
];

/**
 * Which properties each view draws, per device.
 *
 * The two views get different defaults on purpose. A board card is a box with
 * room under the title, so it can carry more without changing shape. A list row
 * is one fixed-height line whose value is a scannable column of titles — every
 * extra chip eats into the title before it eats into whitespace, so list starts
 * deliberately sparse and the user opts in.
 */
export type TaskVisibleProperties = Record<'board' | 'list', TaskCardProperty[]>;

export const DEFAULT_TASK_VISIBLE_PROPERTIES: TaskVisibleProperties = {
  board: ['priority', 'labels', 'project', 'agent'],
  list: ['priority', 'labels'],
};

export const taskVisiblePropertiesAtom = atomWithStorage<TaskVisibleProperties>(
  'lody-tasks-visible-properties',
  DEFAULT_TASK_VISIBLE_PROPERTIES
);
