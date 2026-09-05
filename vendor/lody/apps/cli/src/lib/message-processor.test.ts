import { describe, expect, it, vi } from 'vitest';

import type { LocalSessionControlRequestValidated } from '@lody/shared';
import type { Logger } from '@/utils/logger';

import { MessageProcessor } from './message-processor';

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
} as unknown as Logger;

const authenticationMessage = (
  requestId: string,
  action:
    | { type: 'start'; configId: string }
    | { type: 'cancel'; authenticationRequestId: string }
    | { type: 'submit-code'; authenticationRequestId: string; authorizationCode: string }
): LocalSessionControlRequestValidated =>
  ({
    type: 'machine/acp-authenticate',
    machineId: 'machine-test',
    workspaceId: 'workspace-test',
    requestId,
    action: action.type,
    ...('configId' in action ? { configId: action.configId } : {}),
    ...('authenticationRequestId' in action
      ? { authenticationRequestId: action.authenticationRequestId }
      : {}),
    ...('authorizationCode' in action ? { authorizationCode: action.authorizationCode } : {}),
  }) as LocalSessionControlRequestValidated;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('MessageProcessor ACP authentication lanes', () => {
  it('lets input and cancellation run while an interactive start is blocked', async () => {
    const processor = new MessageProcessor(logger);
    const releaseStart = deferred();
    const events: string[] = [];

    processor.enqueue(
      authenticationMessage('start', { type: 'start', configId: 'claude' }),
      async () => {
        events.push('start');
        await releaseStart.promise;
      }
    );
    processor.enqueue(
      authenticationMessage('submit', {
        type: 'submit-code',
        authenticationRequestId: 'start',
        authorizationCode: 'code',
      }),
      async () => {
        events.push('submit');
      }
    );
    processor.enqueue(
      authenticationMessage('cancel', {
        type: 'cancel',
        authenticationRequestId: 'start',
      }),
      async () => {
        events.push('cancel');
      }
    );

    await vi.waitFor(() => expect(events).toEqual(['start', 'submit', 'cancel']));
    releaseStart.resolve();
    await processor.drain();
  });

  it('serializes starts for the same persisted configuration', async () => {
    const processor = new MessageProcessor(logger);
    const releaseFirst = deferred();
    const events: string[] = [];

    processor.enqueue(
      authenticationMessage('first', { type: 'start', configId: 'claude' }),
      async () => {
        events.push('first');
        await releaseFirst.promise;
      }
    );
    processor.enqueue(
      authenticationMessage('second', { type: 'start', configId: 'claude' }),
      async () => {
        events.push('second');
      }
    );

    await vi.waitFor(() => expect(events).toEqual(['first']));
    releaseFirst.resolve();
    await processor.drain();
    expect(events).toEqual(['first', 'second']);
  });

  it('allows starts for different persisted configurations to overlap', async () => {
    const processor = new MessageProcessor(logger);
    const releaseStarts = deferred();
    const events: string[] = [];

    for (const configId of ['claude', 'codex']) {
      processor.enqueue(authenticationMessage(configId, { type: 'start', configId }), async () => {
        events.push(configId);
        await releaseStarts.promise;
      });
    }

    await vi.waitFor(() => expect(events).toHaveLength(2));
    releaseStarts.resolve();
    await processor.drain();
    expect(events).toEqual(expect.arrayContaining(['claude', 'codex']));
  });
});
