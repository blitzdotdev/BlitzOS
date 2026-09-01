import type { RoomSyncState } from '@/lib/room-sync-state';

/**
 * Minimal structural surface the registry needs from a tracked room. Durable
 * rooms register their full `RoomSyncTracker`; the workspace presence
 * (Ephemeral Stream) transport registers a thin adapter under the
 * `presence:<workspaceId>` key so its health lives in the same truth source.
 */
export interface TrackedRoomSync {
  readonly roomId: string;
  getSyncState(): RoomSyncState;
  subscribeSyncState(listener: (state: RoomSyncState) => void): () => void;
  needsReconnect(): boolean;
}

/**
 * Keyed registry over the workspace's tracked rooms (durable `RoomSyncTracker`s
 * plus the presence transport adapter).
 *
 * Replaces the previous anonymous `Set<RoomSyncTracker>` in
 * `create-workspace-runtime.ts`. Beyond serving `hasReconnectableProblem()`
 * (via {@link RoomSyncRegistry.anyNeedsReconnect}), it answers two questions the
 * background eager-sync coordinator needs:
 *
 * - which rooms currently hold a live SSE subscription (`getJoinedRooms`), and
 * - when each room last finished syncing with the remote (`lastSyncedAt` /
 *   `getRecentlySynced`).
 *
 * "joined" is intentionally defined as the tracker state being `'syncing'` or
 * `'synced'`. Those states require the underlying transport status to be
 * `'joined'`, which only happens after a real subscription is attached — so a
 * tracker that was merely created (status `null` → `'connecting'`) is NOT
 * reported as joined. After a sync lease is released the tracker can stay
 * `'synced'` for the brief release-delay window before its subscription is torn
 * down; that staleness is bounded and harmless because callers also gate on
 * freshness (`lastSyncedAt`).
 */
export interface RoomSyncRegistry {
  /**
   * Register a tracker. Returns an `untrack` fn that must be called when the
   * tracker is disposed.
   */
  track(tracker: TrackedRoomSync): () => void;
  /** Whether `roomId` currently has a live subscription (state syncing/synced). */
  isJoined(roomId: string): boolean;
  /** Snapshot of every room id with a live subscription right now. */
  getJoinedRooms(): ReadonlySet<string>;
  /** Wall-clock ms of the last time `roomId` reached `'synced'`, if ever. */
  lastSyncedAt(roomId: string): number | undefined;
  /** Room ids that reached `'synced'` within the last `ttlMs`. */
  getRecentlySynced(now: number, ttlMs: number): ReadonlySet<string>;
  /**
   * True if any tracked room needs a reconnect (serves hasReconnectableProblem).
   * `filter` narrows the scan (e.g. durable rooms only, excluding `presence:`).
   */
  anyNeedsReconnect(filter?: (roomId: string) => boolean): boolean;
  /**
   * Room ids currently needing a reconnect — the diagnosability companion of
   * `anyNeedsReconnect` so reconnect logs can name the broken room instead of
   * a bare boolean.
   */
  listNeedsReconnect(filter?: (roomId: string) => boolean): string[];
  /** Subscribe to any tracked-room state change. Returns an unsubscribe fn. */
  subscribe(onChange: () => void): () => void;
}

const isJoinedState = (state: RoomSyncState): boolean => state === 'syncing' || state === 'synced';

export interface RoomSyncRegistryDeps {
  clock: { now(): number };
  /**
   * Called on every tracked-room state change. In the runtime this is
   * `notifyConnectionStateInputsChanged`, preserving the previous behavior where
   * each tracker's state change nudged the reconnect loop + control-state emit.
   */
  onTrackerStateChange?: () => void;
}

export function createRoomSyncRegistry(deps: RoomSyncRegistryDeps): RoomSyncRegistry {
  const trackers = new Set<TrackedRoomSync>();
  // roomId -> last wall-clock ms the room reached 'synced'.
  const lastSynced = new Map<string, number>();
  const subscribers = new Set<() => void>();

  const notify = () => {
    deps.onTrackerStateChange?.();
    for (const listener of Array.from(subscribers)) {
      listener();
    }
  };

  const track = (tracker: TrackedRoomSync): (() => void) => {
    trackers.add(tracker);
    const detach = tracker.subscribeSyncState((state) => {
      if (state === 'synced') {
        lastSynced.set(tracker.roomId, deps.clock.now());
      }
      notify();
    });
    let untracked = false;
    return () => {
      if (untracked) {
        return;
      }
      untracked = true;
      detach();
      trackers.delete(tracker);
      notify();
    };
  };

  const isJoined = (roomId: string): boolean => {
    for (const tracker of trackers) {
      if (tracker.roomId === roomId && isJoinedState(tracker.getSyncState())) {
        return true;
      }
    }
    return false;
  };

  const getJoinedRooms = (): ReadonlySet<string> => {
    const joined = new Set<string>();
    for (const tracker of trackers) {
      if (isJoinedState(tracker.getSyncState())) {
        joined.add(tracker.roomId);
      }
    }
    return joined;
  };

  const lastSyncedAt = (roomId: string): number | undefined => lastSynced.get(roomId);

  const getRecentlySynced = (now: number, ttlMs: number): ReadonlySet<string> => {
    const recent = new Set<string>();
    for (const [roomId, at] of lastSynced) {
      if (now - at <= ttlMs) {
        recent.add(roomId);
      }
    }
    return recent;
  };

  const anyNeedsReconnect = (filter?: (roomId: string) => boolean): boolean => {
    for (const tracker of trackers) {
      if (filter && !filter(tracker.roomId)) {
        continue;
      }
      if (tracker.needsReconnect()) {
        return true;
      }
    }
    return false;
  };

  const listNeedsReconnect = (filter?: (roomId: string) => boolean): string[] => {
    const roomIds: string[] = [];
    for (const tracker of trackers) {
      if (filter && !filter(tracker.roomId)) {
        continue;
      }
      if (tracker.needsReconnect()) {
        roomIds.push(tracker.roomId);
      }
    }
    return roomIds;
  };

  const subscribe = (onChange: () => void): (() => void) => {
    subscribers.add(onChange);
    return () => {
      subscribers.delete(onChange);
    };
  };

  return {
    track,
    isJoined,
    getJoinedRooms,
    lastSyncedAt,
    getRecentlySynced,
    anyNeedsReconnect,
    listNeedsReconnect,
    subscribe,
  };
}
