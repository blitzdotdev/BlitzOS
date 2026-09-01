export type RoomSyncState =
  | 'idle'
  | 'connecting'
  | 'syncing'
  | 'synced'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

/** Actively making progress toward synced — worth a quiet spinner, not a warning. */
export function isSyncingRoomSyncState(state: RoomSyncState): boolean {
  return state === 'idle' || state === 'connecting' || state === 'syncing';
}
