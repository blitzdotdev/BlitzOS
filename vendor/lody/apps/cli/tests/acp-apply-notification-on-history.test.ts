import { describe, expect, it } from 'vitest';

import type { MessageContent, SessionHistoryInput, SessionId } from '@lody/shared';
import type { SessionNotification } from '@agentclientprotocol/sdk';

import { applyNotificationOnHistory } from '../src/lib/acp/history';

const makeNotification = (update: SessionNotification['update']): SessionNotification => ({
  sessionId: 'session-1' as SessionId,
  update,
});

describe('applyNotificationOnHistory', () => {
  it('mutates the history array in-place', () => {
    const history: SessionHistoryInput[] = [];
    const result = applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
    ]);
    expect(result).toBe(history);
    expect(history).toHaveLength(1);
  });

  it('merges adjacent agent_message_chunk text deltas', () => {
    const history: SessionHistoryInput[] = [];
    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' world' },
      }),
    ]);

    expect(history).toHaveLength(1);
    const items = history[0]!.items as unknown as MessageContent[];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  it('creates a new assistant entry when last entry is non-assistant', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'u1',
        role: 'user',
        items: [{ type: 'text', text: 'hi' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
      },
    ];

    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'response' },
      }),
    ]);

    expect(history).toHaveLength(2);
    expect(history[1]!.role).toBe('assistant');
  });

  it('creates a new assistant entry after worktree script history', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'setup-1',
        role: 'system',
        items: [
          {
            type: 'worktree_script',
            phase: 'setup',
            status: 'completed',
            steps: [
              {
                command: 'pnpm install',
                status: 'completed',
                output: 'hello\n',
              },
            ],
          },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        endedAt: Date.now(),
        finished: true,
        read: undefined,
        userId: undefined,
        fileDiff: [],
      },
    ];

    applyNotificationOnHistory(
      history,
      [
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'AI response' },
        }),
      ],
      { modelId: 'claude-sonnet', name: 'Claude Sonnet' }
    );

    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe('setup-1');
    expect((history[0]!.items as unknown as MessageContent[]).map((item) => item.type)).toEqual([
      'worktree_script',
    ]);
    expect(history[1]!.modelInfo?.name).toBe('Claude Sonnet');
    expect(history[1]!.items as unknown as MessageContent[]).toEqual([
      { type: 'text', text: 'AI response' },
    ]);
  });

  it('upserts plan as a singleton snapshot', () => {
    const history: SessionHistoryInput[] = [];

    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      }),
      makeNotification({
        sessionUpdate: 'plan',
        entries: [{ content: 'a', priority: 'low', status: 'pending' }],
      }),
      makeNotification({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' world' },
      }),
      makeNotification({
        sessionUpdate: 'plan',
        entries: [{ content: 'b', priority: 'high', status: 'completed' }],
      }),
    ]);

    expect(history).toHaveLength(1);
    const items = history[0]!.items as unknown as MessageContent[];
    // Plan is now stored on entry.plan, not in items
    expect(items.map((m) => m.type)).toEqual(['text']);

    const text = items[0] as Extract<MessageContent, { type: 'text' }>;
    expect(text.text).toBe('hello world');

    // Plan is stored on the entry itself
    expect(history[0]!.plan).toEqual([{ content: 'b', priority: 'high', status: 'completed' }]);
  });

  it('applies tool_call_update to the entry where the tool call originally appeared', () => {
    const history: SessionHistoryInput[] = [
      {
        id: 'a1',
        role: 'assistant',
        items: [
          { type: 'tool_call', toolCallId: 'tc1', title: 'Do', status: 'pending', kind: 'read' },
        ] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
      },
      {
        id: 'a2',
        role: 'assistant',
        items: [{ type: 'text', text: 'later' }] satisfies MessageContent[],
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
      },
    ];

    applyNotificationOnHistory(history, [
      makeNotification({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
      }),
    ]);

    const firstItems = history[0]!.items as unknown as MessageContent[];
    const tool = firstItems.find((m) => m.type === 'tool_call') as Extract<
      MessageContent,
      { type: 'tool_call' }
    >;
    expect(tool.status).toBe('completed');
  });
});
