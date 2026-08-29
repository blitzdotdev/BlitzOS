import { createContext, useContext, useEffect, useState } from 'react';

/**
 * Context for tracking which user messages are still being synced to the server.
 * The set contains message IDs that have been written to local CRDT but not yet
 * confirmed by the server via waitUntilSynced().
 */
export const MessageSendStatusContext = createContext<ReadonlySet<string>>(new Set());

/**
 * Returns true when the message is sending AND has been sending for more than 500ms.
 * This avoids flashing a loading indicator for fast syncs.
 */
export function useIsMessageSendingVisible(messageId: string): boolean {
  const sendingIds = useContext(MessageSendStatusContext);
  const isSending = sendingIds.has(messageId);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isSending) {
      setVisible(false);
      return undefined;
    }

    const timer = setTimeout(() => setVisible(true), 500);
    return () => clearTimeout(timer);
  }, [isSending]);

  return isSending && visible;
}
