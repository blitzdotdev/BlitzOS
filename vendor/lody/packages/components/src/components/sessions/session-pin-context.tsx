import { createContext, useContext } from 'react';

export interface SessionPinContextValue {
  /** Currently pinned history entry id, or null when no message is pinned. */
  pinnedHistoryId: string | null;
  /** Pin a specific history entry. Pass `null` to clear the pin. */
  onPin: (historyId: string | null) => void;
}

export const SessionPinContext = createContext<SessionPinContextValue | null>(null);

export function useSessionPin(): SessionPinContextValue | null {
  return useContext(SessionPinContext);
}
