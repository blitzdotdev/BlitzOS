import { describe, expect, it } from 'vitest';
import { shouldMarkSessionRead } from '../src/lib/session-read-receipt';

const visibleUnread = {
  rendersConversation: true,
  isVisible: true,
  lastMessageAt: 200,
  lastReadAt: 100,
};

describe('shouldMarkSessionRead', () => {
  it('clears unread for the conversation the user is looking at', () => {
    expect(shouldMarkSessionRead(visibleUnread)).toBe(true);
  });

  it('treats a never-read session with messages as unread', () => {
    expect(shouldMarkSessionRead({ ...visibleUnread, lastReadAt: null })).toBe(true);
  });

  it('keeps a hidden sub-session unread while its parent tab is open', () => {
    // Every child tab stays mounted behind the active one; only the visible tab
    // may report a read receipt.
    expect(shouldMarkSessionRead({ ...visibleUnread, isVisible: false })).toBe(false);
  });

  it('does not report a receipt from a surface that renders no transcript', () => {
    expect(shouldMarkSessionRead({ ...visibleUnread, rendersConversation: false })).toBe(false);
  });

  it('stays read when nothing arrived after the last read', () => {
    expect(shouldMarkSessionRead({ ...visibleUnread, lastMessageAt: 100 })).toBe(false);
  });

  it('reports nothing for a session with no messages', () => {
    expect(
      shouldMarkSessionRead({ ...visibleUnread, lastMessageAt: null, lastReadAt: null })
    ).toBe(false);
  });
});
