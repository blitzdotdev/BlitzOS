import { describe, expect, it } from 'vitest';
import {
  getLoroStreamIdForDocId,
  getSessionIdFromRoomId,
  isSessionDocRoomId,
  type WorkspaceId,
} from '../src';

describe('Session room ids', () => {
  it('recognizes current Session rooms', () => {
    expect(isSessionDocRoomId('session-abc')).toBe(true);
    expect(getSessionIdFromRoomId('session-abc')).toBe('abc');
  });

  it('keeps removed Session comment rooms out of the Session namespace', () => {
    expect(isSessionDocRoomId('session-comment-abc')).toBe(false);
    expect(getSessionIdFromRoomId('session-comment-abc')).toBeNull();
    expect(getLoroStreamIdForDocId('workspace' as WorkspaceId, 'session-comment-abc')).toBe(
      'session-comment-abc'
    );
  });

  it('rejects an empty Session id', () => {
    expect(isSessionDocRoomId('session-')).toBe(false);
    expect(getSessionIdFromRoomId('session-')).toBeNull();
  });
});
