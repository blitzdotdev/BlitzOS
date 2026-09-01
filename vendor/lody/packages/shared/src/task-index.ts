import { z } from 'zod';

import type { TaskId, WorkspaceId } from './ids';
import {
  normalizeTaskLabels,
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
  type TaskLink,
  type TaskPriority,
  type TaskStatus,
} from './task-types';

/**
 * The task index is one workspace-scoped Flock document holding a summary row
 * per task. Lists and boards read only this index, so opening a workspace never
 * has to load every task document.
 *
 * Rows are derived from the task documents, which stay authoritative. A row that
 * loses a race is corrected by the next write to that task, and reconciled when
 * the task document itself is opened.
 */
export const TASK_INDEX_FLOCK_STREAM_SEGMENT = 'ti';

export const getTaskIndexFlockDocId = (workspaceId: WorkspaceId): string =>
  `${workspaceId}:${TASK_INDEX_FLOCK_STREAM_SEGMENT}`;

export const isTaskIndexFlockDocId = (value: string): boolean => {
  const parts = value.split(':');
  return parts.length === 2 && parts[0] !== '' && parts[1] === TASK_INDEX_FLOCK_STREAM_SEGMENT;
};

export const TASK_INDEX_ROW_FAMILY = 'task';

export type TaskIndexRowKey = [typeof TASK_INDEX_ROW_FAMILY, TaskId];

export const taskIndexKeys = {
  task: (taskId: TaskId): TaskIndexRowKey => [TASK_INDEX_ROW_FAMILY, taskId],
};

export const getTaskIndexScanPrefix = (): string[] => [TASK_INDEX_ROW_FAMILY];

/**
 * List-rendering summary only. Anything a board card or list row does not draw
 * belongs in the task document, not here.
 */
export const TaskIndexRowSchema = z
  .object({
    taskId: z.string().trim().min(1),
    title: z.string(),
    status: z.enum(TASK_STATUS_VALUES as unknown as [TaskStatus, ...TaskStatus[]]),
    ownerId: z.string(),
    order: z.string().min(1),
    /** Absent means no priority (untriaged). Explicit levels including medium are stored. */
    priority: z
      .enum(TASK_PRIORITY_VALUES as unknown as [TaskPriority, ...TaskPriority[]])
      .optional(),
    /** Normalized lowercase labels; list/board rows draw these directly. */
    labels: z.array(z.string()).optional(),
    /** Presence of an entrusted agent, not the reference itself. */
    hasAgent: z.boolean().optional(),
    agentConfigId: z.string().optional(),
    /**
     * Enough to draw the project on a card without opening the document. Not a
     * display label: the row is written by both the app and the CLI, and a
     * baked-in string would drift between them. `github` rows carry
     * `owner/repo`, which is already the name; `local` rows carry the project
     * id and the client resolves it against its own project list.
     */
    projectKind: z.enum(['local', 'github']).optional(),
    projectKey: z.string().optional(),
    /** Whether required execution inputs are present, for the completeness hint. */
    ready: z.boolean().optional(),
    sessionCount: z.number().int().nonnegative().optional(),
    prCount: z.number().int().nonnegative().optional(),
    /** Newest comment in the thread, for unread comparison. */
    lastCommentAt: z.number().optional(),
    /**
     * Users mentioned by comments in the thread. A shared fact, not per-user
     * read state: who has read what stays device-local, because a task document
     * is shared and cannot hold one reader's position.
     */
    mentionedUserIds: z.array(z.string()).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    /** Tombstone: the task was deleted. Rows are kept so peers converge. */
    deletedAt: z.number().optional(),
  })
  .strip();

export type TaskIndexRow = z.infer<typeof TaskIndexRowSchema>;

