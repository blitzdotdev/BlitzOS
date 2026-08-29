import type { AgentConfigId, SessionId, TaskId, WorkspaceId } from './ids';
import type { ProjectRef } from './project';

export const TASK_DOC_PREFIX = 'task-';
export const LORO_TASK_STREAM_SEGMENT = 'tk';

export const getTaskRoomId = (taskId: TaskId): string => `${TASK_DOC_PREFIX}${taskId}`;

export const isTaskDocRoomId = (roomId: string): boolean => roomId.startsWith(TASK_DOC_PREFIX);

export const getTaskIdFromRoomId = (roomId: string): TaskId | null =>
  isTaskDocRoomId(roomId) ? (roomId.slice(TASK_DOC_PREFIX.length) as TaskId) : null;

export const getLoroTaskStreamId = (workspaceId: WorkspaceId, taskId: TaskId): string =>
  `${workspaceId}:${LORO_TASK_STREAM_SEGMENT}:${taskId}`;

/**
 * Task status is a declarative field: it states which stage the work is in.
 * Live execution facts (running / waiting / PR state) are never stored here;
 * they are read from the linked sessions and pull requests themselves.
 */
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'needs_review' | 'done' | 'canceled';

/**
 * Board column order, fixed to match the lifecycle. `backlog` and `todo` are
 * both "not started" — the split is purely a triage refinement (untriaged vs.
 * queued-up-next) — so delegated automation and the queue-position display
 * treat them identically; see `isTaskAutomationEligible` and
 * `computeTaskQueuePositions`. Adding a status here requires updating BOTH of
 * those, or a "not started" task silently stops being eligible for pickup.
 */
export const TASK_STATUS_VALUES: readonly TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'needs_review',
  'done',
  'canceled',
];

/**
 * Reference to the agent entrusted with executing a task. It intentionally does
 * not carry a machine id: the executing machine is resolved through the agent
 * config, so a task follows its agent when the agent moves.
 */
export type TaskAgentRef = {
  agentConfigId: AgentConfigId;
  modeId?: string;
  modelId?: string;
  configOptionValues?: Record<string, string>;
};

/**
 * Four levels, ordered most to least urgent. Deliberately NOT optional-with-a-
 * numeric-scale: a free number invites drift between what people mean by "3",
 * and a fixed short ladder is what makes a priority column scannable.
 *
 * Absent / cleared means **no priority** (untriaged). Quick capture leaves it
 * unset so capture stays zero-required-fields; the user assigns a level later.
 */
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

/** Display/sort order, most urgent first. */
export const TASK_PRIORITY_VALUES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];

/**
 * Labels are free-form strings; these three are only the seeded suggestions the
 * picker offers, not a closed set. Keeping them open avoids a migration every
 * time a team wants one more category, and the picker still makes the common
 * three one click away.
 */
export const TASK_SUGGESTED_LABELS: readonly string[] = ['bug', 'feature', 'document'];

export const TASK_LABEL_MAX_LENGTH = 32;
export const TASK_LABEL_MAX_COUNT = 10;

/**
 * Labels are compared and stored lowercase-trimmed so "Bug" and "bug" are one
 * label; a per-writer casing difference would otherwise split a filter in two.
 */
export const normalizeTaskLabel = (raw: string): string =>
  raw.trim().toLowerCase().slice(0, TASK_LABEL_MAX_LENGTH);

export const normalizeTaskLabels = (raw: readonly string[] | undefined): string[] => {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const value of raw) {
    const label = normalizeTaskLabel(value);
    if (label) seen.add(label);
    if (seen.size >= TASK_LABEL_MAX_COUNT) break;
  }
  return [...seen];
};

export type TaskActorKind = 'human' | 'agent';

export type TaskLinkKind = 'session' | 'pr';

export type TaskSessionLinkOrigin = 'run' | 'agent-spawn' | 'manual-attach' | 'propose-source';

export type TaskPrProvider = 'github' | 'gitlab';

/**
 * Associations are append-only records carrying provenance. Detaching writes a
 * tombstone (`removedAt`) so the history of what was linked is never lost.
 */
export type TaskLink = {
  id: string;
  kind: TaskLinkKind;
  actorKind: TaskActorKind;
  actorId?: string;
  actorName?: string;
  linkedAt: number;
  removedAt?: number;
  /** kind === 'session' */
  sessionId?: SessionId;
  origin?: TaskSessionLinkOrigin;
  parentSessionId?: SessionId;
  /** kind === 'pr' */
  provider?: TaskPrProvider;
  url?: string;
  originSessionId?: SessionId;
};

