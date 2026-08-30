import type { BrowserAddress, SessionId } from '@lody/shared';

import { LRUCache } from '@/lib/lru-cache';

export type SessionBrowserNavigationHistory = {
  entries: string[];
  index: number;
};

export type SessionBrowserResumeState = {
  currentAddress: BrowserAddress;
  history: SessionBrowserNavigationHistory;
};

const MAX_RESUMABLE_BROWSER_SESSIONS = 50;
const resumeStateBySessionId = new LRUCache<SessionId, SessionBrowserResumeState>(
  MAX_RESUMABLE_BROWSER_SESSIONS
);

const cloneResumeState = (state: SessionBrowserResumeState): SessionBrowserResumeState => ({
  currentAddress: {
    ...state.currentAddress,
    ...(state.currentAddress.target ? { target: { ...state.currentAddress.target } } : {}),
  },
  history: {
    entries: [...state.history.entries],
    index: state.history.index,
  },
});

export const readSessionBrowserResumeState = (
  sessionId: SessionId
): SessionBrowserResumeState | null => {
  const state = resumeStateBySessionId.get(sessionId);
  return state ? cloneResumeState(state) : null;
};

export const rememberSessionBrowserResumeState = (
  sessionId: SessionId,
  state: SessionBrowserResumeState
): void => {
  resumeStateBySessionId.set(sessionId, cloneResumeState(state));
};

export const clearSessionBrowserResumeState = (sessionId: SessionId): void => {
  resumeStateBySessionId.delete(sessionId);
};
