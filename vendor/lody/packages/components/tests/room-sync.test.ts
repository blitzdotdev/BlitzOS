import { describe, expect, it, vi } from 'vitest';
import { waitForRoomToSync, type SyncRoomSubscription } from '../src/providers/room-sync';

const createSubscription = (
  firstSyncedWithRemote: Promise<void> = Promise.resolve()
): SyncRoomSubscription & { unsubscribe: ReturnType<typeof vi.fn> } => ({
  firstSyncedWithRemote,
  unsubscribe: vi.fn(),
});

describe('waitForRoomToSync', () => {
  it('waits one task before the first join when initialDelayMs is provided', async () => {
    const sleepDeferred: { promise: Promise<void>; resolve: (() => void) | null } = {
      promise: Promise.resolve(),
      resolve: null,
    };
    sleepDeferred.promise = new Promise<void>((resolve) => {
      sleepDeferred.resolve = resolve;
    });
    const sleep = vi.fn(() => sleepDeferred.promise);
    const sub = createSubscription();
    const joinRoom = vi.fn().mockResolvedValue(sub);

    const promise = waitForRoomToSync(joinRoom, {
      roomId: 'session-1',
      initialDelayMs: 0,
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(0);
    expect(joinRoom).not.toHaveBeenCalled();

    const releaseSleep = sleepDeferred.resolve;
    if (!releaseSleep) {
      throw new Error('Expected sleep to capture a resolver');
    }
    releaseSleep();
    const result = await promise;
    expect(result).toBe(sub);
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });

  it('retries a failed join and returns the later successful subscription', async () => {
    const sub = createSubscription();
    const joinRoom = vi
      .fn()
      .mockRejectedValueOnce(new Error('stream_not_found'))
      .mockResolvedValueOnce(sub);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    const result = await waitForRoomToSync(joinRoom, {
      roomId: 'session-1',
      sleep,
      warn,
    });

    expect(result).toBe(sub);
    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[session-1] joinRoom failed (attempt 1/3)')
    );
  });

  it('keeps a returned room subscription when initial sync fails', async () => {
    const failedFirstSync = Promise.reject(new Error('bootstrap failed with status 404'));
    void failedFirstSync.catch(() => {});
    const badSub = createSubscription(failedFirstSync);
    const joinRoom = vi.fn().mockResolvedValueOnce(badSub);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    await expect(
      waitForRoomToSync(joinRoom, {
        roomId: 'session-1',
        sleep,
        warn,
      })
    ).rejects.toThrow('bootstrap failed with status 404');

    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(badSub.unsubscribe).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[session-1] initial room sync unavailable, continuing offline-first: bootstrap failed with status 404'
    );
  });

  it('returns null when cancelled between retries', async () => {
    let cancelled = false;
    const joinRoom = vi.fn().mockRejectedValueOnce(new Error('stream_not_found'));
    const sleep = vi.fn().mockImplementation(async () => {
      cancelled = true;
    });
    const warn = vi.fn();

    const result = await waitForRoomToSync(joinRoom, {
      roomId: 'session-1',
      sleep,
      warn,
      isCancelled: () => cancelled,
    });

    expect(result).toBeNull();
    expect(joinRoom).toHaveBeenCalledTimes(1);
  });

  it('returns null without warning when cancelled while first sync is rejected', async () => {
    let cancelled = false;
    const failedFirstSync = Promise.reject(new Error('subscription closed'));
    void failedFirstSync.catch(() => {});
    const sub = createSubscription(failedFirstSync);
    const joinRoom = vi.fn().mockResolvedValue(sub);
    const warn = vi.fn();

    const result = await waitForRoomToSync(joinRoom, {
      roomId: 'session-1',
      warn,
      isCancelled: () => cancelled,
      onSubscription: () => {
        cancelled = true;
      },
    });

    expect(result).toBeNull();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('throws the last error after retries are exhausted', async () => {
    const joinRoom = vi.fn().mockRejectedValue(new Error('stream_not_found'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();

    await expect(
      waitForRoomToSync(joinRoom, {
        roomId: 'session-1',
        maxJoinRetries: 2,
        sleep,
        warn,
      })
    ).rejects.toThrow('stream_not_found');

    expect(joinRoom).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      '[session-1] initial room sync unavailable, continuing offline-first: stream_not_found'
    );
  });
});

describe('waitForRoomToSync firstSynced selector', () => {
  it('gates on the selected binding promise, not the aggregate', async () => {
    // Dual-homed rooms must select one plane's first-sync promise: the
    // aggregate getter throws there, so the selector is the only legal gate.
    const bindingFirstSynced = Promise.resolve();
    const sub = {
      get firstSyncedWithRemote(): Promise<void> {
        throw new Error('aggregate first-sync must not be read on dual-homed rooms');
      },
      unsubscribe: () => undefined,
    };
    const result = await waitForRoomToSync(async () => sub, {
      roomId: 'room-selector',
      firstSynced: () => bindingFirstSynced,
    });
    expect(result).toBe(sub);
  });
});
