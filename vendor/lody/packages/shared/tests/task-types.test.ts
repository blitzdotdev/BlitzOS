import { describe, expect, it } from 'vitest';
import {
  deriveTaskTitle,
  getActiveTaskPrLinks,
  getActiveTaskSessionLinks,
  getMissingTaskExecutionFields,
  getTaskIdFromRoomId,
  getTaskLinkedSessionIds,
  getTaskRoomId,
  isEmptyTaskDraft,
  isTaskDocRoomId,
  resolveTaskPrFollowStatus,
  shouldEnterTaskNeedsReview,
  TASK_TITLE_FALLBACK_MAX_LENGTH,
  type TaskAgentRef,
  type TaskId,
  type TaskLink,
  type SessionId,
} from '../src/task-types';
import { buildTaskIndexRow, isTaskIndexFlockDocId, getTaskIndexFlockDocId } from '../src/task-index';
import { hasUnreadTaskMention, summarizeTaskMentions } from '../src/task-types';
import { MessageItemActorSchema, TaskProposalMetaSchema } from '../src/message-schemas';
import type { TaskTimelineEntry } from '../src/task-types';
import type { AgentConfigId, WorkspaceId } from '../src/ids';

const agent = { agentConfigId: 'agent-1' as AgentConfigId } satisfies TaskAgentRef;

const sessionLink = (overrides: Partial<TaskLink> = {}): TaskLink => ({
  id: overrides.id ?? 'link-1',
  kind: 'session',
  actorKind: 'human',
  linkedAt: 1,
  sessionId: ('session-1' as SessionId) as SessionId,
  origin: 'run',
  ...overrides,
});

describe('task room identity', () => {
  it('round-trips a task id through its room id', () => {
    const roomId = getTaskRoomId('abc' as TaskId);
    expect(roomId).toBe('task-abc');
    expect(isTaskDocRoomId(roomId)).toBe(true);
    expect(getTaskIdFromRoomId(roomId)).toBe('abc');
  });

  it('does not claim other room types', () => {
    expect(isTaskDocRoomId('session-abc')).toBe(false);
    expect(getTaskIdFromRoomId('session-abc')).toBeNull();
  });

  it('recognizes only the workspace-scoped index flock id', () => {
    const docId = getTaskIndexFlockDocId('ws1' as WorkspaceId);
    expect(docId).toBe('ws1:ti');
    expect(isTaskIndexFlockDocId(docId)).toBe(true);
    // A machine flock id has three segments and must not be mistaken for it.
    expect(isTaskIndexFlockDocId('ws1:mf:machine-1')).toBe(false);
    expect(isTaskIndexFlockDocId('ws1:s:session-1')).toBe(false);
  });
});

describe('deriveTaskTitle', () => {
  it('prefers an explicit title', () => {
    expect(deriveTaskTitle({ title: '  Fix login  ', body: 'other' })).toBe('Fix login');
  });

  it('flattens newlines in an explicit title', () => {
    expect(deriveTaskTitle({ title: 'a\nb' })).toBe('a b');
  });

  it('falls back to the first meaningful body line', () => {
    expect(deriveTaskTitle({ body: '\n\n  Refactor auth \nmore detail' })).toBe('Refactor auth');
  });

  it('truncates a long fallback and marks it', () => {
    const long = 'x'.repeat(TASK_TITLE_FALLBACK_MAX_LENGTH + 40);
    const title = deriveTaskTitle({ body: long });
    expect(title).toHaveLength(TASK_TITLE_FALLBACK_MAX_LENGTH + 1);
    expect(title.endsWith('…')).toBe(true);
  });

  it('returns empty when there is nothing to name', () => {
    expect(deriveTaskTitle({})).toBe('');
    expect(deriveTaskTitle({ title: '   ', body: '  \n ' })).toBe('');
  });
});

describe('isEmptyTaskDraft', () => {
  it('treats whitespace-only input as empty so creating is a no-op', () => {
    expect(isEmptyTaskDraft({ title: '  ', body: '\n' })).toBe(true);
  });

  it('is not empty when either field has content', () => {
    expect(isEmptyTaskDraft({ title: 'a' })).toBe(false);
    expect(isEmptyTaskDraft({ body: 'a' })).toBe(false);
  });
});

