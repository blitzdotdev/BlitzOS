import { atom } from 'jotai';
import type { SessionHistory, SessionId, WorkspaceId } from '@lody/shared';

export type AcceptedSessionHistoryProjection = {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  entry: SessionHistory;
  /** null = head, string = after that entry, undefined = current tail. */
  afterHistoryId?: string | null;
};

export const acceptedSessionHistoryProjectionsAtom = atom<
  ReadonlyMap<string, AcceptedSessionHistoryProjection>
>(new Map<string, AcceptedSessionHistoryProjection>());

export const clearAcceptedSessionHistoryProjectionsAtom = atom(null, (_get, set) => {
  set(acceptedSessionHistoryProjectionsAtom, new Map<string, AcceptedSessionHistoryProjection>());
});

const ACCEPTED_SESSION_HISTORY_PROJECTION_LIMIT = 200;

const getProjectionKey = (
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  historyId: string
): string => JSON.stringify([workspaceId, sessionId, historyId]);

export const getAcceptedSessionHistoryProjections = (
  projections: ReadonlyMap<string, AcceptedSessionHistoryProjection>,
  workspaceId: WorkspaceId,
  sessionId: SessionId
): readonly AcceptedSessionHistoryProjection[] =>
  Array.from(projections.values()).filter(
    (projection) => projection.workspaceId === workspaceId && projection.sessionId === sessionId
  );

export const addAcceptedSessionHistoryProjection = (
  previous: ReadonlyMap<string, AcceptedSessionHistoryProjection>,
  projection: AcceptedSessionHistoryProjection
): ReadonlyMap<string, AcceptedSessionHistoryProjection> => {
  const next = new Map(previous);
  const key = getProjectionKey(projection.workspaceId, projection.sessionId, projection.entry.id);
  next.delete(key);
  next.set(key, projection);
  while (next.size > ACCEPTED_SESSION_HISTORY_PROJECTION_LIMIT) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
};

export const removeAcceptedSessionHistoryProjections = (
  previous: ReadonlyMap<string, AcceptedSessionHistoryProjection>,
  workspaceId: WorkspaceId,
  sessionId: SessionId,
  historyIds?: ReadonlySet<string>
): ReadonlyMap<string, AcceptedSessionHistoryProjection> => {
  let next: Map<string, AcceptedSessionHistoryProjection> | null = null;
  for (const [key, projection] of previous) {
    if (projection.workspaceId !== workspaceId || projection.sessionId !== sessionId) continue;
    if (historyIds && !historyIds.has(projection.entry.id)) continue;
    next ??= new Map(previous);
    next.delete(key);
  }
  return next ?? previous;
};

export const projectAcceptedSessionHistory = (
  authoritativeHistory: readonly SessionHistory[],
  projections: readonly AcceptedSessionHistoryProjection[]
): readonly SessionHistory[] => {
  const missing = projections.filter(
    (projection) => !authoritativeHistory.some((entry) => entry.id === projection.entry.id)
  );
  if (missing.length === 0) return authoritativeHistory;

  const projected = [...authoritativeHistory];
  let headInsertIndex = 0;
  for (const projection of missing) {
    if (projected.some((entry) => entry.id === projection.entry.id)) continue;
    if (projection.afterHistoryId === null) {
      projected.splice(headInsertIndex, 0, projection.entry);
      headInsertIndex += 1;
      continue;
    }
    if (projection.afterHistoryId === undefined) {
      projected.push(projection.entry);
      continue;
    }
    const anchorIndex = projected.findIndex((entry) => entry.id === projection.afterHistoryId);
    if (anchorIndex < 0) {
      projected.push(projection.entry);
      continue;
    }
    projected.splice(anchorIndex + 1, 0, projection.entry);
  }
  return projected;
};
