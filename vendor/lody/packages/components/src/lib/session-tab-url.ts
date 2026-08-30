const SESSION_TAB_SEARCH_PREFIX = 'session:';

export type ParsedSessionTabSearch =
  | { kind: 'missing' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'invalid' };

export type SessionTabUrlSyncAction =
  | { kind: 'noop' }
  | { kind: 'activate-parent' }
  | { kind: 'activate-session'; sessionId: string };

export const parseSessionTabSearch = (tab: string | undefined): ParsedSessionTabSearch => {
  if (tab === undefined) {
    return { kind: 'missing' };
  }

  const normalized = tab.trim();
  if (!normalized.startsWith(SESSION_TAB_SEARCH_PREFIX)) {
    return { kind: 'invalid' };
  }

  const sessionId = normalized.slice(SESSION_TAB_SEARCH_PREFIX.length).trim();
  if (!sessionId) {
    return { kind: 'invalid' };
  }

  return { kind: 'session', sessionId };
};

export const formatSessionTabSearch = (
  tabSessionId: string,
  parentSessionId: string
): string | undefined => {
  if (!tabSessionId || tabSessionId === parentSessionId) {
    return undefined;
  }

  return `${SESSION_TAB_SEARCH_PREFIX}${tabSessionId}`;
};

export const getSessionTabUrlSyncAction = (
  parsedTab: ParsedSessionTabSearch,
  options?: { ignoreMissing?: boolean }
): SessionTabUrlSyncAction => {
  if (parsedTab.kind === 'session') {
    return { kind: 'activate-session', sessionId: parsedTab.sessionId };
  }

  if (parsedTab.kind === 'missing' && options?.ignoreMissing) {
    return { kind: 'noop' };
  }

  return { kind: 'activate-parent' };
};
