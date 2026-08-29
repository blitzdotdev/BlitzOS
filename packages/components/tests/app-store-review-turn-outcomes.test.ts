import { describe, expect, it } from 'vitest';
import type { SessionHistory, SessionId } from '@lody/shared';

import { extractAppStoreReviewTurnOutcomes } from '../src/hooks/use-app-store-review-prompt';

const sessionId = 'session-1' as SessionId;
const timestamp = '2026-05-10T12:00:00.000Z';

function historyEntry(
  overrides: Partial<SessionHistory> & Pick<SessionHistory, 'id'>
): SessionHistory {
  return {
    id: overrides.id,
    role: overrides.role ?? 'assistant',
    timestamp: overrides.timestamp ?? timestamp,
    fileDiff: overrides.fileDiff ?? [],
    items: overrides.items ?? [],
    ...overrides,
  } as SessionHistory;
}

describe('app store review turn outcomes', () => {
  it('counts a visible finalized assistant response, and records delivery and agent failures', () => {
    expect(
      extractAppStoreReviewTurnOutcomes({
        sessionId,
        history: [
          historyEntry({
            id: 'completed',
            finished: true,
            endedAt: Date.parse(timestamp),
            items: [{ type: 'text', text: 'Done.' }],
          }),
          historyEntry({
            id: 'empty',
            finished: true,
            items: [],
          }),
          historyEntry({
            id: 'delivery-failed',
            role: 'user',
            status: 'failed',
          }),
          historyEntry({
            id: 'agent-failed',
            finished: true,
            items: [
              {
                type: 'system_notice',
                name: 'chat_failed',
                meta: { reason: 'agent_no_output' },
              },
            ],
          }),
        ],
      })
    ).toEqual([
      {
        id: 'session-1:completed',
        kind: 'completed',
        occurredAtMs: Date.parse(timestamp),
      },
      {
        id: 'session-1:delivery-failed',
        kind: 'hard_failure',
        occurredAtMs: Date.parse(timestamp),
      },
      {
        id: 'session-1:agent-failed',
        kind: 'hard_failure',
        occurredAtMs: Date.parse(timestamp),
      },
    ]);
  });

  it('does not count an assistant response whose linked user turn was canceled or failed', () => {
    expect(
      extractAppStoreReviewTurnOutcomes({
        sessionId,
        history: [
          historyEntry({ id: 'canceled-user', role: 'user', status: 'canceled' }),
          historyEntry({
            id: 'canceled-assistant',
            userTurnId: 'canceled-user',
            finished: true,
            items: [{ type: 'text', text: 'Partial output before Stop.' }],
          }),
          historyEntry({ id: 'failed-user', role: 'user', status: 'failed' }),
          historyEntry({
            id: 'failed-assistant',
            userTurnId: 'failed-user',
            finished: true,
            items: [{ type: 'text', text: 'Partial output before failure.' }],
          }),
        ],
      })
    ).toEqual([
      {
        id: 'session-1:failed-user',
        kind: 'hard_failure',
        occurredAtMs: Date.parse(timestamp),
      },
    ]);
  });
});