describe('execution readiness', () => {
  it('reports every missing execution input', () => {
    expect(getMissingTaskExecutionFields({})).toEqual(['agent', 'projects']);
    expect(getMissingTaskExecutionFields({ agent })).toEqual(['projects']);
    expect(
      getMissingTaskExecutionFields({
        agent,
        projects: [{ kind: 'github', repoFullName: 'o/r', branch: 'main' }],
      })
    ).toEqual([]);
  });
});

describe('link provenance', () => {
  it('hides tombstoned links but keeps them in history', () => {
    const links: TaskLink[] = [
      sessionLink({ id: 'a' }),
      sessionLink({ id: 'b', sessionId: 'session-2' as SessionId, removedAt: 5 }),
    ];
    expect(getActiveTaskSessionLinks(links).map((link) => link.id)).toEqual(['a']);
    expect(links).toHaveLength(2);
  });

  it('separates session and pull-request links', () => {
    const links: TaskLink[] = [
      sessionLink(),
      {
        id: 'pr-1',
        kind: 'pr',
        actorKind: 'agent',
        linkedAt: 2,
        provider: 'github',
        url: 'https://github.com/o/r/pull/1',
      },
    ];
    expect(getActiveTaskSessionLinks(links)).toHaveLength(1);
    expect(getActiveTaskPrLinks(links)).toHaveLength(1);
  });

  it('deduplicates linked session ids', () => {
    const links: TaskLink[] = [sessionLink({ id: 'a' }), sessionLink({ id: 'b' })];
    expect(getTaskLinkedSessionIds(links)).toEqual(['session-1']);
  });
});

describe('resolveTaskPrFollowStatus', () => {
  it('waits while any pull request is still open', () => {
    expect(resolveTaskPrFollowStatus(['open'])).toBeNull();
    expect(resolveTaskPrFollowStatus(['merged', 'open'])).toBeNull();
    expect(resolveTaskPrFollowStatus(['merged', 'draft'])).toBeNull();
  });

  it('completes when everything is terminal and something merged', () => {
    expect(resolveTaskPrFollowStatus(['merged'])).toBe('done');
    expect(resolveTaskPrFollowStatus(['merged', 'closed'])).toBe('done');
  });

  it('cancels when everything closed without merging', () => {
    expect(resolveTaskPrFollowStatus(['closed'])).toBe('canceled');
    expect(resolveTaskPrFollowStatus(['closed', 'closed'])).toBe('canceled');
  });

  it('never completes on an unknown state', () => {
    expect(resolveTaskPrFollowStatus(['unknown'])).toBeNull();
    expect(resolveTaskPrFollowStatus(['merged', 'unknown'])).toBeNull();
  });

  it('does nothing without pull requests to follow', () => {
    expect(resolveTaskPrFollowStatus([])).toBeNull();
  });
});

describe('shouldEnterTaskNeedsReview', () => {
  it('fires when in-progress work has no pull requests and all sessions finished', () => {
    expect(
      shouldEnterTaskNeedsReview({
        status: 'in_progress',
        sessionTerminalStates: [true, true],
        hasPrLinks: false,
      })
    ).toBe(true);
  });

  it('defers to the pull requests when the task links any', () => {
    expect(
      shouldEnterTaskNeedsReview({
        status: 'in_progress',
        sessionTerminalStates: [true],
        hasPrLinks: true,
      })
    ).toBe(false);
  });

  it('waits while any session is still running', () => {
    expect(
      shouldEnterTaskNeedsReview({
        status: 'in_progress',
        sessionTerminalStates: [true, false],
        hasPrLinks: false,
      })
    ).toBe(false);
  });

  it('only applies to work that started', () => {
    expect(
      shouldEnterTaskNeedsReview({
        status: 'backlog',
        sessionTerminalStates: [true],
        hasPrLinks: false,
      })
    ).toBe(false);
  });

  it('does not fire for a task with no sessions at all', () => {
    expect(
      shouldEnterTaskNeedsReview({
        status: 'in_progress',
        sessionTerminalStates: [],
        hasPrLinks: false,
      })
    ).toBe(false);
  });
});