export const parseTaskIndexRow = (value: unknown): TaskIndexRow | undefined => {
  const parsed = TaskIndexRowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const serializeTaskIndexKey = (key: TaskIndexRowKey): string => JSON.stringify(key);

export const parseTaskIndexKey = (key: readonly unknown[]): TaskId | undefined => {
  if (key.length !== 2) {
    return undefined;
  }
  if (key[0] !== TASK_INDEX_ROW_FAMILY) {
    return undefined;
  }
  const taskId = key[1];
  return typeof taskId === 'string' && taskId.length > 0 ? (taskId as TaskId) : undefined;
};

export type TaskIndexRowMap = Record<string, TaskIndexRow>;

export type TaskIndexScanRow = { key: readonly unknown[]; value?: unknown };

/**
 * Takes already-scanned rows rather than the Flock handle so the shared package
 * stays independent of the transport's scan signature.
 */
export const readTaskIndexRows = (
  scanned: Iterable<TaskIndexScanRow>
): TaskIndexRowMap => {
  const rows: TaskIndexRowMap = {};
  for (const row of scanned) {
    const taskId = parseTaskIndexKey(row.key);
    if (!taskId) {
      continue;
    }
    const parsed = parseTaskIndexRow(row.value);
    if (!parsed || parsed.taskId !== taskId) {
      continue;
    }
    rows[taskId] = parsed;
  }
  return rows;
};

export type TaskIndexFlockEvent = { key: readonly unknown[]; value?: unknown };

/**
 * Fold live Flock events into a row map. An event without a value, or one that
 * fails validation, removes the row: a row we cannot read is worse than absent.
 */
export const applyTaskIndexRowEvents = (
  previous: TaskIndexRowMap,
  events: readonly TaskIndexFlockEvent[]
): TaskIndexRowMap => {
  let next: TaskIndexRowMap | null = null;
  const ensureCopy = (): TaskIndexRowMap => {
    if (!next) {
      next = { ...previous };
    }
    return next;
  };

  // Removal must consult the rows written EARLIER IN THIS SAME BATCH, not just
  // `previous`. A reconnect catch-up delivers many events at once, so an
  // add-then-remove pair would otherwise leave the removed task on screen, and a
  // later unreadable row would fail to supersede an earlier good one.
  const current = (taskId: string): TaskIndexRow | undefined => (next ?? previous)[taskId];

  for (const event of events) {
    const taskId = parseTaskIndexKey(event.key);
    if (!taskId) {
      continue;
    }
    if (event.value === undefined) {
      if (current(taskId) !== undefined) {
        delete ensureCopy()[taskId];
      }
      continue;
    }
    const parsed = parseTaskIndexRow(event.value);
    if (!parsed || parsed.taskId !== taskId) {
      if (current(taskId) !== undefined) {
        delete ensureCopy()[taskId];
      }
      continue;
    }
    ensureCopy()[taskId] = parsed;
  }

  return next ?? previous;
};

/** Rows a user should see in the list: parseable and not tombstoned. */
export const listVisibleTaskIndexRows = (rows: TaskIndexRowMap): TaskIndexRow[] =>
  Object.values(rows).filter((row) => row.deletedAt === undefined);

export type TaskIndexRowSource = {
  taskId: TaskId;
  title: string;
  status: TaskStatus;
  ownerId: string;
  order: string;
  priority?: TaskPriority | undefined;
  labels?: readonly string[] | undefined;
  agent?: { agentConfigId: string } | undefined;
  projects?: readonly unknown[] | undefined;
  createdAt: number;
  updatedAt: number;
};

/**
 * Counts the links an index row reports. Shared for the same reason
 * `buildTaskIndexRow` is: the row is a fact both the app and the CLI write, so
 * two copies of this rule could make the same task count differently depending
 * on which side last touched it.
 */
export const countTaskLinks = (
  links: readonly TaskLink[]
): { sessionCount: number; prCount: number } => {
  let sessionCount = 0;
  let prCount = 0;
  for (const link of links) {
    if (link.removedAt !== undefined) {
      continue;
    }
    if (link.kind === 'session') {
      sessionCount += 1;
    } else if (link.kind === 'pr') {
      prCount += 1;
    }
  }
  return { sessionCount, prCount };
};

/**
 * First project only: a card draws one, and carrying the rest would grow every
 * row for something nothing renders. Shape-checked rather than cast — the field
 * is `unknown[]` on the source because the index layer does not depend on the
 * ProjectRef union.
 */
const summarizeTaskProject = (
  projects: readonly unknown[] | undefined
): { projectKind?: 'local' | 'github'; projectKey?: string } => {
  const first = projects?.[0] as { kind?: string; repoFullName?: string; localProjectId?: string };
  if (!first) return {};
  if (first.kind === 'github' && first.repoFullName) {
    return { projectKind: 'github', projectKey: first.repoFullName };
  }
  if (first.kind === 'local' && first.localProjectId) {
    return { projectKind: 'local', projectKey: first.localProjectId };
  }
  return {};
};

/**
 * Derives the index row from a task document's own state. Both the app and the
 * CLI go through this so a row written by either side means the same thing.
 */
export const buildTaskIndexRow = (
  source: TaskIndexRowSource,
  counts: { sessionCount: number; prCount: number },
  mentions: { lastCommentAt?: number; mentionedUserIds?: string[] } = {}
): TaskIndexRow => ({
  taskId: source.taskId,
  title: source.title,
  status: source.status,
  ownerId: source.ownerId,
  order: source.order,
  // Omit when unset so untriaged rows stay compact; every explicit level
  // (including medium) is stored so "no priority" and "medium" stay distinct.
  ...(source.priority ? { priority: source.priority } : {}),
  ...(source.labels && source.labels.length > 0
    ? { labels: normalizeTaskLabels(source.labels) }
    : {}),
  hasAgent: Boolean(source.agent),
  ...(source.agent ? { agentConfigId: source.agent.agentConfigId } : {}),
  ...summarizeTaskProject(source.projects),
  // Readiness is what the completeness hint on a card needs, without the card
  // having to know what execution requires.
  // "Ready GIVEN it has an agent": a task nobody entrusted reports true here,
  // because completeness is only meaningful once an agent is set. Never read this
  // alone — every consumer checks `agentConfigId` first.
  ready: source.agent ? (source.projects?.length ?? 0) > 0 : true,
  sessionCount: counts.sessionCount,
  prCount: counts.prCount,
  ...(mentions.lastCommentAt !== undefined ? { lastCommentAt: mentions.lastCommentAt } : {}),
  ...(mentions.mentionedUserIds && mentions.mentionedUserIds.length > 0
    ? { mentionedUserIds: mentions.mentionedUserIds }
    : {}),
  createdAt: source.createdAt,
  updatedAt: source.updatedAt,
});

/**
 * Queue position per task for display: "this is the Nth thing its agent will do".
 *
 * Derived from the rows the list already has, so nothing extra is stored or
 * synced. The machine-side scheduler owns the decision to *start* work; this is
 * only the same ordering rule rendered where the user can see it, which is why
 * a disagreement between them is cosmetic rather than a correctness bug.
 *
 * Position 1 means next up. A task whose agent is already busy starts at 1
 * behind that work.
 */
export const computeTaskQueuePositions = (
  rows: readonly TaskIndexRow[]
): Map<string, number> => {
  const backlogByAgent = new Map<string, TaskIndexRow[]>();
  const busyAgents = new Set<string>();

  for (const row of rows) {
    const agentConfigId = row.agentConfigId;
    if (!agentConfigId || row.deletedAt !== undefined) {
      continue;
    }
    if (row.status === 'in_progress') {
      busyAgents.add(agentConfigId);
      continue;
    }
    // Only work that could actually be picked up queues; an incomplete task is
    // waiting on the user, not on its turn. `backlog` and `todo` are both
    // "not started" and both automation-eligible (see
    // `isTaskAutomationEligible`) — this must stay in lockstep with that
    // predicate, or the displayed queue position stops matching what the
    // scheduler will actually start.
    if ((row.status !== 'backlog' && row.status !== 'todo') || row.ready === false) {
      continue;
    }
    const bucket = backlogByAgent.get(agentConfigId);
    if (bucket) {
      bucket.push(row);
    } else {
      backlogByAgent.set(agentConfigId, [row]);
    }
  }

  const positions = new Map<string, number>();
  for (const [agentConfigId, bucket] of backlogByAgent) {
    const ordered = [...bucket].sort((a, b) =>
      a.order === b.order ? a.taskId.localeCompare(b.taskId) : a.order < b.order ? -1 : 1
    );
    const offset = busyAgents.has(agentConfigId) ? 1 : 0;
    ordered.forEach((row, index) => {
      const position = index + offset;
      // The head of an idle agent's queue is not "queued" — it is about to run.
      if (position > 0) {
        positions.set(row.taskId, position);
      }
    });
  }
  return positions;
};
