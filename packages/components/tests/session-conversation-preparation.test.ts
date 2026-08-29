import { describe, expect, it } from 'vitest';
import { resolveSessionConversationPreparationState } from '../src/lib/session-conversation-preparation';

describe('resolveSessionConversationPreparationState', () => {
  it('waits until the local session doc is ready', () => {
    expect(
      resolveSessionConversationPreparationState({
        docReady: false,
        historyLength: 4,
        syncState: 'synced',
      })
    ).toBe('waiting');
  });

  it('allows the prepared surface to open as soon as fork history is locally available', () => {
    expect(
      resolveSessionConversationPreparationState({
        docReady: true,
        historyLength: 4,
        syncState: 'syncing',
      })
    ).toBe('ready');
  });

  it('surfaces a terminal transport failure', () => {
    expect(
      resolveSessionConversationPreparationState({
        docReady: true,
        historyLength: 0,
        syncState: 'error',
      })
    ).toBe('sync-error');
  });

  it('keeps waiting when the first sync completes before fork history propagates', () => {
    expect(
      resolveSessionConversationPreparationState({
        docReady: true,
        historyLength: 0,
        syncState: 'synced',
      })
    ).toBe('waiting');
  });

  it('keeps waiting while an empty document can still receive fork history', () => {
    expect(
      resolveSessionConversationPreparationState({
        docReady: true,
        historyLength: 0,
        syncState: 'reconnecting',
      })
    ).toBe('waiting');
  });
});
