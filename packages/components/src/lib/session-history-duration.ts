import type { SessionHistoryParsed } from '@lody/shared';

export const resolveSessionHistoryDurationMs = (
  message: Pick<SessionHistoryParsed, 'endedAt' | 'timestamp'>
): number | null => {
  const endedAt = message.endedAt;
  if (typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return null;

  const parsed = Date.parse(message.timestamp);
  if (!Number.isFinite(parsed)) return null;

  if (endedAt < parsed) return null;
  return endedAt - parsed;
};