describe('buildTaskIndexRow', () => {
  const base = {
    taskId: 't1' as TaskId,
    title: 'Title',
    status: 'backlog' as const,
    ownerId: 'user-1',
    order: '1',
    createdAt: 1,
    updatedAt: 2,
  };

  it('marks an entrusted task without a project as not ready', () => {
    const row = buildTaskIndexRow({ ...base, agent }, { sessionCount: 0, prCount: 0 });
    expect(row.hasAgent).toBe(true);
    expect(row.agentConfigId).toBe('agent-1');
    expect(row.ready).toBe(false);
  });

  it('does not assert readiness for a task with no agent', () => {
    const row = buildTaskIndexRow(base, { sessionCount: 0, prCount: 0 });
    expect(row.hasAgent).toBe(false);
    expect(row.ready).toBe(true);
  });

  it('carries the counts the list renders', () => {
    const row = buildTaskIndexRow(
      { ...base, agent, projects: [{}] },
      { sessionCount: 3, prCount: 1 }
    );
    expect(row.ready).toBe(true);
    expect(row.sessionCount).toBe(3);
    expect(row.prCount).toBe(1);
  });
});

describe('summarizeTaskMentions', () => {
  const comment = (overrides: Partial<TaskTimelineEntry>): TaskTimelineEntry => ({
    id: 'c1',
    kind: 'comment',
    actorKind: 'human',
    createdAt: 1,
    ...overrides,
  });

  it('is empty for a thread with no comments', () => {
    expect(summarizeTaskMentions([])).toEqual({});
  });

  it('ignores activity entries, which nobody is mentioned in', () => {
    const summary = summarizeTaskMentions([
      { id: 'a', kind: 'activity', actorKind: 'human', createdAt: 5, activityType: 'created' },
    ]);
    expect(summary).toEqual({});
  });

  it('takes the newest comment time even when the thread is out of order', () => {
    const summary = summarizeTaskMentions([
      comment({ id: 'a', createdAt: 9 }),
      comment({ id: 'b', createdAt: 3 }),
    ]);
    expect(summary.lastCommentAt).toBe(9);
  });

  it('collects mentioned users without duplicates', () => {
    const summary = summarizeTaskMentions([
      comment({ id: 'a', mentions: ['u1', 'u2'] }),
      comment({ id: 'b', mentions: ['u1'] }),
    ]);
    expect(summary.mentionedUserIds?.sort()).toEqual(['u1', 'u2']);
  });

  it('does not record an empty mention list', () => {
    expect(summarizeTaskMentions([comment({ mentions: [] })]).mentionedUserIds).toBeUndefined();
  });
});

describe('hasUnreadTaskMention', () => {
  const row = { lastCommentAt: 10, mentionedUserIds: ['u1'] };

  it('is unread when the mentioning comment is newer than the read mark', () => {
    expect(hasUnreadTaskMention(row, 'u1', 5)).toBe(true);
  });

  it('is unread when this device never opened the task', () => {
    expect(hasUnreadTaskMention(row, 'u1', undefined)).toBe(true);
  });

  it('is read once the mark caught up', () => {
    expect(hasUnreadTaskMention(row, 'u1', 10)).toBe(false);
    expect(hasUnreadTaskMention(row, 'u1', 20)).toBe(false);
  });

  it('does not flag someone who was not mentioned', () => {
    expect(hasUnreadTaskMention(row, 'u2', undefined)).toBe(false);
  });

  it('does not flag a signed-out reader or a thread with no comments', () => {
    expect(hasUnreadTaskMention(row, undefined, undefined)).toBe(false);
    expect(hasUnreadTaskMention({ mentionedUserIds: ['u1'] }, 'u1', undefined)).toBe(false);
  });
});

describe('task proposal attribution', () => {
  it('accepts an agent-authored proposal with the shared actor shape', () => {
    const parsed = TaskProposalMetaSchema.safeParse({
      proposalId: 'p1',
      title: 'Do the thing',
      proposedBy: { kind: 'agent', agentConfigId: 'agent-1', name: 'Codex' },
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps attribution optional, so an unattributed proposal still parses', () => {
    expect(TaskProposalMetaSchema.safeParse({ proposalId: 'p1', title: 'x' }).success).toBe(true);
  });

  it('rejects an actor kind outside human/agent', () => {
    const parsed = TaskProposalMetaSchema.safeParse({
      proposalId: 'p1',
      title: 'x',
      proposedBy: { kind: 'robot' },
    });
    expect(parsed.success).toBe(false);
  });

  it('does not require an agent id — a human-authored item is valid attribution', () => {
    expect(MessageItemActorSchema.safeParse({ kind: 'human' }).success).toBe(true);
  });
});
