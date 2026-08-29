import type { RoomSyncState } from '@/lib/room-sync-state';
import type { LodyControlConnectionState } from '@/atoms/control-connection';

/**
 * The workspace control indicator (task-list top-left) is meta-room-only by
 * design: `metaSyncState` is the meta room's tracker state from the room-sync
 * registry, and no other room (sessions, presence) may feed this function.
 */
type ResolveWorkspaceControlConnectionStateInput = {
  hasAuthToken: boolean;
  browserOnline: boolean;
  transportAttached: boolean;
  metaSyncState: RoomSyncState;
  initialMetaSyncCompleted: boolean;
  initialMetaSyncFailed: boolean;
};

export function resolveWorkspaceControlConnectionState({
  hasAuthToken,
  browserOnline,
  transportAttached,
  metaSyncState,
  initialMetaSyncCompleted,
  initialMetaSyncFailed,
}: ResolveWorkspaceControlConnectionStateInput): LodyControlConnectionState {
  if (!hasAuthToken) {
    return 'idle';
  }
  if (!browserOnline) {
    return 'offline';
  }
  if (!transportAttached) {
    return 'connecting';
  }

  // 'synced' means joined + first remote sync completed; 'syncing' means
  // joined with the first sync still pending. Every other state falls back to
  // "have we ever synced / did the first sync fail" to decide between
  // reconnecting (something to recover) and connecting (still starting up).
  if (metaSyncState === 'synced') {
    return 'online';
  }
  if (metaSyncState === 'syncing') {
    return 'syncing';
  }
  if (metaSyncState === 'reconnecting' || initialMetaSyncCompleted || initialMetaSyncFailed) {
    return 'reconnecting';
  }

  return 'connecting';
}