export type TaskTimelineEntryKind = 'comment' | 'activity';

export type TaskActivityType =
  | 'created'
  | 'status_changed'
  | 'title_changed'
  | 'owner_changed'
  | 'priority_changed'
  | 'labels_changed'
  | 'projects_changed'
  | 'agent_changed'
  | 'session_linked'
  | 'pr_linked'
  | 'body_edited';

export type TaskTimelineEntry = {
  id: string;
  kind: TaskTimelineEntryKind;
  actorKind: TaskActorKind;
  actorId?: string;
  actorName?: string;
  createdAt: number;
  /** Markdown body for comments; empty for activity entries. */
  body?: string;
  /** Mentioned user ids. */
  mentions?: string[];
  /** Mentioned agent config ids; a mention here is what makes a comment dispatch. */
  agentMentions?: string[];
  /** Set when the comment was dispatched into a session as a prompt. */
  dispatchedSessionId?: SessionId;
  /** Session an agent-authored entry came from. */
  originSessionId?: SessionId;
  /** Quoted body fragment for quote comments. */
  quote?: string;
  /**
   * Reserved for anchored comments (stable position in the body). Never written
   * in v1; quote comments carry their fragment in `quote` instead.
   */
  anchor?: string;
  /** kind === 'activity' */
  activityType?: TaskActivityType;
  /** Compact activity payload, e.g. `{ from, to }` for a status change. */
  activityData?: Record<string, string>;
};

/**
 * The scalar `meta` map inside a task document — the authoritative record of a
 * task. Task rooms deliberately carry NO repo doc metadata (see
 * `specs/tasks.md`), so this is not a doc-meta shape: list and board rendering
 * read `TaskIndexRow` instead, which is what keeps them from opening documents.
 */
export type TaskDocMeta = {
  taskId: TaskId;
  title: string;
  status: TaskStatus;
  /**
   * Accountable human owner and notification target. Empty string means
   * unassigned — not an agent id. Automation only runs tasks owned by the
   * local operator, so unassigned tasks never auto-run.
   */
  ownerId: string;
  /** Fractional index used for manual ordering (and queue order once automated). */
  order: string;
  /** Absent means no priority (untriaged). */
  priority?: TaskPriority;
  /** Normalized lowercase labels; absent and empty mean the same thing. */
  labels?: string[];
  /** Absent means this task is never automated. */
  agent?: TaskAgentRef;
  projects?: ProjectRef[];
  /** Agent selection of the most recent manual Run, used to prefill re-runs. */
  lastRunConfig?: TaskAgentRef;
  createdAt: number;
  updatedAt: number;
  createdBy?: string;
};

export type TaskDraftInput = {
  title?: string;
  body?: string;
};

export const TASK_TITLE_FALLBACK_MAX_LENGTH = 80;

/**
 * A task may be created from a title, a body, or both. An empty title falls
 * back to the first meaningful line of the body so quick capture never forces
 * the user to name things.
 */
