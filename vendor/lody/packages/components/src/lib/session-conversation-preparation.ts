import type { RoomSyncState } from '@/lib/room-sync-state';

export type SessionConversationPreparationState = 'waiting' | 'ready' | 'sync-error';

export function resolveSessionConversationPreparationState({
  docReady,
  historyLength,
  syncState,
}: {
  docReady: boolean;
  historyLength: number;
  syncState: RoomSyncState;
}): SessionConversationPreparationState {
  if (!docReady) return 'waiting';
  if (historyLength > 0) return 'ready';
  if (syncState === 'error') return 'sync-error';
  return 'waiting';
}
