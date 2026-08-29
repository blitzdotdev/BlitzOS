import type { SessionId, SessionMeta } from '@lody/shared';
import { formatSessionTabSearch } from './session-tab-url';

/** A routable Session plus the exact child Tab that should be restored. */
export type SessionNavigationTarget = {
  sessionId: SessionId;
  tabSessionId?: SessionId;
};

/** The route params/search needed to restore a Session navigation target. */
export const getSessionNavigationLocation = (
  target: SessionNavigationTarget
): { sessionId: SessionId; tab?: string } => ({
  sessionId: target.sessionId,
  tab: formatSessionTabSearch(target.tabSessionId ?? target.sessionId, target.sessionId),
});

/**
 * Resolve an opened Session's reverse link. New metadata carries the root
 * explicitly; the opener's `parentSessionId` keeps pre-existing data working.
 */
export const resolveOpenedByNavigationTarget = (
  session: Pick<SessionMeta, 'openedBySessionId' | 'openedByRootSessionId'>,
  openerSession?: Pick<SessionMeta, 'parentSessionId'> | null
): SessionNavigationTarget | null => {
  const tabSessionId = session.openedBySessionId;
  if (!tabSessionId) return null;

  const sessionId =
    session.openedByRootSessionId ?? openerSession?.parentSessionId ?? tabSessionId;
  return sessionId === tabSessionId ? { sessionId } : { sessionId, tabSessionId };
};
