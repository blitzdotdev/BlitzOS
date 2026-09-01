import { describe, expect, it, vi } from 'vitest';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { SessionId } from '@lody/shared';

import { appendAutonomousACPNotifications } from '../src/lib/acp/history';

const makeNotification = (update: SessionNotification['update']): SessionNotification => ({
  sessionId: 'session-1' as SessionId,
  update,
});

describe('handleACPUpdateMessage plan sync', () => {
  it('writes the latest plan snapshot onto the session doc', async () => {
    const updateHistory = vi.fn(async (updateFn: (history: any[]) => any[]) => {
      updateFn([]);
    });
    const setPlan = vi.fn(async () => {});

    const doc = {
      updateHistory,
      setPlan,
    } as any;

    await appendAutonomousACPNotifications(
      doc,
      [
        makeNotification({
          sessionUpdate: 'plan',
          entries: [{ content: 'a', priority: 'low', status: 'pending' }],
        }),
        makeNotification({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        }),
        makeNotification({
          sessionUpdate: 'plan',
          entries: [{ content: 'b', priority: 'high', status: 'in_progress' }],
        }),
      ],
      {} as any
    );

    expect(setPlan).toHaveBeenCalledTimes(1);
    expect(setPlan).toHaveBeenCalledWith([
      { content: 'b', priority: 'high', status: 'in_progress' },
    ]);
  });
});
