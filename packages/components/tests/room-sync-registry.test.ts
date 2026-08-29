import { describe, it, expect, vi } from 'vitest';
import { createRoomSyncRegistry } from '../src/providers/room-sync-registry';
import type { RoomSyncTracker } from '../src/providers/room-sync-tracker';
import type { RoomSyncState } from '../src/lib/room-sync-state';

function createFakeTracker(roomId: string) {
  let state: RoomSyncState = 'connecting';
  let needs = false;
  const listeners = new Set<(s: RoomSyncState) => void>();
  const tracker: RoomSyncTracker = {
    roomId,
    attach: () => {},
    markFirstSynced: () => {},
    markFirstSyncFailed: () => {},
    markStopped: () => {
      state = 'idle';
      for (const listener of Array.from(listeners)) {
        listener(state);
      }
    },
    getSyncState: () => state,
    subscribeSyncState: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    needsReconnect: () => needs,
    hasReconnectSignal: () => false,
    dispose: () => {},
  };
  return {
    tracker,
    setState: (next: RoomSyncState) => {
      state = next;
      for (const listener of Array.from(listeners)) {
        listener(next);
      }
    },
    setNeeds: (value: boolean) => {
      needs = value;
    },
  };
}

describe('createRoomSyncRegistry', () => {
  it('reports a room as joined only in syncing/synced states', () => {
    const registry = createRoomSyncRegistry({ clock: { now: () => 0 } });
    const fake = createFakeTracker('session-a');
    registry.track(fake.tracker);

    // 'connecting' is not joined (tracker exists but no live subscription yet).
    expect(registry.isJoined('session-a')).toBe(false);

    fake.setState('syncing');
    expect(registry.isJoined('session-a')).toBe(true);
    expect(registry.getJoinedRooms()).toEqual(new Set(['session-a']));

    fake.setState('synced');
    expect(registry.isJoined('session-a')).toBe(true);

    fake.setState('disconnected');
    expect(registry.isJoined('session-a')).toBe(false);
  });

  it('records lastSyncedAt when a room reaches synced and exposes recency', () => {
    let now = 1_000;
    const registry = createRoomSyncRegistry({ clock: { now: () => now } });
    const fake = createFakeTracker('session-a');
    registry.track(fake.tracker);

    expect(registry.lastSyncedAt('session-a')).toBeUndefined();

    now = 5_000;
    fake.setState('synced');
    expect(registry.lastSyncedAt('session-a')).toBe(5_000);

    now = 9_000;
    expect(registry.getRecentlySynced(now, 5_000)).toEqual(new Set(['session-a']));
    now = 11_000;
    expect(registry.getRecentlySynced(now, 5_000)).toEqual(new Set());
  });

  it('stops reporting a room as joined once its subscription is torn down, but keeps lastSyncedAt', () => {
    let now = 5_000;
    const registry = createRoomSyncRegistry({ clock: { now: () => now } });
    const fake = createFakeTracker('session-a');
    registry.track(fake.tracker);

    fake.setState('synced');
    expect(registry.isJoined('session-a')).toBe(true);
    expect(registry.lastSyncedAt('session-a')).toBe(5_000);

    // Lease released → subscription torn down → tracker reset to idle.
    fake.tracker.markStopped();
    expect(registry.isJoined('session-a')).toBe(false);
    expect(registry.getJoinedRooms()).toEqual(new Set());
    // Freshness checkpoint is retained so dedup still works after a warm sync.
    now = 8_000;
    expect(registry.getRecentlySynced(now, 5_000)).toEqual(new Set(['session-a']));
  });

  it('serves anyNeedsReconnect from tracked trackers', () => {
    const registry = createRoomSyncRegistry({ clock: { now: () => 0 } });
    const fake = createFakeTracker('session-a');
    registry.track(fake.tracker);

    expect(registry.anyNeedsReconnect()).toBe(false);
    fake.setNeeds(true);
    expect(registry.anyNeedsReconnect()).toBe(true);
  });

  it('anyNeedsReconnect honors the roomId filter (durable-only scans skip presence)', () => {
    const registry = createRoomSyncRegistry({ clock: { now: () => 0 } });
    const durable = createFakeTracker('session-a');
    const presence = createFakeTracker('presence:workspace-1');
    registry.track(durable.tracker);
    registry.track(presence.tracker);

    presence.setNeeds(true);
    expect(registry.anyNeedsReconnect()).toBe(true);
    expect(registry.anyNeedsReconnect((roomId) => roomId !== 'presence:workspace-1')).toBe(false);

    durable.setNeeds(true);
    expect(registry.anyNeedsReconnect((roomId) => roomId !== 'presence:workspace-1')).toBe(true);
  });

  it('listNeedsReconnect names the broken rooms and honors the filter', () => {
    const registry = createRoomSyncRegistry({ clock: { now: () => 0 } });
    const durable = createFakeTracker('session-a');
    const presence = createFakeTracker('presence:workspace-1');
    registry.track(durable.tracker);
    registry.track(presence.tracker);

    expect(registry.listNeedsReconnect()).toEqual([]);

    durable.setNeeds(true);
    presence.setNeeds(true);
    expect(new Set(registry.listNeedsReconnect())).toEqual(
      new Set(['session-a', 'presence:workspace-1'])
    );
    expect(registry.listNeedsReconnect((roomId) => roomId !== 'presence:workspace-1')).toEqual([
      'session-a',
    ]);
  });

  it('forwards every tracked state change to onTrackerStateChange and subscribers', () => {
    const onTrackerStateChange = vi.fn();
    const registry = createRoomSyncRegistry({ clock: { now: () => 0 }, onTrackerStateChange });
    const subscriber = vi.fn();
    registry.subscribe(subscriber);

    const fake = createFakeTracker('session-a');
    registry.track(fake.tracker);
    // subscribeSyncState emits current state immediately on track.
    expect(onTrackerStateChange).toHaveBeenCalled();
    expect(subscriber).toHaveBeenCalled();

    onTrackerStateChange.mockClear();
    subscriber.mockClear();
    fake.setState('synced');
    expect(onTrackerStateChange).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it('untrack removes the tracker and stops tracking its room', () => {
    const registry = createRoomSyncRegistry({ clock: { now: () => 0 } });
    const fake = createFakeTracker('session-a');
    const untrack = registry.track(fake.tracker);
    fake.setState('synced');
    expect(registry.isJoined('session-a')).toBe(true);

    untrack();
    expect(registry.isJoined('session-a')).toBe(false);
    expect(registry.getJoinedRooms()).toEqual(new Set());
    // Idempotent.
    expect(() => untrack()).not.toThrow();
  });
});
