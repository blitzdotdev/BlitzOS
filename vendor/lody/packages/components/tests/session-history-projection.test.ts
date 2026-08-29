import { describe, expect, it } from 'vitest';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';
import {
  addAcceptedSessionHistoryProjection,
  getAcceptedSessionHistoryProjections,
  projectAcceptedSessionHistory,
  removeAcceptedSessionHistoryProjections,
  type AcceptedSessionHistoryProjection,
} from '../src/atoms/session-history-projection';

const workspaceId = 'workspace-1' as WorkspaceId;
const sessionId = 'session-1' as SessionId;

const historyEntry = (id: string, role: SessionHistory['role']): SessionHistory =>
  ({
    id,
    role,
    items: role === 'user' ? [{ type: 'text', text: id }] : [],
    timestamp: '2026-07-19T00:00:00.000Z',
  }) as SessionHistory;

const projection = (
  entry: SessionHistory,
  afterHistoryId?: string | null
): AcceptedSessionHistoryProjection => ({
  workspaceId,
  sessionId,
  entry,
  afterHistoryId,
});

describe('accepted session history projections', () => {
  it('projects an accepted first turn before later authoritative entries', () => {
    const user = historyEntry('user-1', 'user');
    const assistant = historyEntry('assistant-1', 'assistant');

    expect(projectAcceptedSessionHistory([assistant], [projection(user, null)])).toEqual([
      user,
      assistant,
    ]);
  });

  it('inserts an accepted follow-up after its known history anchor', () => {
    const previous = historyEntry('assistant-1', 'assistant');
    const user = historyEntry('user-2', 'user');
    const later = historyEntry('assistant-2', 'assistant');

    expect(
      projectAcceptedSessionHistory([previous, later], [projection(user, previous.id)])
    ).toEqual([previous, user, later]);
  });

  it('keeps chained accepted turns ordered before later authoritative entries', () => {
    const previous = historyEntry('assistant-1', 'assistant');
    const first = historyEntry('user-2', 'user');
    const second = historyEntry('user-3', 'user');
    const later = historyEntry('assistant-2', 'assistant');

    expect(
      projectAcceptedSessionHistory(
        [previous, later],
        [projection(first, previous.id), projection(second, first.id)]
      )
    ).toEqual([previous, first, second, later]);
  });

  it('appends projections without a known anchor to the current tail', () => {
    const existing = historyEntry('assistant-1', 'assistant');
    const accepted = historyEntry('user-2', 'user');

    expect(projectAcceptedSessionHistory([existing], [projection(accepted)])).toEqual([
      existing,
      accepted,
    ]);
  });

  it('lets authoritative history replace the projection without duplication', () => {
    const projectedUser = historyEntry('user-1', 'user');
    const authoritativeUser = {
      ...projectedUser,
      status: 'processing' as const,
    };
    const authoritativeHistory = [authoritativeUser];

    const result = projectAcceptedSessionHistory(authoritativeHistory, [
      projection(projectedUser, null),
    ]);

    expect(result).toBe(authoritativeHistory);
    expect(result).toEqual([authoritativeUser]);
  });

  it('reconciles only projections whose authoritative ids have arrived', () => {
    const first = projection(historyEntry('user-1', 'user'), null);
    const second = projection(historyEntry('user-2', 'user'), first.entry.id);
    let state = addAcceptedSessionHistoryProjection(new Map(), first);
    state = addAcceptedSessionHistoryProjection(state, second);

    const reconciled = removeAcceptedSessionHistoryProjections(
      state,
      workspaceId,
      sessionId,
      new Set([first.entry.id])
    );

    expect(getAcceptedSessionHistoryProjections(reconciled, workspaceId, sessionId)).toEqual([
      second,
    ]);
  });
});
