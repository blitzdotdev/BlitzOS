export type SessionTabFocusRegion = 'conversation' | 'side-panel';

export type SessionTabCloseTarget =
  | { kind: 'conversation'; tabId: string }
  | { kind: 'side-panel'; tabId: string }
  | { kind: 'landing' };

export function getSessionTabCloseTarget({
  focusRegion,
  sidePanelOpen,
  activeSidePanelTabId,
  activeConversationTabId,
  parentConversationTabId,
  conversationTabCount,
}: {
  focusRegion: SessionTabFocusRegion;
  sidePanelOpen: boolean;
  activeSidePanelTabId: string | null;
  activeConversationTabId: string;
  parentConversationTabId: string;
  conversationTabCount: number;
}): SessionTabCloseTarget | null {
  if (focusRegion === 'side-panel' && sidePanelOpen) {
    return activeSidePanelTabId ? { kind: 'side-panel', tabId: activeSidePanelTabId } : null;
  }
  if (activeConversationTabId !== parentConversationTabId) {
    return { kind: 'conversation', tabId: activeConversationTabId };
  }
  if (conversationTabCount === 1) {
    return { kind: 'landing' };
  }
  return null;
}
