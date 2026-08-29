import { describe, expect, it } from 'vitest';
import { getSessionTabCloseTarget } from '../src/components/sessions/session-tab-close-target';

const BASE_INPUT = {
  focusRegion: 'conversation' as const,
  sidePanelOpen: true,
  activeSidePanelTabId: 'changes',
  activeConversationTabId: 'child-session',
  parentConversationTabId: 'parent-session',
  conversationTabCount: 2,
};

describe('getSessionTabCloseTarget', () => {
  it('closes the active side-panel tab when that region has focus', () => {
    expect(
      getSessionTabCloseTarget({
        ...BASE_INPUT,
        focusRegion: 'side-panel',
      })
    ).toEqual({ kind: 'side-panel', tabId: 'changes' });
  });

  it('closes the active child conversation when the conversation region has focus', () => {
    expect(getSessionTabCloseTarget(BASE_INPUT)).toEqual({
      kind: 'conversation',
      tabId: 'child-session',
    });
  });

  it('falls back to the child conversation when the last-focused side panel is hidden', () => {
    expect(
      getSessionTabCloseTarget({
        ...BASE_INPUT,
        focusRegion: 'side-panel',
        sidePanelOpen: false,
      })
    ).toEqual({ kind: 'conversation', tabId: 'child-session' });
  });

  it('does nothing when the focused side panel is open but has no tabs', () => {
    expect(
      getSessionTabCloseTarget({
        ...BASE_INPUT,
        focusRegion: 'side-panel',
        activeSidePanelTabId: null,
      })
    ).toBeNull();
  });

  it('does not close the parent conversation tab', () => {
    expect(
      getSessionTabCloseTarget({
        ...BASE_INPUT,
        activeConversationTabId: 'parent-session',
      })
    ).toBeNull();
  });

  it('returns to the chat landing when the parent is the only conversation tab', () => {
    expect(
      getSessionTabCloseTarget({
        ...BASE_INPUT,
        activeConversationTabId: 'parent-session',
        conversationTabCount: 1,
      })
    ).toEqual({ kind: 'landing' });
  });
});