export const deriveTaskTitle = (input: TaskDraftInput): string => {
  const explicit = (input.title ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (explicit) {
    return explicit;
  }
  const firstLine = (input.body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return '';
  }
  if (firstLine.length <= TASK_TITLE_FALLBACK_MAX_LENGTH) {
    return firstLine;
  }
  return `${firstLine.slice(0, TASK_TITLE_FALLBACK_MAX_LENGTH).trimEnd()}…`;
};

/** Creating with nothing typed is a no-op rather than an empty task. */
export const isEmptyTaskDraft = (input: TaskDraftInput): boolean =>
  (input.title ?? '').trim().length === 0 && (input.body ?? '').trim().length === 0;

export const getActiveTaskLinks = (links: readonly TaskLink[]): TaskLink[] =>
  links.filter((link) => link.removedAt === undefined);

export const getActiveTaskSessionLinks = (links: readonly TaskLink[]): TaskLink[] =>
  getActiveTaskLinks(links).filter((link) => link.kind === 'session' && Boolean(link.sessionId));

export const getActiveTaskPrLinks = (links: readonly TaskLink[]): TaskLink[] =>
  getActiveTaskLinks(links).filter((link) => link.kind === 'pr' && Boolean(link.url));

export const getTaskLinkedSessionIds = (links: readonly TaskLink[]): SessionId[] => {
  const seen = new Set<string>();
  const result: SessionId[] = [];
  for (const link of getActiveTaskSessionLinks(links)) {
    const sessionId = link.sessionId;
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    result.push(sessionId);
  }
  return result;
};

/** Required execution inputs. A task missing these cannot be dispatched. */
export type TaskMissingExecutionField = 'projects' | 'agent';

export const getMissingTaskExecutionFields = (
  meta: Pick<TaskDocMeta, 'agent' | 'projects'>
): TaskMissingExecutionField[] => {
  const missing: TaskMissingExecutionField[] = [];
  if (!meta.agent) {
    missing.push('agent');
  }
  if (!meta.projects || meta.projects.length === 0) {
    missing.push('projects');
  }
  return missing;
};

export type TaskPrState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';

export const isTerminalTaskPrState = (state: TaskPrState): boolean =>
  state === 'merged' || state === 'closed';

/**
 * Completion follows the pull requests once a task links any. Unknown states
 * never count toward completion: it is better to wait than to claim a task is
 * done on stale data.
 *
 * A single merge wins over any number of closures — work that shipped is done
 * even if earlier attempts were abandoned. Only when EVERY linked pull request
 * was closed unmerged does the task read as `canceled`: nothing shipped, and
 * the person closing the last pull request is making that call explicitly.
 */
export const resolveTaskPrFollowStatus = (
  states: readonly TaskPrState[]
): 'done' | 'canceled' | null => {
  if (states.length === 0) {
    return null;
  }
  if (!states.every((state) => isTerminalTaskPrState(state))) {
    return null;
  }
  return states.includes('merged') ? 'done' : 'canceled';
};

/**
 * Without pull requests to follow, a task reaches review once every linked
 * session is terminal.
 *
 * "Terminal" is the caller's judgement and per `specs/tasks.md` means ARCHIVED,
 * or all of that session's pull requests merged/closed. It deliberately does NOT
 * mean `idle`: a session is idle between every turn, so treating that as finished
 * would push tasks to review while the person is still mid-conversation.
 *
 * This is an attention prompt, so callers must only apply it to transitions they
 * observed live, never retroactively.
 */
export const shouldEnterTaskNeedsReview = (input: {
  status: TaskStatus;
  sessionTerminalStates: readonly boolean[];
  hasPrLinks: boolean;
}): boolean => {
  if (input.hasPrLinks) {
    return false;
  }
  if (input.status !== 'in_progress') {
    return false;
  }
  if (input.sessionTerminalStates.length === 0) {
    return false;
  }
  return input.sessionTerminalStates.every(Boolean);
};

export type TaskMentionSummary = {
  lastCommentAt?: number;
  mentionedUserIds?: string[];
};

/**
 * Condenses a thread into the two facts a list needs to show "someone mentioned
 * you": when the newest comment landed, and who comments mention.
 *
 * Both are shared facts, so they belong in the index. The reader's own position
 * is kept per-device instead, since one shared row cannot say "unread" for
 * several people at once.
 */
export const summarizeTaskMentions = (
  timeline: readonly TaskTimelineEntry[]
): TaskMentionSummary => {
  let lastCommentAt: number | undefined;
  const mentioned = new Set<string>();
  for (const entry of timeline) {
    if (entry.kind !== 'comment') {
      continue;
    }
    if (lastCommentAt === undefined || entry.createdAt > lastCommentAt) {
      lastCommentAt = entry.createdAt;
    }
    for (const userId of entry.mentions ?? []) {
      if (userId) {
        mentioned.add(userId);
      }
    }
  }
  return {
    ...(lastCommentAt !== undefined ? { lastCommentAt } : {}),
    ...(mentioned.size > 0 ? { mentionedUserIds: [...mentioned] } : {}),
  };
};

/**
 * Whether a task has a comment mentioning this user that they have not seen.
 *
 * `lastReadAt` comes from device-local state; an unseen mention on a device the
 * user has never opened the task on is correct behaviour, not a bug.
 */
export const hasUnreadTaskMention = (
  row: { lastCommentAt?: number; mentionedUserIds?: string[] },
  userId: string | undefined,
  lastReadAt: number | undefined
): boolean => {
  if (!userId || row.lastCommentAt === undefined) {
    return false;
  }
  if (!row.mentionedUserIds?.includes(userId)) {
    return false;
  }
  return lastReadAt === undefined || row.lastCommentAt > lastReadAt;
};
